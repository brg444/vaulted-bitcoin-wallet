import {
  ArkAddress,
  CSVMultisigTapscript,
  Intent,
  RestArkProvider,
  SingleKey,
  Transaction,
  type ArkProvider,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { describe, expect, it, vi } from 'vitest'
// Recovery graph persistence has its own corruption/storage tests. These cases
// exercise exact payment orchestration with a successful durable boundary.
vi.mock('../recovery/finalization', () => ({ retainFinalizationRecovery: vi.fn().mockResolvedValue(undefined) }))
import { retainFinalizationRecovery } from '../recovery/finalization'
import { POLICY_VERSION } from '../constants'
import { networkPins } from '../networkPins'
import { SAVINGS_TEMPLATE } from '../program/constants'
import type { VaultStatus } from '../types'
import golden from './testdata/vault-policy-v1-tree.json'
import {
  validateSpendingRecoveryJournal,
  exportSpendingRecoveryJournal,
  restoreSpendingRecoveryJournal,
  vtxoSpendJournalKey,
  abortPersistedVtxoSpend,
  applyVtxoOperationView,
  advanceAuthorizedVtxoSpend,
  buildReservedVtxoSpend,
  buildPersistedVtxoSdkBundle,
  clearPersistedVtxoSpend,
  createVaultSdkOperationValidation,
  createVtxoOperationId,
  createVtxoSpendUnlocker,
  createPhoneSignedPendingProof,
  isVtxoLivePendingError,
  isVtxoReceiptPendingError,
  isVtxoReservedReplaceError,
  laterVtxoSpendStage,
  listPersistedVtxoSpends,
  loadPersistedVtxoSpend,
  loadPersistedVtxoSpendById,
  matchPendingOperatorSubmission,
  matchOperatorSignedCheckpoints,
  orderAuthorizedCheckpoints,
  isSameVtxoPayment,
  pendingVtxoSpendBlocksNewSend,
  vtxoJournalSendAction,
  vtxoNewSendAction,
  persistVtxoSpend,
  persistVtxoReserveSignature,
  preReserveVtxoSpend,
  previewVaultVtxoSend,
  reconcilePersistedVtxoSpend,
  requireReviewedVtxoReservation,
  requireAuthorizedPendingProof,
  requireOperatorSignedCheckpoint,
  requireUserSignedArkInputs,
  VtxoLivePendingError,
  VtxoReceiptPendingError,
  VtxoSpendInFlightError,
  VtxoReviewedReservationError,
  VtxoSpendUnresolvedError,
  VTXO_GET_PENDING_MESSAGE,
  type PersistedVtxoSpend,
  type VaultVtxoSpendQuote,
  type VtxoOperationView,
  type VtxoReserveResponse,
  vaultArkServer,
  vaultPolicyV1ScriptFromStatus,
  vtxoReserveRequest,
  sendVaultVtxo,
} from './spend'
import { vaultCosignerClient } from '../cosignerClient'
import { arkadeIntentFeePolicyDigest } from './feePolicy'
import { VaultPolicyV1Script } from './script'
import type { SubmitExactVaultSdkOperationParams } from './sdkOperationAdapter'

const sdkOperationAdapterMocks = vi.hoisted(() => ({
  submit: vi.fn(),
}))

vi.mock('./sdkOperationAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkOperationAdapter')>()),
  submitExactVaultSdkOperation: sdkOperationAdapterMocks.submit,
}))

// PSBT map ordering is not part of the transaction or signature. The Go
// Guardian and the SDK serialize the same fields in different orders.
function reversePsbtMapOrder(raw: string): string {
  const bytes = base64.decode(raw)
  let offset = 5 // psbt magic
  const result = [...bytes.slice(0, offset)]
  const readSize = () => {
    const prefix = bytes[offset++]
    if (prefix < 253) return prefix
    const width = prefix === 253 ? 2 : prefix === 254 ? 4 : 8
    let value = 0
    for (let i = 0; i < width; i++) value += bytes[offset++] * 256 ** i
    return value
  }
  while (offset < bytes.length) {
    const entries: Uint8Array[] = []
    while (true) {
      const start = offset
      const keySize = readSize()
      if (keySize === 0) break
      offset += keySize
      const valueSize = readSize()
      offset += valueSize
      entries.push(bytes.slice(start, offset))
    }
    for (const entry of entries.reverse()) result.push(...entry)
    result.push(0)
  }
  return base64.encode(Uint8Array.from(result))
}

const TB1Q = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const OP_1 = '11'.repeat(16)
const OP_2 = '22'.repeat(16)
const FEE_POLICY_DIGEST = 'aa'.repeat(32)
const RECONCILE_FEE_POLICY = {
  offchainInput: '5.0',
  offchainOutput: 'amount * 0.001',
  onchainInput: '7.0',
  onchainOutput: 'amount * 0.002',
} as const
const RESERVATION_FACTS = {
  feePolicyDigest: FEE_POLICY_DIGEST,
  feeSats: 500,
  changeSats: 7_500,
  changeVout: 1,
} as const

function compressed(xonly: string): string {
  return `02${xonly}`
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((byte, byteIndex) => byte === haystack[index + byteIndex])) return index
  }
  return -1
}

function status(): VaultStatus {
  const script = new VaultPolicyV1Script({
    userPub: hex.decode(golden.fixtures.userPub),
    vtxoVaultCosignerPub: hex.decode(golden.fixtures.vtxoVaultCosignerPub),
    arkdServerPub: hex.decode(golden.fixtures.arkdServerPub),
    delegatePub: hex.decode(golden.fixtures.delegatePub),
    exitDelay: 4608n,
    exitDelayUnit: 'seconds',
    exitDevicePub: hex.decode(golden.fixtures.userPub),
    exitHardwarePub: hex.decode(golden.fixtures.exitHardwarePub),
  })
  const address = new ArkAddress(hex.decode(golden.fixtures.arkdServerPub), script.tweakedPublicKey, 'tark')
  return {
    enrolled: true,
    network: 'mutinynet',
    clientOrigin: 'https://vault.test',
    rpId: 'vault.test',
    vaultId: 'vault-a',
    templateVersion: SAVINGS_TEMPLATE,
    policyVersion: POLICY_VERSION,
    protectionTier: 'standard',
    savingsAddress: '',
    savingsScript: '',
    periodAllowance: 100_000,
    periodSpent: 0,
    periodRemaining: 100_000,
    txCap: 50_000,
    absoluteFeeCap: 5_000,
    feerateCapSatVb: 10,
    phoneBip340Pub: compressed(golden.fixtures.userPub),
    phoneDirectP256: compressed(golden.fixtures.exitDevicePub),
    externalOwnerWalletPub: compressed(golden.fixtures.exitHardwarePub),
    vtxoVaultCosignerPub: compressed(golden.fixtures.vtxoVaultCosignerPub),
    vtxoDelegatePub: compressed(golden.fixtures.delegatePub),
    vtxoExitDelay: 4608,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: address.encode(),
    spendingArkScript: hex.encode(script.pkScript),
  }
}

function reserve(): VtxoReserveResponse {
  const current = status()
  return {
    operationId: OP_1,
    bundleDigest: '11'.repeat(32),
    reservationExpires: '2026-08-20T00:00:00Z',
    inputs: [{ txid: '22'.repeat(32), vout: 3, valueSats: 20_000, scriptHex: current.spendingArkScript! }],
    changeAddress: current.spendingArkAddress!,
    changeScript: current.spendingArkScript!,
    changeSats: 7_500,
    changeVout: 1,
    destScript: `5120${golden.fixtures.exitHardwarePub}`,
    feeSats: 500,
    feePolicyDigest: FEE_POLICY_DIGEST,
    checkpointTapscript: networkPins('mutinynet').checkpointTapscript,
  }
}

function fragmentedReserve(): VtxoReserveResponse {
  const current = reserve()
  current.inputs = [
    { ...current.inputs[0], txid: '11'.repeat(32), vout: 1, valueSats: 7_000 },
    { ...current.inputs[0], txid: '22'.repeat(32), vout: 3, valueSats: 13_000 },
  ]
  return current
}

function destination(): string {
  return new ArkAddress(
    hex.decode(golden.fixtures.arkdServerPub),
    hex.decode(golden.fixtures.exitHardwarePub),
    'tark',
  ).encode()
}

function reviewedPending(reservationExpires = '2099-08-20T00:02:00Z'): PersistedVtxoSpend {
  return {
    vaultId: 'vault-a',
    operationId: OP_1,
    bundleDigest: '11'.repeat(32),
    destAddress: destination(),
    amountSats: 12_000,
    arkTxid: 'aa'.repeat(32),
    reservationExpires,
    ...RESERVATION_FACTS,
    stage: 'reserved',
    unsignedArkPsbt: 'cHNidP9ark',
    unsignedCheckpointPsbts: ['cHNidP9cp'],
  }
}

function sdkReservedPending(): PersistedVtxoSpend {
  const current = status()
  const reservation = fragmentedReserve()
  const built = buildReservedVtxoSpend(current, reservation, 12_000, destination(), FEE_POLICY_DIGEST)
  return {
    vaultId: 'vault-a',
    operationId: OP_1,
    bundleDigest: '11'.repeat(32),
    destAddress: destination(),
    amountSats: 12_000,
    arkTxid: built.arkTx.id,
    reservationExpires: '2099-08-20T00:02:00Z',
    checkpointTapscript: reservation.checkpointTapscript,
    ...RESERVATION_FACTS,
    stage: 'reserved',
    unsignedArkPsbt: base64.encode(built.arkTx.toPSBT()),
    unsignedCheckpointPsbts: built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    sdkBundleVersion: 1,
    reservedInputs: reservation.inputs.map((input) => ({ ...input })),
    reservedOutputs: [
      { scriptHex: reservation.destScript, amountSats: 12_000 },
      { scriptHex: reservation.changeScript, amountSats: reservation.changeSats },
    ],
  }
}

function reviewedQuote(pending = reviewedPending()): VaultVtxoSpendQuote {
  return {
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    destAddress: pending.destAddress,
    amountSats: pending.amountSats,
    feeSats: pending.feeSats!,
    feePolicyDigest: pending.feePolicyDigest!,
    reservationExpires: pending.reservationExpires!,
    changeSats: pending.changeSats!,
    ...(pending.changeVout === undefined ? {} : { changeVout: pending.changeVout }),
  }
}

function reviewedOperation(pending = reviewedPending(), overrides: Partial<VtxoOperationView> = {}): VtxoOperationView {
  return {
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    state: 'reserved',
    arkTxid: pending.arkTxid,
    expiresAt: pending.reservationExpires,
    feeSats: pending.feeSats,
    feePolicyDigest: pending.feePolicyDigest,
    changeSats: pending.changeSats,
    changeVout: pending.changeVout,
    ...overrides,
  }
}

function installImmediateNavigatorLock(): () => void {
  const original = navigator.locks
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({}),
    },
  })
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', { configurable: true, value: original })
    else Reflect.deleteProperty(navigator, 'locks')
  }
}

function stubPasskeyUnlocker(): typeof createVtxoSpendUnlocker {
  return (enrollment, current, digestHex) =>
    createVtxoSpendUnlocker(enrollment, current, digestHex, async () => ({
      assertion: {
        credentialId: 'aa',
        clientDataJSON: 'bb',
        authenticatorData: 'cc',
        signature: 'dd',
      },
      phoneSecret: new Uint8Array(32).fill(1),
      scalar: new Uint8Array(32).fill(2),
    }))
}

function currentOperatorInfo(pending: PersistedVtxoSpend) {
  return {
    network: 'mutinynet',
    signerPubkey: golden.fixtures.arkdServerPub,
    checkpointTapscript: pending.checkpointTapscript,
    fees: { intentFee: RECONCILE_FEE_POLICY, txFeeRate: '0' },
  } as never
}

function freshPolicyPending(pending = sdkReservedPending()): PersistedVtxoSpend {
  return {
    ...pending,
    feePolicyDigest: arkadeIntentFeePolicyDigest(RECONCILE_FEE_POLICY),
  }
}

function validCheckpointPsbt(): string {
  const checkpoint = buildReservedVtxoSpend(status(), reserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    .checkpoints[0]
  return base64.encode(checkpoint.toPSBT())
}

async function authorizedPendingFixture() {
  const current = status()
  const reservation = fragmentedReserve()
  const built = buildReservedVtxoSpend(current, reservation, 12_000, destination(), FEE_POLICY_DIGEST)
  const phone = SingleKey.fromPrivateKey(hex.decode('01'.padStart(64, '0')))
  const vault = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
  const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
  const unsignedCheckpointPsbts = built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()))
  const phoneProof = await createPhoneSignedPendingProof(
    unsignedCheckpointPsbts,
    phone,
    hex.decode(golden.fixtures.userPub),
  )
  const authorizedPendingProof = base64.encode(
    (await vault.sign(Transaction.fromPSBT(base64.decode(phoneProof)))).toPSBT(),
  )
  const phoneArk = await phone.sign(built.arkTx)
  const authorizedArk = await vault.sign(phoneArk)
  const finalArk = await operator.sign(authorizedArk)
  const operatorCheckpoints = await Promise.all(built.checkpoints.map((checkpoint) => operator.sign(checkpoint)))
  const pending: PersistedVtxoSpend = {
    vaultId: 'vault-a',
    operationId: OP_1,
    bundleDigest: '11'.repeat(32),
    destAddress: destination(),
    amountSats: 12_000,
    arkTxid: built.arkTx.id,
    checkpointTapscript: reservation.checkpointTapscript,
    ...RESERVATION_FACTS,
    stage: 'authorized',
    unsignedArkPsbt: base64.encode(phoneArk.toPSBT()),
    authorizedPsbt: base64.encode(authorizedArk.toPSBT()),
    authorizedPendingProof,
    unsignedCheckpointPsbts,
  }
  return {
    current,
    built,
    phone,
    vault,
    phoneArk,
    authorizedArk,
    finalArk,
    operatorCheckpoints,
    pending,
    phoneProof,
    authorizedPendingProof,
    operator,
    operatorPub: hex.decode(golden.fixtures.arkdServerPub),
    candidate: {
      arkTxid: built.arkTx.id,
      finalArkTx: base64.encode(finalArk.toPSBT()),
      signedCheckpointTxs: operatorCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    },
  }
}

describe('regular VTXO spend coordinator', () => {
  it('uses the release-pinned public Operator directly', () => {
    expect(vaultArkServer()).toBe('https://mutinynet.arkade.sh')
    expect(vaultArkServer('mutinynet')).toBe('https://mutinynet.arkade.sh')
    expect(vaultArkServer('mainnet')).toBe('https://arkade.computer')
  })

  it.each([
    ['operation id', { operationId: OP_2 }],
    ['bundle digest', { bundleDigest: '22'.repeat(32) }],
    ['authoritative fee', { feeSats: 501 }],
    ['fee policy', { feePolicyDigest: 'bb'.repeat(32) }],
    ['expiry', { expiresAt: '2099-08-20T00:03:00Z' }],
  ] as const)('rejects a reviewed reservation when the server changes its %s', (_label, changed) => {
    const pending = reviewedPending()
    expect(() =>
      requireReviewedVtxoReservation(pending, reviewedOperation(pending, changed), reviewedQuote(pending)),
    ).toThrow(VtxoReviewedReservationError)
  })

  it('rejects an aborted or expired reviewed reservation before approval', () => {
    const aborted = reviewedPending()
    expect(() =>
      requireReviewedVtxoReservation(aborted, reviewedOperation(aborted, { state: 'aborted' }), reviewedQuote(aborted)),
    ).toThrow(VtxoReviewedReservationError)

    const expired = reviewedPending('2026-08-20T00:02:00Z')
    expect(() =>
      requireReviewedVtxoReservation(
        expired,
        reviewedOperation(expired),
        reviewedQuote(expired),
        Date.parse('2026-08-20T00:02:01Z'),
      ),
    ).toThrow(VtxoReviewedReservationError)
  })

  it('allows the exact reviewed operation to resume after a lost authorization response', () => {
    const pending = reviewedPending('2026-08-20T00:02:00Z')
    expect(
      requireReviewedVtxoReservation(
        pending,
        reviewedOperation(pending, { state: 'signed' }),
        reviewedQuote(pending),
        Date.parse('2026-08-20T00:02:01Z'),
      ),
    ).toBe(pending)
  })

  it.each([
    [
      'aborted',
      (pending: PersistedVtxoSpend) =>
        new Response(JSON.stringify(reviewedOperation(pending, { state: 'aborted' })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ],
    [
      'expired',
      (pending: PersistedVtxoSpend) =>
        new Response(JSON.stringify(reviewedOperation(pending)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ],
    [
      'changed fee',
      (pending: PersistedVtxoSpend) =>
        new Response(JSON.stringify(reviewedOperation(pending, { feeSats: 501 })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ],
    [
      'missing operation',
      (pending: PersistedVtxoSpend) =>
        new Response(JSON.stringify({ error: pending.operationId ? 'operation not found' : 'invalid operation' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    ],
  ] as const)('does not reserve again or request a passkey for a %s review', async (kind, response) => {
    const pending = reviewedPending(kind === 'expired' ? '2020-08-20T00:02:00Z' : undefined)
    persistVtxoSpend(pending)
    const originalLocks = navigator.locks
    const originalCredentials = navigator.credentials
    const getCredential = vi.fn()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
          callback({}),
      },
    })
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: getCredential },
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(pending))

    try {
      if (kind === 'expired') {
        await expect(sendVaultVtxo({} as never, status(), reviewedQuote(pending))).rejects.toBeInstanceOf(
          VtxoReviewedReservationError,
        )
        expect(fetch).not.toHaveBeenCalled()
      } else {
        await expect(sendVaultVtxo({} as never, status(), reviewedQuote(pending))).rejects.toThrow(/deployment RP ID/)
        expect(fetch).not.toHaveBeenCalled()
      }
      expect(getCredential).not.toHaveBeenCalled()
    } finally {
      clearPersistedVtxoSpend('vault-a')
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
      if (originalCredentials) {
        Object.defineProperty(navigator, 'credentials', { configurable: true, value: originalCredentials })
      } else {
        Reflect.deleteProperty(navigator, 'credentials')
      }
    }
  })

  it('requests Face ID before talking to the vault or Operator', async () => {
    const pending = freshPolicyPending()
    persistVtxoSpend(pending)
    const restoreLock = installImmediateNavigatorLock()
    const originalCredentials = navigator.credentials
    const fetch = vi.spyOn(globalThis, 'fetch')
    const getCredential = vi.fn(async () => {
      expect(fetch).not.toHaveBeenCalled()
      return null
    })
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: getCredential },
    })
    const current = {
      ...status(),
      rpId: window.location.hostname,
      clientOrigin: window.location.origin,
    }

    try {
      await expect(
        sendVaultVtxo(
          {
            credId: 'aa'.repeat(32),
            nonce: 'bb'.repeat(12),
            ciphertext: 'cc',
            phoneBip340Pub: '',
            phoneDirectP256: '',
          } as never,
          current,
          reviewedQuote(pending),
        ),
      ).rejects.toThrow(/The operation was aborted/)
      expect(getCredential).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
      if (originalCredentials) {
        Object.defineProperty(navigator, 'credentials', { configurable: true, value: originalCredentials })
      } else {
        Reflect.deleteProperty(navigator, 'credentials')
      }
    }
  })

  it.each([
    [false, false],
    [false, true],
    [true, true],
  ])(
    'completes the real SDK lifecycle with signatures, interrupted=%s, reordered Guardian fields=%s',
    async (interrupted, reordered) => {
      const actual = await vi.importActual<typeof import('./sdkOperationAdapter')>('./sdkOperationAdapter')
      sdkOperationAdapterMocks.submit.mockImplementation(actual.submitExactVaultSdkOperation)
      const pending = freshPolicyPending()
      persistVtxoSpend(pending)
      const restoreLock = installImmediateNavigatorLock()
      const vault = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
      const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
      const phoneSecret = hex.decode('01'.padStart(64, '0'))
      const unlock = vi.fn(async () => ({
        assertion: { credentialId: 'aa', clientDataJSON: 'bb', authenticatorData: 'cc', signature: 'dd' },
        phoneSecret,
        scalar: hex.decode('03'.padStart(64, '0')),
      }))
      const unlocker = createVtxoSpendUnlocker({} as never, status(), pending.bundleDigest, unlock)
      vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(pending))
      vi.spyOn(vaultCosignerClient.spending, 'operation').mockResolvedValue(reviewedOperation(pending) as never)
      vi.spyOn(vaultCosignerClient.spending, 'authorize').mockImplementation(async (request) => {
        const canonical = base64.encode(
          (await vault.sign(Transaction.fromPSBT(base64.decode(request.unsignedArkPsbt)))).toPSBT(),
        )
        const authorizedPsbt = reordered ? reversePsbtMapOrder(canonical) : canonical
        if (reordered) {
          expect(authorizedPsbt).not.toBe(canonical)
          expect(base64.encode(Transaction.fromPSBT(base64.decode(authorizedPsbt)).toPSBT())).toBe(canonical)
        }
        return {
          operationId: pending.operationId,
          bundleDigest: pending.bundleDigest,
          arkTxid: pending.arkTxid,
          authorizedPsbt,
          authorizedPendingProof: base64.encode(
            (await vault.sign(Transaction.fromPSBT(base64.decode(request.pendingProof)))).toPSBT(),
          ),
        }
      })
      const submit = vi.spyOn(RestArkProvider.prototype, 'submitTx').mockImplementation(async (ark, checkpoints) => ({
        arkTxid: pending.arkTxid,
        finalArkTx: base64.encode((await operator.sign(Transaction.fromPSBT(base64.decode(ark)))).toPSBT()),
        signedCheckpointTxs: await Promise.all(
          checkpoints.map(async (raw) =>
            base64.encode((await operator.sign(Transaction.fromPSBT(base64.decode(raw)))).toPSBT()),
          ),
        ),
      }))
      const authorizeCheckpoints = vi
        .spyOn(vaultCosignerClient.spending, 'authorizeCheckpoints')
        .mockImplementation(async (request) => ({
          operationId: pending.operationId,
          bundleDigest: pending.bundleDigest,
          arkTxid: pending.arkTxid,
          checkpointPsbts: await Promise.all(
            request.checkpointPsbts.map(async (raw) =>
              base64.encode((await vault.sign(Transaction.fromPSBT(base64.decode(raw)))).toPSBT()),
            ),
          ),
        }))
      const finalize = vi.spyOn(RestArkProvider.prototype, 'finalizeTx').mockResolvedValue(undefined)
      vi.spyOn(vaultCosignerClient.spending, 'finalize').mockResolvedValue({
        operationId: pending.operationId,
        bundleDigest: pending.bundleDigest,
        arkTxid: pending.arkTxid,
        state: 'finalized',
      })
      try {
        if (interrupted) {
          authorizeCheckpoints.mockRejectedValueOnce(new Error('checkpoint response lost'))
          await expect(sendVaultVtxo({} as never, status(), reviewedQuote(pending), () => unlocker)).rejects.toThrow(
            'checkpoint response lost',
          )
          expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('operator-submitted')
          expect(phoneSecret.every((byte) => byte === 0)).toBe(true)
          phoneSecret.set(hex.decode('01'.padStart(64, '0')))
        }
        await expect(
          sendVaultVtxo({} as never, status(), reviewedQuote(pending), () => unlocker),
        ).resolves.toMatchObject({ txid: pending.arkTxid })
        expect(unlock).toHaveBeenCalledTimes(interrupted ? 2 : 1)
        expect(submit).toHaveBeenCalledTimes(1)
        expect(authorizeCheckpoints).toHaveBeenCalledTimes(interrupted ? 2 : 1)
        expect(finalize).toHaveBeenCalledTimes(1)
        expect(phoneSecret.every((byte) => byte === 0)).toBe(true)
        expect(loadPersistedVtxoSpend('vault-a')).toBeUndefined()
      } finally {
        restoreLock()
        clearPersistedVtxoSpend('vault-a')
      }
    },
  )

  it.each([false, true])(
    'gates fresh SDK finalization on durable recovery evidence, storage failure=%s',
    async (storageFailure) => {
      sdkOperationAdapterMocks.submit.mockReset()
      clearPersistedVtxoSpend('vault-a')
      const pending = freshPolicyPending()
      persistVtxoSpend(pending)
      const restoreLock = installImmediateNavigatorLock()
      const finalizeTx = vi.spyOn(RestArkProvider.prototype, 'finalizeTx').mockResolvedValue(undefined)
      vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(pending))
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes('/v1/vtxo/operation')) {
          return new Response(JSON.stringify(reviewedOperation(pending)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.includes('/v1/vtxo/finalize')) {
          return new Response(
            JSON.stringify({
              operationId: pending.operationId,
              bundleDigest: pending.bundleDigest,
              state: 'finalized',
              arkTxid: pending.arkTxid,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        throw new Error(`unexpected request: ${url}`)
      })
      sdkOperationAdapterMocks.submit.mockImplementation(async (params: SubmitExactVaultSdkOperationParams) => {
        expect(params.inputs.map(({ txid, vout, value }) => ({ txid, vout, value }))).toEqual(
          pending.reservedInputs!.map(({ txid, vout, valueSats }) => ({ txid, vout, value: valueSats })),
        )
        expect(params.outputs.map(({ script, amount }) => ({ script: hex.encode(script!), amount }))).toEqual(
          pending.reservedOutputs!.map(({ scriptHex, amountSats }) => ({
            script: scriptHex,
            amount: BigInt(amountSats),
          })),
        )
        await params.callbacks.finalize({
          arkTxid: pending.arkTxid,
          authorizedCheckpointPsbts: pending.unsignedCheckpointPsbts!,
          signal: new AbortController().signal,
        })
        return pending.arkTxid
      })

      try {
        if (storageFailure) {
          vi.mocked(retainFinalizationRecovery).mockRejectedValueOnce(new Error('Recovery storage unavailable'))
          await expect(
            sendVaultVtxo({} as never, status(), reviewedQuote(pending), stubPasskeyUnlocker()),
          ).rejects.toThrow('Recovery storage unavailable')
          expect(finalizeTx).not.toHaveBeenCalled()
          expect(loadPersistedVtxoSpend('vault-a')).toBeDefined()
          return
        }
        await expect(
          sendVaultVtxo({} as never, status(), reviewedQuote(pending), stubPasskeyUnlocker()),
        ).resolves.toEqual({
          txid: pending.arkTxid,
          operationId: pending.operationId,
          feeSats: pending.feeSats,
        })
        expect(sdkOperationAdapterMocks.submit).toHaveBeenCalledTimes(1)
        expect(finalizeTx).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(loadPersistedVtxoSpend('vault-a')).toBeUndefined()
      } finally {
        clearPersistedVtxoSpend('vault-a')
        restoreLock()
      }
    },
  )

  it('unlocks the passkey once and reuses it for Ark authorization and checkpoint signing', async () => {
    const phoneSecret = new Uint8Array(32).fill(7)
    const scalar = new Uint8Array(32).fill(8)
    const unlockPasskey = vi.fn(async () => ({
      assertion: {
        credentialId: 'aa',
        clientDataJSON: 'bb',
        authenticatorData: 'cc',
        signature: 'dd',
      },
      phoneSecret,
      scalar,
    }))
    const unlocker = createVtxoSpendUnlocker({} as never, status(), '11'.repeat(32), unlockPasskey)

    const first = await unlocker.unlock()
    const second = await unlocker.unlock()
    expect(unlockPasskey).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(first.phoneSecret).toBe(phoneSecret)
    expect([...phoneSecret]).toEqual(Array(32).fill(7))

    unlocker.dispose()
    unlocker.dispose()
    expect(unlockPasskey).toHaveBeenCalledTimes(1)
    expect([...phoneSecret]).toEqual(Array(32).fill(0))
    expect([...scalar]).toEqual(Array(32).fill(0))
  })

  it('requires the SDK callback bundle to be byte-identical to the persisted reservation before Face ID', async () => {
    sdkOperationAdapterMocks.submit.mockReset()
    clearPersistedVtxoSpend('vault-a')
    const pending = freshPolicyPending()
    persistVtxoSpend(pending)
    const restoreLock = installImmediateNavigatorLock()
    const originalCredentials = navigator.credentials
    const getCredential = vi.fn()
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: getCredential },
    })
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(pending))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(reviewedOperation(pending)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    sdkOperationAdapterMocks.submit.mockImplementation(async (params: SubmitExactVaultSdkOperationParams) =>
      params.callbacks.authorizeArk({
        unsignedArkPsbt: `${pending.unsignedArkPsbt}A`,
        unsignedCheckpointPsbts: pending.unsignedCheckpointPsbts!,
        signal: new AbortController().signal,
      }),
    )

    try {
      await expect(sendVaultVtxo({} as never, status(), reviewedQuote(pending), stubPasskeyUnlocker())).rejects.toThrow(
        /different reserved transaction bundle/,
      )
      expect(sdkOperationAdapterMocks.submit).toHaveBeenCalledTimes(1)
      expect(getCredential).not.toHaveBeenCalled()
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('reserved')
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
      if (originalCredentials) {
        Object.defineProperty(navigator, 'credentials', { configurable: true, value: originalCredentials })
      } else {
        Reflect.deleteProperty(navigator, 'credentials')
      }
    }
  })

  it('fails closed before SDK submission when the Operator omits its checkpoint tapscript', async () => {
    sdkOperationAdapterMocks.submit.mockReset()
    clearPersistedVtxoSpend('vault-a')
    const pending = freshPolicyPending()
    persistVtxoSpend(pending)
    const restoreLock = installImmediateNavigatorLock()
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(
      Object.assign({}, currentOperatorInfo(pending), { checkpointTapscript: undefined }) as never,
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(reviewedOperation(pending)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    try {
      await expect(sendVaultVtxo({} as never, status(), reviewedQuote(pending), stubPasskeyUnlocker())).rejects.toThrow(
        /Operator checkpoint tapscript is missing/,
      )
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('reserved')
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
    }
  })

  it('resumes a lost fresh authorize response through the durable Operator path without rebuilding the spend', async () => {
    sdkOperationAdapterMocks.submit.mockReset()
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    const pending = freshPolicyPending()
    persistVtxoSpend(pending)
    const restoreLock = installImmediateNavigatorLock()
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(pending))
    const submit = vi.spyOn(RestArkProvider.prototype, 'submitTx').mockResolvedValue(fixture.candidate)
    const getPending = vi.spyOn(RestArkProvider.prototype, 'getPendingTxs')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          reviewedOperation(pending, {
            state: 'signed',
            authorizedPsbt: fixture.pending.authorizedPsbt,
            authorizedPendingProof: fixture.pending.authorizedPendingProof,
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    try {
      await expect(sendVaultVtxo({} as never, fixture.current, reviewedQuote(pending))).rejects.toThrow(
        /deployment RP ID/,
      )
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
      expect(getPending).not.toHaveBeenCalled()
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('reserved')
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
    }
  })

  it('resumes operator-submitted and checkpoints-authorized v1 records without entering the fresh adapter', async () => {
    sdkOperationAdapterMocks.submit.mockReset()
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    const fresh = freshPolicyPending()
    const restoreLock = installImmediateNavigatorLock()
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(fresh))
    const submit = vi.spyOn(RestArkProvider.prototype, 'submitTx')
    const getPending = vi.spyOn(RestArkProvider.prototype, 'getPendingTxs')
    const finalize = vi.spyOn(RestArkProvider.prototype, 'finalizeTx').mockRejectedValue(new Error('offline'))

    const operatorSubmitted: PersistedVtxoSpend = {
      ...fresh,
      stage: 'operator-submitted',
      unsignedArkPsbt: fixture.pending.unsignedArkPsbt,
      authorizedPsbt: fixture.pending.authorizedPsbt,
      authorizedPendingProof: fixture.pending.authorizedPendingProof,
      operatorArkPsbt: fixture.candidate.finalArkTx,
      operatorCheckpointPsbts: fixture.candidate.signedCheckpointTxs,
    }
    persistVtxoSpend(operatorSubmitted)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(reviewedOperation(operatorSubmitted, { state: 'signed' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    try {
      await expect(sendVaultVtxo({} as never, fixture.current, reviewedQuote(operatorSubmitted))).rejects.toThrow(
        /deployment RP ID/,
      )
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
      expect(getPending).not.toHaveBeenCalled()
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('operator-submitted')

      const checkpointPsbts: string[] = []
      for (const raw of fixture.candidate.signedCheckpointTxs) {
        const phoneSigned = await fixture.phone.sign(Transaction.fromPSBT(base64.decode(raw)))
        checkpointPsbts.push(base64.encode((await fixture.vault.sign(phoneSigned)).toPSBT()))
      }
      const checkpointsAuthorized: PersistedVtxoSpend = {
        ...operatorSubmitted,
        stage: 'checkpoints-authorized',
        checkpointPsbts,
      }
      persistVtxoSpend(checkpointsAuthorized)
      fetch.mockImplementation(
        async () =>
          new Response(JSON.stringify(reviewedOperation(checkpointsAuthorized, { state: 'submitted' })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      )

      vi.mocked(retainFinalizationRecovery).mockRejectedValueOnce(new Error('Recovery storage unavailable'))
      await expect(reconcilePersistedVtxoSpend(fixture.current)).resolves.toMatchObject({
        kind: 'pending',
        operationId: checkpointsAuthorized.operationId,
        stage: 'checkpoints-authorized',
      })
      expect(finalize).not.toHaveBeenCalled()
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('checkpoints-authorized')

      await expect(sendVaultVtxo({} as never, fixture.current, reviewedQuote(checkpointsAuthorized))).rejects.toThrow(
        /offline/,
      )
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('checkpoints-authorized')
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
    }
  })

  it('validates reloaded Vault signatures before any Operator submit or finalize', async () => {
    sdkOperationAdapterMocks.submit.mockReset()
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    const operator = {
      submitTx: vi.fn(),
      getPendingTxs: vi.fn(),
    } as unknown as ArkProvider
    await expect(
      advanceAuthorizedVtxoSpend(
        operator,
        { ...fixture.pending, authorizedPsbt: base64.encode(fixture.phoneArk.toPSBT()) },
        fixture.current,
        fixture.operatorPub,
      ),
    ).rejects.toThrow(/wrong signer set/)
    expect(operator.submitTx).not.toHaveBeenCalled()
    expect(operator.getPendingTxs).not.toHaveBeenCalled()

    const fresh = freshPolicyPending()
    const checkpointOnlyOperator: PersistedVtxoSpend = {
      ...fresh,
      stage: 'checkpoints-authorized',
      authorizedPendingProof: fixture.pending.authorizedPendingProof,
      checkpointPsbts: fixture.candidate.signedCheckpointTxs,
    }
    persistVtxoSpend(checkpointOnlyOperator)
    const restoreLock = installImmediateNavigatorLock()
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(currentOperatorInfo(fresh))
    const finalize = vi.spyOn(RestArkProvider.prototype, 'finalizeTx')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(reviewedOperation(checkpointOnlyOperator, { state: 'submitted' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      await expect(sendVaultVtxo({} as never, fixture.current, reviewedQuote(checkpointOnlyOperator))).rejects.toThrow(
        /wrong signer set/,
      )
      expect(finalize).not.toHaveBeenCalled()
      expect(sdkOperationAdapterMocks.submit).not.toHaveBeenCalled()
    } finally {
      clearPersistedVtxoSpend('vault-a')
      restoreLock()
    }
  })

  it('persists a client-generated operation id and signature before reserving and reuses them exactly', () => {
    clearPersistedVtxoSpend('vault-a')
    const operationId = createVtxoOperationId(hex.decode(OP_1))
    expect(operationId).toBe(OP_1)
    const pending = preReserveVtxoSpend('vault-a', destination(), 12_000, operationId)
    expect(loadPersistedVtxoSpend('vault-a')).toEqual(pending)
    const signed = persistVtxoReserveSignature(
      pending,
      status(),
      hex.decode('01'.padStart(64, '0')),
      new Uint8Array(32),
    )
    const firstRequest = vtxoReserveRequest(signed, status())
    expect(firstRequest).toEqual({
      vaultId: 'vault-a',
      operationId: OP_1,
      purpose: 'spend',
      destAddress: destination(),
      amountSats: 12_000,
      phoneSignature: signed.reservePhoneSignature,
    })
    expect(firstRequest.phoneSignature).toMatch(/^[0-9a-f]{128}$/)
    expect(vtxoReserveRequest(loadPersistedVtxoSpend('vault-a')!, status())).toEqual(firstRequest)
    clearPersistedVtxoSpend('vault-a')
  })

  it('keeps the pre-reserve record recoverable across unlock/sign and POST interruption', () => {
    clearPersistedVtxoSpend('vault-a')
    const pending = preReserveVtxoSpend('vault-a', destination(), 12_000, OP_1)
    expect(() =>
      persistVtxoReserveSignature(pending, status(), hex.decode('02'.padStart(64, '0')), new Uint8Array(32)),
    ).toThrow(/phone key/)
    expect(loadPersistedVtxoSpend('vault-a')).toEqual(pending)

    const signed = persistVtxoReserveSignature(
      pending,
      status(),
      hex.decode('01'.padStart(64, '0')),
      new Uint8Array(32),
    )
    const requestBeforeLostResponse = vtxoReserveRequest(signed, status())
    const recovered = loadPersistedVtxoSpend('vault-a')!
    expect(recovered).toEqual(signed)
    expect(vtxoReserveRequest(recovered, status())).toEqual(requestBeforeLostResponse)
    expect(() => vtxoReserveRequest({ ...recovered, amountSats: recovered.amountSats + 1 }, status())).toThrow(
      /device signature/,
    )
    clearPersistedVtxoSpend('vault-a')
  })

  it('keeps a pre-reservation until the same operation id is retried or aborted', () => {
    clearPersistedVtxoSpend('vault-a')
    const pending = preReserveVtxoSpend('vault-a', destination(), 12_000, OP_1)
    expect(
      applyVtxoOperationView(pending, {
        operationId: OP_1,
        bundleDigest: '11'.repeat(32),
        state: 'reserved',
      }),
    ).toEqual(pending)
    expect(loadPersistedVtxoSpend('vault-a')).toEqual(pending)
    expect(
      applyVtxoOperationView(pending, {
        operationId: OP_1,
        bundleDigest: '11'.repeat(32),
        state: 'aborted',
      }),
    ).toBeUndefined()
    expect(loadPersistedVtxoSpend('vault-a')).toBeUndefined()
  })

  it('reconstructs the pinned policy tree from status', () => {
    const current = status()
    expect(hex.encode(vaultPolicyV1ScriptFromStatus(current).pkScript)).toBe(current.spendingArkScript)
  })

  it('builds the SDK-native one-input checkpoint and Ark transaction', () => {
    const built = buildReservedVtxoSpend(status(), reserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    expect(built.checkpoints).toHaveLength(1)
    expect(built.checkpoints[0].inputsLength).toBe(1)
    expect(built.checkpoints[0].outputsLength).toBe(2)
    expect(built.checkpoints[0].getInput(0).tapScriptSig).toBeUndefined()
    expect(built.arkTx.inputsLength).toBe(1)
    expect(built.arkTx.outputsLength).toBe(3)
    expect(built.arkTx.getOutput(0).amount).toBe(12_000n)
    expect(built.arkTx.getOutput(1).amount).toBe(7_500n)
  })

  it('rejects a server-selected checkpoint escape policy', () => {
    const response = reserve()
    const attacker = CSVMultisigTapscript.encode({
      timelock: { type: 'blocks', value: 1n },
      pubkeys: [hex.decode(golden.fixtures.exitHardwarePub)],
    })
    response.checkpointTapscript = hex.encode(attacker.script)
    expect(() => buildReservedVtxoSpend(status(), response, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /checkpoint tapscript does not match this release/,
    )
  })

  it('preserves canonical fragmented inputs through checkpoints and Ark inputs', () => {
    const response = fragmentedReserve()
    const built = buildReservedVtxoSpend(status(), response, 12_000, destination(), FEE_POLICY_DIGEST)
    expect(built.checkpoints).toHaveLength(2)
    expect(built.arkTx.inputsLength).toBe(2)
    expect(built.arkTx.outputsLength).toBe(3)
    expect(response.inputs.map(({ txid, vout }) => `${txid}:${vout}`)).toEqual([
      `${'11'.repeat(32)}:1`,
      `${'22'.repeat(32)}:3`,
    ])
    expect(built.checkpoints.map((checkpoint) => hex.encode(checkpoint.getInput(0).txid!))).toEqual(
      response.inputs.map((input) => input.txid),
    )
    expect(built.arkTx.getOutput(0).amount).toBe(12_000n)
    expect(built.arkTx.getOutput(1).amount).toBe(7_500n)
  })

  it('uses the reserved zero fee when a payment needs more than the largest coin', () => {
    const response = fragmentedReserve()
    response.inputs[0].valueSats = 10_000
    response.inputs[1].valueSats = 25_000
    response.feeSats = 0
    response.changeSats = 5_000

    const built = buildReservedVtxoSpend(status(), response, 30_000, destination(), FEE_POLICY_DIGEST)
    expect(Math.max(...response.inputs.map((input) => input.valueSats))).toBeLessThan(30_000)
    expect(built.arkTx.getOutput(0).amount).toBe(30_000n)
    expect(built.arkTx.getOutput(1).amount).toBe(5_000n)

    response.feeSats = 1_500
    expect(() => buildReservedVtxoSpend(status(), response, 30_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /does not conserve value/,
    )
  })

  it('supports an exact spend with no change and P2A last', () => {
    const response = reserve()
    response.inputs[0].valueSats = 12_500
    response.changeSats = 0
    response.changeAddress = ''
    response.changeScript = ''
    delete response.changeVout
    const built = buildReservedVtxoSpend(status(), response, 12_000, destination(), FEE_POLICY_DIGEST)
    expect(built.arkTx.outputsLength).toBe(2)
    expect(built.arkTx.getOutput(0).amount).toBe(12_000n)
    expect(built.arkTx.getOutput(1).amount).toBe(0n)
  })

  it('rejects duplicate, shuffled, and malformed reservation inputs', () => {
    const duplicate = fragmentedReserve()
    duplicate.inputs[1] = { ...duplicate.inputs[0] }
    expect(() => buildReservedVtxoSpend(status(), duplicate, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /duplicate reserved input/,
    )

    const shuffled = fragmentedReserve()
    shuffled.inputs.reverse()
    expect(() => buildReservedVtxoSpend(status(), shuffled, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /not canonical/,
    )

    const malformed = fragmentedReserve()
    malformed.inputs[0].txid = 'AA'.repeat(32)
    expect(() => buildReservedVtxoSpend(status(), malformed, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /txid is malformed/,
    )
  })

  it('enforces authoritative fee, change shape, conservation, caps, and safe totals', () => {
    const wrongPolicy = reserve()
    expect(() => buildReservedVtxoSpend(status(), wrongPolicy, 12_000, destination(), 'bb'.repeat(32))).toThrow(
      /fee policy changed/,
    )

    const unconserved = reserve()
    unconserved.changeSats--
    expect(() => buildReservedVtxoSpend(status(), unconserved, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /does not conserve value/,
    )

    const excessiveFee = reserve()
    excessiveFee.feeSats = 5_001
    excessiveFee.changeSats = 2_999
    expect(() => buildReservedVtxoSpend(status(), excessiveFee, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /fee exceeds the vault cap/,
    )

    const subdust = reserve()
    subdust.inputs[0].valueSats = 12_600
    subdust.changeSats = 100
    expect(() => buildReservedVtxoSpend(status(), subdust, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /change is below dust/,
    )

    const mixedNoChange = reserve()
    mixedNoChange.inputs[0].valueSats = 12_500
    mixedNoChange.changeSats = 0
    expect(() => buildReservedVtxoSpend(status(), mixedNoChange, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /omit all change output facts/,
    )

    const missingChangeFacts = reserve()
    delete missingChangeFacts.changeVout
    expect(() =>
      buildReservedVtxoSpend(status(), missingChangeFacts, 12_000, destination(), FEE_POLICY_DIGEST),
    ).toThrow(/change output index is not canonical/)

    const overflow = fragmentedReserve()
    overflow.inputs[0].valueSats = Number.MAX_SAFE_INTEGER
    overflow.inputs[1].valueSats = Number.MAX_SAFE_INTEGER
    expect(() => buildReservedVtxoSpend(status(), overflow, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /overflows safe sats/,
    )

    const tooMany = reserve()
    tooMany.inputs = Array.from({ length: 51 }, (_, index) => ({
      ...tooMany.inputs[0],
      txid: index.toString(16).padStart(64, '0'),
      vout: 0,
      valueSats: 1,
    }))
    expect(() => buildReservedVtxoSpend(status(), tooMany, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /1 to 50 inputs/,
    )
  })

  it('signs every Ark input in a fragmented spend', async () => {
    const built = buildReservedVtxoSpend(status(), fragmentedReserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    const user = SingleKey.fromPrivateKey(hex.decode('01'.padStart(64, '0')))
    const signed = await user.sign(built.arkTx)
    expect(() => requireUserSignedArkInputs(signed, hex.decode(golden.fixtures.userPub))).not.toThrow()
    expect(
      Array.from({ length: signed.inputsLength }, (_, index) => signed.getInput(index).tapScriptSig?.length),
    ).toEqual([1, 1])
  })

  it('matches shuffled Operator checkpoints by identity and restores canonical order', async () => {
    const built = buildReservedVtxoSpend(status(), fragmentedReserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const expected = built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()))
    const signed = await Promise.all(
      built.checkpoints.map(async (checkpoint) => base64.encode((await operator.sign(checkpoint)).toPSBT())),
    )
    const shuffled = [...signed].reverse()
    const ordered = matchOperatorSignedCheckpoints(expected, shuffled, hex.decode(golden.fixtures.arkdServerPub))
    expect(ordered.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)).toEqual(
      built.checkpoints.map((checkpoint) => checkpoint.id),
    )
    expect(
      orderAuthorizedCheckpoints(expected, shuffled).map((raw) => Transaction.fromPSBT(base64.decode(raw)).id),
    ).toEqual(built.checkpoints.map((checkpoint) => checkpoint.id))
    expect(() =>
      matchOperatorSignedCheckpoints(expected, signed.slice(0, 1), hex.decode(golden.fixtures.arkdServerPub)),
    ).toThrow(/wrong checkpoint count/)
    expect(() =>
      matchOperatorSignedCheckpoints(expected, [signed[0], signed[0]], hex.decode(golden.fixtures.arkdServerPub)),
    ).toThrow(/duplicate checkpoint/)
  })

  it('preserves the Operator checkpoint signature when the user signs after submit', async () => {
    const built = buildReservedVtxoSpend(status(), reserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    // The frozen fixture's Arkade Operator key is private scalar 4.
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const user = SingleKey.fromPrivateKey(hex.decode('01'.padStart(64, '0')))
    const operatorSigned = await operator.sign(built.checkpoints[0])
    requireOperatorSignedCheckpoint(built.checkpoints[0], operatorSigned, hex.decode(golden.fixtures.arkdServerPub))
    const userAndOperatorSigned = await user.sign(operatorSigned)
    expect(userAndOperatorSigned.getInput(0).tapScriptSig?.map(([data]) => hex.encode(data.pubKey))).toEqual([
      golden.fixtures.arkdServerPub,
      golden.fixtures.userPub,
    ])
  })

  it('accepts the Operator SDK normalization of redundant taptree depth metadata', async () => {
    const built = buildReservedVtxoSpend(status(), reserve(), 12_000, destination(), FEE_POLICY_DIGEST)
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const operatorSigned = await operator.sign(built.checkpoints[0])
    const input = (
      operatorSigned as unknown as {
        inputs: { unknown?: [{ type: number; key: Uint8Array }, Uint8Array][] }[]
      }
    ).inputs[0]
    const entry = input.unknown?.find(([key]) => key.type === 222 && hex.encode(key.key) === '74617074726565')
    expect(entry).toBeTruthy()
    const normalized = Uint8Array.from(entry![1])
    let changed = 0
    for (let index = 0; index + 1 < normalized.length; index++) {
      if (normalized[index] === 1 && normalized[index + 1] === 0xc0) {
        normalized[index] = 2
        changed++
      }
    }
    expect(changed).toBeGreaterThan(0)
    entry![1] = normalized
    expect(() =>
      requireOperatorSignedCheckpoint(built.checkpoints[0], operatorSigned, hex.decode(golden.fixtures.arkdServerPub)),
    ).not.toThrow()
  })

  it('resumes after reload when the Operator SDK normalized taptree metadata', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend(fixture.pending)
    const reloaded = loadPersistedVtxoSpend('vault-a')!
    const normalizedCheckpoint = Transaction.fromPSBT(base64.decode(fixture.candidate.signedCheckpointTxs[0]))
    const input = (
      normalizedCheckpoint as unknown as {
        inputs: { unknown?: [{ type: number; key: Uint8Array }, Uint8Array][] }[]
      }
    ).inputs[0]
    const entry = input.unknown?.find(([key]) => key.type === 222 && hex.encode(key.key) === '74617074726565')
    expect(entry).toBeTruthy()
    const normalized = Uint8Array.from(entry![1])
    for (let index = 0; index + 1 < normalized.length; index++) {
      if (normalized[index] === 1 && normalized[index + 1] === 0xc0) normalized[index] = 2
    }
    entry![1] = normalized

    const matched = matchPendingOperatorSubmission(
      reloaded,
      [
        {
          ...fixture.candidate,
          signedCheckpointTxs: [
            base64.encode(normalizedCheckpoint.toPSBT()),
            ...fixture.candidate.signedCheckpointTxs.slice(1),
          ],
        },
      ],
      fixture.current,
      fixture.operatorPub,
    )

    expect(matched.arkTxid).toBe(fixture.pending.arkTxid)
    clearPersistedVtxoSpend('vault-a')
  })

  it('binds pending lookup to the exact checkpoints and requires phone plus VaultCosigner', async () => {
    const fixture = await authorizedPendingFixture()
    expect(
      requireAuthorizedPendingProof(
        fixture.pending.unsignedCheckpointPsbts!,
        fixture.authorizedPendingProof,
        fixture.current,
      ),
    ).toBe(fixture.authorizedPendingProof)
    expect(() =>
      requireAuthorizedPendingProof(fixture.pending.unsignedCheckpointPsbts!, fixture.phoneProof, fixture.current),
    ).toThrow(/wrong signer set/)

    const oversigned = base64.encode(
      (await fixture.operator.sign(Transaction.fromPSBT(base64.decode(fixture.authorizedPendingProof)))).toPSBT(),
    )
    expect(() =>
      requireAuthorizedPendingProof(fixture.pending.unsignedCheckpointPsbts!, oversigned, fixture.current),
    ).toThrow(/wrong signer set/)

    const missingSyntheticSignature = base64.encode(
      (
        await SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0'))).sign(
          Transaction.fromPSBT(base64.decode(fixture.phoneProof)),
          [1, 2],
        )
      ).toPSBT(),
    )
    expect(() =>
      requireAuthorizedPendingProof(
        fixture.pending.unsignedCheckpointPsbts!,
        missingSyntheticSignature,
        fixture.current,
      ),
    ).toThrow(/wrong signer set/)

    const authorizedProof = Transaction.fromPSBT(base64.decode(fixture.authorizedPendingProof))
    const signature = authorizedProof.getInput(0).tapScriptSig![0][1]
    const mutatedSyntheticSignature = base64.decode(fixture.authorizedPendingProof)
    const signatureOffset = indexOfBytes(mutatedSyntheticSignature, signature)
    expect(signatureOffset).toBeGreaterThanOrEqual(0)
    mutatedSyntheticSignature[signatureOffset + 10] ^= 1
    expect(() =>
      requireAuthorizedPendingProof(
        fixture.pending.unsignedCheckpointPsbts!,
        base64.encode(mutatedSyntheticSignature),
        fixture.current,
      ),
    ).toThrow()

    const message = new TextEncoder().encode(Intent.encodeMessage(VTXO_GET_PENDING_MESSAGE))
    const mutatedMessage = base64.decode(fixture.authorizedPendingProof)
    const messageOffset = indexOfBytes(mutatedMessage, message)
    expect(messageOffset).toBeGreaterThanOrEqual(0)
    mutatedMessage[messageOffset + message.length - 2] = '1'.charCodeAt(0)
    expect(() =>
      requireAuthorizedPendingProof(
        fixture.pending.unsignedCheckpointPsbts!,
        base64.encode(mutatedMessage),
        fixture.current,
      ),
    ).toThrow(/changed the pending proof PSBT/)

    const other = [...fixture.pending.unsignedCheckpointPsbts!]
    other[0] = validCheckpointPsbt()
    expect(() => requireAuthorizedPendingProof(other, fixture.authorizedPendingProof, fixture.current)).toThrow(
      /changed the pending proof/,
    )
  })

  it('accepts only the exact retained Ark transaction and Operator checkpoint bundle', async () => {
    const fixture = await authorizedPendingFixture()
    const matched = matchPendingOperatorSubmission(
      fixture.pending,
      [fixture.candidate],
      fixture.current,
      fixture.operatorPub,
    )
    expect(matched.arkTxid).toBe(fixture.pending.arkTxid)
    expect(Transaction.fromPSBT(base64.decode(matched.operatorArkPsbt)).id).toBe(fixture.pending.arkTxid)
    expect(matched.operatorCheckpointPsbts).toHaveLength(2)
    expect(() => matchPendingOperatorSubmission(fixture.pending, [], fixture.current, fixture.operatorPub)).toThrow(
      /exactly one/,
    )
    expect(() =>
      matchPendingOperatorSubmission(
        fixture.pending,
        [{ ...fixture.candidate, arkTxid: 'ff'.repeat(32) }],
        fixture.current,
        fixture.operatorPub,
      ),
    ).toThrow(/another transaction/)
    expect(() =>
      matchPendingOperatorSubmission(
        fixture.pending,
        [{ ...fixture.candidate, signedCheckpointTxs: fixture.candidate.signedCheckpointTxs.slice(0, 1) }],
        fixture.current,
        fixture.operatorPub,
      ),
    ).toThrow(/wrong checkpoint count/)
    expect(() =>
      matchPendingOperatorSubmission(
        fixture.pending,
        [{ ...fixture.candidate, finalArkTx: fixture.pending.authorizedPsbt! }],
        fixture.current,
        fixture.operatorPub,
      ),
    ).toThrow(/wrong signer set/)
  })

  it('requires the real signer sets and exact PSBTs at every SDK adapter stage', async () => {
    const fixture = await authorizedPendingFixture()
    const validation = createVaultSdkOperationValidation(fixture.current, fixture.built.arkTx, fixture.operatorPub)
    expect(() => validation.assertArkTransaction(fixture.built.arkTx, 'unsigned')).not.toThrow()
    expect(() => validation.assertArkTransaction(fixture.authorizedArk, 'vault-authorized')).not.toThrow()
    expect(() => validation.assertArkTransaction(fixture.finalArk, 'operator-signed')).not.toThrow()

    const originalCheckpoint = fixture.built.checkpoints[0]
    const operatorCheckpoint = fixture.operatorCheckpoints[0]
    expect(() =>
      validation.assertCheckpointTransaction(operatorCheckpoint, originalCheckpoint, 'operator-signed'),
    ).not.toThrow()
    expect(() =>
      validation.assertCheckpointTransaction(operatorCheckpoint, originalCheckpoint, 'vault-authorized'),
    ).toThrow(/wrong signer set/)

    const phoneCheckpoint = await fixture.phone.sign(operatorCheckpoint)
    const vaultCheckpoint = await fixture.vault.sign(phoneCheckpoint)
    expect(() =>
      validation.assertCheckpointTransaction(vaultCheckpoint, originalCheckpoint, 'vault-authorized'),
    ).not.toThrow()
  })

  it('submits once after reloading an authorized operation before the write-ahead marker', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend(fixture.pending)
    const reloaded = loadPersistedVtxoSpend('vault-a')!
    const calls: string[] = []
    const operator = {
      async submitTx() {
        expect(loadPersistedVtxoSpend('vault-a')?.operatorSubmitAttempted).toBe(true)
        calls.push('submit')
        return fixture.candidate
      },
      async getPendingTxs() {
        calls.push('pending')
        return []
      },
    } as unknown as ArkProvider

    const submitted = await advanceAuthorizedVtxoSpend(operator, reloaded, fixture.current, fixture.operatorPub)
    expect(calls).toEqual(['submit'])
    expect(submitted.stage).toBe('operator-submitted')
    expect(submitted.operatorArkPsbt).toBe(fixture.candidate.finalArkTx)
    expect(loadPersistedVtxoSpend('vault-a')?.operatorArkPsbt).toBe(fixture.candidate.finalArkTx)
    clearPersistedVtxoSpend('vault-a')
  })

  it('recovers a lost submit response once through getPendingTxs without resubmitting', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend(fixture.pending)
    const calls: string[] = []
    let recoveredProof = ''
    const operator = {
      async submitTx() {
        calls.push('submit')
        expect(loadPersistedVtxoSpend('vault-a')?.operatorSubmitAttempted).toBe(true)
        throw new TypeError('network response lost')
      },
      async getPendingTxs(intent: { proof: string; message: typeof VTXO_GET_PENDING_MESSAGE }) {
        calls.push('pending')
        recoveredProof = intent.proof
        expect(intent.message).toEqual(VTXO_GET_PENDING_MESSAGE)
        return [fixture.candidate]
      },
    } as unknown as ArkProvider

    const recovered = await advanceAuthorizedVtxoSpend(operator, fixture.pending, fixture.current, fixture.operatorPub)
    expect(calls).toEqual(['submit', 'pending'])
    expect(recoveredProof).toBe(fixture.authorizedPendingProof)
    expect(recovered.stage).toBe('operator-submitted')
    expect(recovered.operatorArkPsbt).toBe(fixture.candidate.finalArkTx)
    expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('operator-submitted')
    clearPersistedVtxoSpend('vault-a')
  })

  it('waits for an accepted Operator submission to appear in pending lookup', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend({ ...fixture.pending, operatorSubmitAttempted: true })
    let pendingCalls = 0
    const operator = {
      async submitTx() {
        throw new Error('must not resubmit')
      },
      async getPendingTxs() {
        pendingCalls++
        return pendingCalls < 3 ? [] : [fixture.candidate]
      },
    } as unknown as ArkProvider

    const recovered = await advanceAuthorizedVtxoSpend(
      operator,
      loadPersistedVtxoSpend('vault-a')!,
      fixture.current,
      fixture.operatorPub,
    )
    expect(pendingCalls).toBe(3)
    expect(recovered.stage).toBe('operator-submitted')
    clearPersistedVtxoSpend('vault-a')
  })

  it('treats a reloaded write-ahead marker as ambiguous and uses lookup only', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend({ ...fixture.pending, operatorSubmitAttempted: true })
    const reloaded = loadPersistedVtxoSpend('vault-a')!
    const calls: string[] = []
    const operator = {
      async submitTx() {
        calls.push('submit')
        throw new Error('must not submit')
      },
      async getPendingTxs() {
        calls.push('pending')
        return [fixture.candidate]
      },
    } as unknown as ArkProvider

    const recovered = await advanceAuthorizedVtxoSpend(operator, reloaded, fixture.current, fixture.operatorPub)
    expect(calls).toEqual(['pending'])
    expect(recovered.stage).toBe('operator-submitted')
    clearPersistedVtxoSpend('vault-a')
  })

  it('keeps an attempted operation locked when pending lookup is empty', async () => {
    clearPersistedVtxoSpend('vault-a')
    const fixture = await authorizedPendingFixture()
    persistVtxoSpend({ ...fixture.pending, operatorSubmitAttempted: true })
    const reloaded = loadPersistedVtxoSpend('vault-a')!
    let submitCalls = 0
    let pendingCalls = 0
    const operator = {
      async submitTx() {
        submitCalls++
        throw new Error('must not submit')
      },
      async getPendingTxs() {
        pendingCalls++
        return []
      },
    } as unknown as ArkProvider

    await expect(advanceAuthorizedVtxoSpend(operator, reloaded, fixture.current, fixture.operatorPub)).rejects.toThrow(
      /exactly one/,
    )
    expect(submitCalls).toBe(0)
    expect(pendingCalls).toBe(20)
    expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('authorized')
    expect(loadPersistedVtxoSpend('vault-a')?.operatorSubmitAttempted).toBe(true)

    const legacy = { ...fixture.pending, authorizedPendingProof: undefined }
    await expect(
      advanceAuthorizedVtxoSpend(operator, legacy, fixture.current, fixture.operatorPub),
    ).rejects.toBeInstanceOf(VtxoSpendInFlightError)
    expect(submitCalls).toBe(0)
    clearPersistedVtxoSpend('vault-a')
  })

  it.each([
    ['unattempted', false, 1, 0],
    ['attempted', true, 0, 1],
  ] as const)(
    'reconciles a persisted authorized %s operation using the durable submit marker',
    async (_label, attempted, expectedSubmitCalls, expectedPendingCalls) => {
      clearPersistedVtxoSpend('vault-a')
      const fixture = await authorizedPendingFixture()
      const pending = {
        ...fixture.pending,
        feePolicyDigest: arkadeIntentFeePolicyDigest(RECONCILE_FEE_POLICY),
        ...(attempted ? { operatorSubmitAttempted: true } : {}),
      }
      persistVtxoSpend(pending)
      const originalLocks = navigator.locks
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
          request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
            callback({}),
        },
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            operationId: pending.operationId,
            bundleDigest: pending.bundleDigest,
            state: 'signed',
            arkTxid: pending.arkTxid,
            authorizedPsbt: pending.authorizedPsbt,
            authorizedPendingProof: pending.authorizedPendingProof,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue({
        network: 'mutinynet',
        signerPubkey: golden.fixtures.arkdServerPub,
        checkpointTapscript: pending.checkpointTapscript,
        fees: { intentFee: RECONCILE_FEE_POLICY, txFeeRate: '0' },
      } as never)
      const submit = vi.spyOn(RestArkProvider.prototype, 'submitTx').mockImplementation(async () => {
        expect(loadPersistedVtxoSpend('vault-a')?.operatorSubmitAttempted).toBe(true)
        return fixture.candidate
      })
      const getPending = vi.spyOn(RestArkProvider.prototype, 'getPendingTxs').mockResolvedValue([fixture.candidate])

      try {
        await expect(reconcilePersistedVtxoSpend(fixture.current)).resolves.toEqual({
          kind: 'pending',
          operationId: pending.operationId,
          stage: 'operator-submitted',
        })
        expect(submit).toHaveBeenCalledTimes(expectedSubmitCalls)
        expect(getPending).toHaveBeenCalledTimes(expectedPendingCalls)
        expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('operator-submitted')
      } finally {
        clearPersistedVtxoSpend('vault-a')
        if (originalLocks) {
          Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
        } else {
          Reflect.deleteProperty(navigator, 'locks')
        }
      }
    },
  )

  it('fails closed if status and reservation do not name the same policy script', () => {
    const changed = reserve()
    changed.changeScript = `5120${'44'.repeat(32)}`
    expect(() => buildReservedVtxoSpend(status(), changed, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /change is not vault-policy-v1/,
    )
  })

  it('fails closed when a reservation omits the checkpoint tapscript', () => {
    const changed = reserve()
    changed.checkpointTapscript = undefined
    expect(() => buildReservedVtxoSpend(status(), changed, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /checkpoint tapscript is missing/,
    )
  })

  it('rejects a reservation for another destination or Operator', () => {
    const changed = reserve()
    changed.destScript = `5120${golden.fixtures.delegatePub}`
    expect(() => buildReservedVtxoSpend(status(), changed, 12_000, destination(), FEE_POLICY_DIGEST)).toThrow(
      /reserved destination/,
    )
    const otherOperator = new ArkAddress(
      hex.decode(golden.fixtures.userPub),
      hex.decode(golden.fixtures.exitHardwarePub),
      'tark',
    ).encode()
    expect(() => buildReservedVtxoSpend(status(), reserve(), 12_000, otherOperator, FEE_POLICY_DIGEST)).toThrow(
      /another Arkade Operator/,
    )
  })

  it('keeps Bitcoin destinations on the onchain spend path', () => {
    expect(() => buildReservedVtxoSpend(status(), reserve(), 12_000, TB1Q, FEE_POLICY_DIGEST)).toThrow(
      /VTXO destination must be an Arkade address/,
    )
  })

  it('does not treat an older persisted spend as the newly approved payment', () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: 'tark1qqold',
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'operator-finalized',
    })
    const pending = loadPersistedVtxoSpend('vault-a')
    expect(pendingVtxoSpendBlocksNewSend(pending)).toBe(true)
    expect(isSameVtxoPayment(pending!, 'tark1qqold', 12_000)).toBe(true)
    expect(isSameVtxoPayment(pending!, 'tark1qqnew', 12_000)).toBe(false)
    expect(vtxoNewSendAction(pending, 'tark1qqold', 12_000)).toBe('warn')
    expect(vtxoNewSendAction(pending, 'tark1qqold', 20_000)).toBe('live-pending')
    expect(vtxoNewSendAction(pending, 'tark1qqnew', 12_000)).toBe('live-pending')
    expect(vtxoNewSendAction({ ...pending!, stage: 'reserved' }, 'tark1qqold', 12_000)).toBe('resume')
    expect(vtxoNewSendAction({ ...pending!, stage: 'reserved' }, 'tark1qqold', 20_000)).toBe('abort-reserved')
    expect(vtxoNewSendAction({ ...pending!, stage: 'authorized' }, 'tark1qqold', 12_000)).toBe('resume')
    expect(vtxoNewSendAction({ ...pending!, stage: 'authorized' }, 'tark1qqold', 20_000)).toBe('live-pending')
    expect(
      vtxoNewSendAction({ ...pending!, stage: 'authorized', operatorSubmitAttempted: true }, 'tark1qqold', 12_000),
    ).toBe('warn')
    expect(vtxoNewSendAction(undefined, 'tark1qqold', 12_000)).toBe('start')
    expect(isVtxoReceiptPendingError(new VtxoReceiptPendingError('aa'.repeat(32), OP_1, 0))).toBe(true)
    expect(new VtxoSpendInFlightError('aa'.repeat(32), OP_1).message).toMatch(/still with the operator/)
    clearPersistedVtxoSpend('vault-a')
    expect(pendingVtxoSpendBlocksNewSend(loadPersistedVtxoSpend('vault-a'))).toBe(false)
  })

  it('persists the reservation and PSBT material before authorization', () => {
    clearPersistedVtxoSpend('vault-a')
    const reserved: PersistedVtxoSpend = {
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      reservationExpires: '2026-08-20T00:02:00Z',
      ...RESERVATION_FACTS,
      stage: 'reserved',
      unsignedArkPsbt: 'cHNidP9ark',
      unsignedCheckpointPsbts: ['cHNidP9cp'],
    }
    persistVtxoSpend(reserved)
    expect(loadPersistedVtxoSpend('vault-a')).toMatchObject(reserved)
    expect(pendingVtxoSpendBlocksNewSend(loadPersistedVtxoSpend('vault-a'))).toBe(true)
    clearPersistedVtxoSpend('vault-a')
  })

  it('persists and deterministically rebuilds the validated fresh SDK bundle', () => {
    clearPersistedVtxoSpend('vault-a')
    const reserved = sdkReservedPending()
    persistVtxoSpend(reserved)

    const reloaded = loadPersistedVtxoSpend('vault-a')!
    expect(reloaded).toMatchObject({
      sdkBundleVersion: 1,
      reservedInputs: reserved.reservedInputs,
      reservedOutputs: reserved.reservedOutputs,
    })
    const rebuilt = buildPersistedVtxoSdkBundle(status(), reloaded)
    expect(rebuilt.rebuilt.arkTx.id).toBe(reserved.arkTxid)
    expect(rebuilt.rebuilt.checkpoints.map((tx) => tx.id)).toEqual(
      reserved.unsignedCheckpointPsbts!.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id),
    )
    clearPersistedVtxoSpend('vault-a')
  })

  it.each([
    [
      'too many inputs',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        reservedInputs: Array.from({ length: 51 }, (_, index) => ({
          ...pending.reservedInputs![0],
          txid: index.toString(16).padStart(64, '0'),
        })),
      }),
    ],
    [
      'noncanonical inputs',
      (pending: PersistedVtxoSpend) => ({ ...pending, reservedInputs: [...pending.reservedInputs!].reverse() }),
    ],
    [
      'missing change output',
      (pending: PersistedVtxoSpend) => ({ ...pending, reservedOutputs: pending.reservedOutputs!.slice(0, 1) }),
    ],
    [
      'reordered outputs',
      (pending: PersistedVtxoSpend) => ({ ...pending, reservedOutputs: [...pending.reservedOutputs!].reverse() }),
    ],
    [
      'malformed script',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        reservedInputs: [{ ...pending.reservedInputs![0], scriptHex: '00' }, ...pending.reservedInputs!.slice(1)],
      }),
    ],
  ] as const)('rejects a persisted fresh SDK bundle with %s', (_label, mutate) => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend(mutate(sdkReservedPending()))
    expect(loadPersistedVtxoSpend('vault-a')).toBeUndefined()
    clearPersistedVtxoSpend('vault-a')
  })

  it('revalidates stored SDK scripts against the current pinned Vault policy', () => {
    const pending = sdkReservedPending()
    pending.reservedInputs = pending.reservedInputs!.map((input) => ({ ...input, scriptHex: `5120${'44'.repeat(32)}` }))
    expect(() => buildPersistedVtxoSdkBundle(status(), pending)).toThrow(/not current vault-policy-v1/)
  })

  it.each([
    ['reserved', (pending: PersistedVtxoSpend) => pending],
    [
      'authorized',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        stage: 'authorized' as const,
        authorizedPsbt: pending.unsignedArkPsbt,
        authorizedPendingProof: pending.unsignedCheckpointPsbts![0],
      }),
    ],
    [
      'operator-submitted',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        stage: 'operator-submitted' as const,
        authorizedPsbt: pending.unsignedArkPsbt,
        authorizedPendingProof: pending.unsignedCheckpointPsbts![0],
        operatorSubmitAttempted: true,
        operatorArkPsbt: pending.unsignedArkPsbt,
        operatorCheckpointPsbts: pending.unsignedCheckpointPsbts,
      }),
    ],
    [
      'checkpoints-authorized',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        stage: 'checkpoints-authorized' as const,
        authorizedPendingProof: pending.unsignedCheckpointPsbts![0],
        checkpointPsbts: pending.unsignedCheckpointPsbts,
      }),
    ],
    [
      'operator-finalized',
      (pending: PersistedVtxoSpend) => ({
        ...pending,
        stage: 'operator-finalized' as const,
        authorizedPendingProof: pending.unsignedCheckpointPsbts![0],
        checkpointPsbts: pending.unsignedCheckpointPsbts,
      }),
    ],
  ] as const)('reloads a fresh SDK operation at the durable %s boundary', (stage, atBoundary) => {
    clearPersistedVtxoSpend('vault-a')
    const pending = atBoundary(sdkReservedPending())
    persistVtxoSpend(pending)
    expect(loadPersistedVtxoSpend('vault-a')).toMatchObject({
      stage,
      sdkBundleVersion: 1,
      reservedInputs: pending.reservedInputs,
      reservedOutputs: pending.reservedOutputs,
    })
    clearPersistedVtxoSpend('vault-a')
  })

  it('uses the operation view to resume a lost authorize response', () => {
    clearPersistedVtxoSpend('vault-a')
    const checkpointPsbt = validCheckpointPsbt()
    const reserved: PersistedVtxoSpend = {
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'reserved',
      unsignedArkPsbt: 'cHNidP9ark',
      unsignedCheckpointPsbts: [checkpointPsbt],
    }
    persistVtxoSpend(reserved)
    const signed = applyVtxoOperationView(reserved, {
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      state: 'signed',
      arkTxid: 'aa'.repeat(32),
      authorizedPsbt: 'cHNidP9signed',
      authorizedPendingProof: 'cHNidP9pending',
    })
    expect(signed?.stage).toBe('authorized')
    expect(signed?.authorizedPsbt).toBe('cHNidP9signed')
    expect(signed?.authorizedPendingProof).toBe('cHNidP9pending')
    expect(loadPersistedVtxoSpend('vault-a')?.stage).toBe('authorized')

    const submitted = applyVtxoOperationView(signed!, {
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      state: 'submitted',
      arkTxid: 'aa'.repeat(32),
      authorizedPsbt: 'cHNidP9signed',
      checkpointPsbts: [checkpointPsbt],
    })
    expect(submitted?.stage).toBe('checkpoints-authorized')
    expect(submitted?.checkpointPsbts).toEqual([checkpointPsbt])

    const finalized = applyVtxoOperationView(submitted!, {
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      state: 'finalized',
      arkTxid: 'aa'.repeat(32),
    })
    expect(finalized?.stage).toBe('operator-finalized')

    expect(
      applyVtxoOperationView(finalized!, {
        operationId: OP_1,
        bundleDigest: '11'.repeat(32),
        state: 'aborted',
      }),
    ).toBeUndefined()
    expect(loadPersistedVtxoSpend('vault-a')).toBeUndefined()
  })

  it('fails closed on an unresolved operation', () => {
    const pending: PersistedVtxoSpend = {
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9signed',
      unsignedCheckpointPsbts: ['cHNidP9cp'],
    }
    expect(() =>
      applyVtxoOperationView(pending, {
        operationId: OP_1,
        bundleDigest: '11'.repeat(32),
        state: 'unresolved',
        arkTxid: 'aa'.repeat(32),
      }),
    ).toThrow(VtxoSpendUnresolvedError)
  })

  it('merges operation status without moving the local stage backward', () => {
    expect(laterVtxoSpendStage('operator-submitted', 'authorized')).toBe('operator-submitted')
    expect(laterVtxoSpendStage('operator-finalized', 'checkpoints-authorized')).toBe('operator-finalized')
    expect(laterVtxoSpendStage('reserved', 'authorized')).toBe('authorized')

    clearPersistedVtxoSpend('vault-a')
    const checkpointPsbt = validCheckpointPsbt()
    const submitted: PersistedVtxoSpend = {
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'operator-submitted',
      authorizedPsbt: 'cHNidP9local',
      unsignedCheckpointPsbts: [checkpointPsbt],
      operatorCheckpointPsbts: ['cHNidP9op'],
    }
    const afterSigned = applyVtxoOperationView(submitted, {
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      state: 'signed',
      arkTxid: 'aa'.repeat(32),
      authorizedPsbt: 'cHNidP9signed',
    })
    expect(afterSigned?.stage).toBe('operator-submitted')
    expect(afterSigned?.authorizedPsbt).toBe('cHNidP9signed')
    expect(afterSigned?.operatorCheckpointPsbts).toEqual(['cHNidP9op'])

    const finalized: PersistedVtxoSpend = {
      ...submitted,
      stage: 'operator-finalized',
      checkpointPsbts: [checkpointPsbt],
    }
    const afterSubmitted = applyVtxoOperationView(finalized, {
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      state: 'submitted',
      arkTxid: 'aa'.repeat(32),
      authorizedPsbt: 'cHNidP9signed',
      checkpointPsbts: [checkpointPsbt],
    })
    expect(afterSubmitted?.stage).toBe('operator-finalized')
    expect(afterSubmitted?.checkpointPsbts).toEqual([checkpointPsbt])
    clearPersistedVtxoSpend('vault-a')
  })

  it('rejects an operation view for a different id or digest', () => {
    const pending: PersistedVtxoSpend = {
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9signed',
    }
    expect(() =>
      applyVtxoOperationView(pending, {
        operationId: OP_2,
        bundleDigest: '11'.repeat(32),
        state: 'signed',
      }),
    ).toThrow(/operation id mismatch/)
    expect(() =>
      applyVtxoOperationView(pending, {
        operationId: OP_1,
        bundleDigest: '22'.repeat(32),
        state: 'signed',
      }),
    ).toThrow(/digest mismatch/)
  })

  it('keeps earlier operations in a bounded journal instead of replacing the one-slot record', () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: 'tark1qqold',
      amountSats: 20_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    })
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_2,
      bundleDigest: '22'.repeat(32),
      destAddress: 'tark1qqold',
      amountSats: 12_000,
      arkTxid: 'bb'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'reserved',
    })
    expect(listPersistedVtxoSpends('vault-a').map((record) => record.operationId)).toEqual([OP_1, OP_2])
    expect(loadPersistedVtxoSpend('vault-a')?.operationId).toBe(OP_2)
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)?.stage).toBe('authorized')
    clearPersistedVtxoSpend('vault-a')
  })

  it('blocks a matching reserved send when a different signed operation is still active', () => {
    const signed = { ...reviewedPending(), operationId: OP_1, amountSats: 20_000, stage: 'authorized' as const }
    const matchingReserved = { ...reviewedPending(), operationId: OP_2, stage: 'reserved' as const }
    expect(
      vtxoJournalSendAction([signed, matchingReserved], matchingReserved.destAddress, matchingReserved.amountSats),
    ).toBe('live-pending')
  })

  it('reconciles every journal entry after restart but never discards a signed operation', async () => {
    const restoreLocks = installImmediateNavigatorLock()
    clearPersistedVtxoSpend('vault-a')
    const signed = {
      ...sdkReservedPending(),
      operationId: OP_1,
      stage: 'authorized' as const,
      operatorSubmitAttempted: true,
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    }
    const reserved = { ...sdkReservedPending(), operationId: OP_2, stage: 'reserved' as const }
    persistVtxoSpend(signed)
    persistVtxoSpend(reserved)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'vtxo operation not found', code: 'NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    try {
      await expect(reconcilePersistedVtxoSpend(status())).resolves.toEqual({
        kind: 'pending',
        operationId: OP_1,
        stage: 'authorized',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(listPersistedVtxoSpends('vault-a').map((record) => record.operationId)).toEqual([OP_1])
      expect(vtxoJournalSendAction(listPersistedVtxoSpends('vault-a'), destination(), 20_000)).toBe('live-pending')
    } finally {
      fetchMock.mockRestore()
      clearPersistedVtxoSpend('vault-a')
      restoreLocks()
    }
  })

  it('keeps a signed 404 operation across restart without complete exact terminal proof', async () => {
    const restoreLocks = installImmediateNavigatorLock()
    clearPersistedVtxoSpend('vault-a')
    const signed = {
      ...sdkReservedPending(),
      stage: 'authorized' as const,
      operatorSubmitAttempted: true,
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    }
    persistVtxoSpend(signed)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'vtxo operation not found', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      await expect(reconcilePersistedVtxoSpend(status())).resolves.toEqual({
        kind: 'pending',
        operationId: OP_1,
        stage: 'authorized',
      })
      expect(loadPersistedVtxoSpendById('vault-a', OP_1)).toBeTruthy()
      expect(vtxoJournalSendAction(listPersistedVtxoSpends('vault-a'), destination(), 20_000)).toBe('live-pending')
    } finally {
      fetchMock.mockRestore()
      clearPersistedVtxoSpend('vault-a')
      restoreLocks()
    }
  })

  it('keeps an unresolved server operation even with exact SDK terminal proof', async () => {
    const restoreLocks = installImmediateNavigatorLock()
    clearPersistedVtxoSpend('vault-a')
    const signed = {
      ...sdkReservedPending(),
      stage: 'authorized' as const,
      operatorSubmitAttempted: true,
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    }
    persistVtxoSpend(signed)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...reviewedOperation(signed),
          state: 'unresolved',
          feeSats: signed.feeSats,
          feePolicyDigest: signed.feePolicyDigest,
          changeSats: signed.changeSats,
          changeVout: signed.changeVout,
          changeScript: fragmentedReserve().changeScript,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    try {
      await expect(reconcilePersistedVtxoSpend(status())).resolves.toEqual({
        kind: 'pending',
        operationId: OP_1,
        stage: 'authorized',
      })
      expect(loadPersistedVtxoSpendById('vault-a', OP_1)).toBeTruthy()
    } finally {
      fetchMock.mockRestore()
      clearPersistedVtxoSpend('vault-a')
      restoreLocks()
    }
  })

  it('clears a server-finalized operation without retrying the finalize mutation', async () => {
    const restoreLocks = installImmediateNavigatorLock()
    clearPersistedVtxoSpend('vault-a')
    const signed = {
      ...sdkReservedPending(),
      stage: 'authorized' as const,
      operatorSubmitAttempted: true,
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: undefined,
    }
    persistVtxoSpend(signed)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = init?.method || 'GET'
      if (method !== 'GET') throw new Error('finalize mutation must not be retried')
      return new Response(
        JSON.stringify({
          ...reviewedOperation(signed),
          state: 'finalized',
          arkTxid: signed.arkTxid,
          feeSats: signed.feeSats,
          feePolicyDigest: signed.feePolicyDigest,
          changeSats: signed.changeSats,
          changeVout: signed.changeVout,
          changeScript: fragmentedReserve().changeScript,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    try {
      await expect(reconcilePersistedVtxoSpend(status())).resolves.toEqual({
        kind: 'receipt-finalized',
        txid: signed.arkTxid,
        operationId: signed.operationId,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(loadPersistedVtxoSpendById('vault-a', signed.operationId)).toBeUndefined()
    } finally {
      fetchMock.mockRestore()
      clearPersistedVtxoSpend('vault-a')
      restoreLocks()
    }
  })

  it('refuses a different-amount send without aborting a reserved operation or erasing a signed one', async () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    })
    await expect(previewVaultVtxoSend(status(), destination(), 20_000)).rejects.toSatisfy(isVtxoLivePendingError)
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)?.stage).toBe('authorized')
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      reservationExpires: '2099-08-20T00:02:00Z',
      ...RESERVATION_FACTS,
      stage: 'reserved',
    })
    await expect(previewVaultVtxoSend(status(), destination(), 20_000)).rejects.toSatisfy(isVtxoReservedReplaceError)
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)?.stage).toBe('reserved')
    clearPersistedVtxoSpend('vault-a')
  })

  it('aborts a reserved operation through the server before clearing it', async () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      reservationExpires: '2099-08-20T00:02:00Z',
      ...RESERVATION_FACTS,
      stage: 'reserved',
    })
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_2,
      bundleDigest: '22'.repeat(32),
      destAddress: destination(),
      amountSats: 20_000,
      arkTxid: 'bb'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    })
    const abort = vi.spyOn(vaultCosignerClient.spending, 'abort').mockResolvedValue({
      operationId: OP_1,
      state: 'aborted',
    })
    await abortPersistedVtxoSpend(
      loadPersistedVtxoSpendById('vault-a', OP_1)!,
      status(),
      hex.decode('01'.padStart(64, '0')),
    )
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OP_1, vaultId: 'vault-a', purpose: 'spend' }),
    )
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)).toBeUndefined()
    expect(loadPersistedVtxoSpendById('vault-a', OP_2)?.stage).toBe('authorized')
    abort.mockRestore()
    clearPersistedVtxoSpend('vault-a')
  })

  it('never aborts a signed operation from local replace authority', async () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    })
    const abort = vi.spyOn(vaultCosignerClient.spending, 'abort')
    await expect(
      abortPersistedVtxoSpend(loadPersistedVtxoSpend('vault-a')!, status(), hex.decode('01'.padStart(64, '0'))),
    ).rejects.toBeInstanceOf(VtxoLivePendingError)
    expect(abort).not.toHaveBeenCalled()
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)?.stage).toBe('authorized')
    abort.mockRestore()
    clearPersistedVtxoSpend('vault-a')
  })

  it('does not call credentials.get while previewing a fee quote', async () => {
    const getCredential = vi.fn()
    const original = navigator.credentials
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: getCredential } })
    try {
      await expect(previewVaultVtxoSend(status(), destination(), 12_000)).resolves.toEqual({
        operationId: '',
        bundleDigest: '',
        destAddress: destination(),
        amountSats: 12_000,
        feeSats: 0,
        feePolicyDigest: '',
        reservationExpires: '',
        changeSats: 0,
      })
      expect(getCredential).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(navigator, 'credentials', { configurable: true, value: original })
      else Reflect.deleteProperty(navigator, 'credentials')
    }
  })

  it('restores the exact persisted quote so an accepted payment can resume after reload', async () => {
    clearPersistedVtxoSpend('vault-a')
    const pending = {
      ...sdkReservedPending(),
      stage: 'authorized' as const,
      operatorSubmitAttempted: true,
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    }
    persistVtxoSpend(pending)
    await expect(previewVaultVtxoSend(status(), pending.destAddress, pending.amountSats)).resolves.toMatchObject({
      operationId: pending.operationId,
      bundleDigest: pending.bundleDigest,
      destAddress: pending.destAddress,
      amountSats: pending.amountSats,
      feeSats: pending.feeSats,
      changeSats: pending.changeSats,
    })
    clearPersistedVtxoSpend('vault-a')
  })

  it('does not let Send anyway or a different amount erase a signed operation', async () => {
    clearPersistedVtxoSpend('vault-a')
    persistVtxoSpend({
      vaultId: 'vault-a',
      operationId: OP_1,
      bundleDigest: '11'.repeat(32),
      destAddress: destination(),
      amountSats: 12_000,
      arkTxid: 'aa'.repeat(32),
      ...RESERVATION_FACTS,
      stage: 'authorized',
      authorizedPsbt: 'cHNidP9a',
      authorizedPendingProof: 'cHNidP9p',
    })
    await expect(previewVaultVtxoSend(status(), destination(), 20_000, { replaceExisting: true })).rejects.toSatisfy(
      isVtxoLivePendingError,
    )
    expect(loadPersistedVtxoSpendById('vault-a', OP_1)?.stage).toBe('authorized')
    expect(listPersistedVtxoSpends('vault-a')).toHaveLength(1)
    clearPersistedVtxoSpend('vault-a')
  })
})

describe('independent Spending journal archives', () => {
  const locks = { request: async <T>(_name: string, _options: unknown, run: (lock: unknown) => Promise<T>) => run({}) }
  it('preserves exact SDK reservation data and ambiguity while refusing corrupt or excess records', async () => {
    localStorage.clear()
    const pending = { ...sdkReservedPending(), operatorSubmitAttempted: true }
    persistVtxoSpend(pending)
    const journal = await exportSpendingRecoveryJournal(status(), locks)
    expect(journal.operations).toEqual([pending])
    localStorage.clear()
    await restoreSpendingRecoveryJournal(status(), journal, locks)
    expect(loadPersistedVtxoSpend(status().vaultId)).toEqual(pending)
    expect(() =>
      validateSpendingRecoveryJournal(status(), { ...journal, operations: Array(33).fill(pending) }),
    ).toThrow()
    expect(() =>
      validateSpendingRecoveryJournal(status(), { ...journal, operations: [{ ...pending, amountSats: 13000 }] }),
    ).toThrow()
    localStorage.setItem(
      vtxoSpendJournalKey(status().vaultId),
      JSON.stringify({ version: 1, operations: [pending, { broken: true }] }),
    )
    await expect(exportSpendingRecoveryJournal(status(), locks)).rejects.toThrow()
  })
  it('retains resolved history and does not reactivate a cleared operation from an old backup', async () => {
    localStorage.clear()
    persistVtxoSpend(sdkReservedPending())
    const old = await exportSpendingRecoveryJournal(status(), locks)
    clearPersistedVtxoSpend(status().vaultId, OP_1)
    const restored = await restoreSpendingRecoveryJournal(status(), old, locks)
    expect(restored.operations).toEqual([])
    expect(restored.resolved?.[0].operationId).toBe(OP_1)
    expect(loadPersistedVtxoSpend(status().vaultId)).toBeUndefined()
  })
  it('preserves a local pending operation when an imported backup lacks it, and rejects conflicts before writes', async () => {
    localStorage.clear()
    const pending = sdkReservedPending()
    persistVtxoSpend(pending)
    await restoreSpendingRecoveryJournal(status(), { version: 1, vaultId: status().vaultId, operations: [] }, locks)
    const previous = localStorage.getItem(vtxoSpendJournalKey(status().vaultId))
    await expect(
      restoreSpendingRecoveryJournal(
        status(),
        { version: 1, vaultId: status().vaultId, operations: [{ ...pending, bundleDigest: 'ff'.repeat(32) }] },
        locks,
      ),
    ).rejects.toThrow('Conflicting')
    expect(localStorage.getItem(vtxoSpendJournalKey(status().vaultId))).toBe(previous)
  })
})
