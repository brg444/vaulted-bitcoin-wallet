import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  ArkAddress,
  ChainTxType,
  ChainedTxType,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultRequestError } from '../api'
import { POLICY_VERSION } from '../constants'
import { networkPins } from '../networkPins'
import { LEDGER_NATIVE_TEMPLATE } from '../program/ledgerNativeKeys'
import type { VaultStatus } from '../types'
import { vaultCosignerClient } from '../cosignerClient'
import { readCommittedRecoveryCoverage, type CommittedRecoveryCoverage } from '../recovery/committedCoverage'
import { packExitArchive, type ExitArchive } from '../recovery/exitArchive'
import { retainFinalizationRecovery } from '../recovery/finalization'
import { recoveryFileStore } from '../recovery/fileStore'
import { fetchVaultWalletVtxoSnapshot } from './walletWorker'
import { vaultExitRepository } from './exitRepository'
import { VaultPolicyV1Script } from './script'
import { buildReservedVtxoSpend, createPhoneSignedPendingProof, type PersistedVtxoSpend } from './spendingTransaction'
import golden from './testdata/vault-policy-v1-tree.json'
import {
  acknowledgeSettledVtxoSpends,
  acknowledgeSpendingVtxoRecovery,
  reconcilePersistedVtxoSpend,
  sendVaultVtxo,
  previewVaultVtxoSend,
  vtxoSpendIsLivePending,
  vtxoSpendIsAbortable,
  type VtxoOperationView,
} from './spend'
import { loadPersistedVtxoSpendById, persistVtxoSpend, restoreSpendingRecoveryJournal } from './spendingJournal'

// Pin this fixture release to the disposable Operator key used to sign the
// real transactions. Capture and readback exercise the same identity checks.
vi.mock('../networkPins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../networkPins')>()
  const { default: fixture } = await import('./testdata/vault-policy-v1-tree.json')
  return {
    ...actual,
    networkPins: (network: string) => ({
      ...actual.networkPins(network),
      operatorSignerPub: `02${fixture.fixtures.arkdServerPub}`,
    }),
  }
})
vi.mock('../recovery/committedCoverage', () => ({ readCommittedRecoveryCoverage: vi.fn() }))
vi.mock('./walletWorker', () => ({ fetchVaultWalletVtxoSnapshot: vi.fn() }))

const OP = '33'.repeat(16)
const FEE_POLICY = 'aa'.repeat(32)
const PHONE = SingleKey.fromPrivateKey(hex.decode('01'.padStart(64, '0')))
const VAULT_KEY = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
const OPERATOR = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
const ROGUE = SingleKey.fromPrivateKey(hex.decode('09'.padStart(64, '0')))

function retirementStatus(vaultId: string): VaultStatus {
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
    vaultId,
    templateVersion: LEDGER_NATIVE_TEMPLATE,
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
    phoneBip340Pub: `02${golden.fixtures.userPub}`,
    phoneDirectP256: `02${golden.fixtures.exitDevicePub}`,
    externalOwnerWalletPub: `02${golden.fixtures.exitHardwarePub}`,
    vtxoVaultCosignerPub: `02${golden.fixtures.vtxoVaultCosignerPub}`,
    vtxoDelegatePub: `02${golden.fixtures.delegatePub}`,
    vtxoExitDelay: 4608,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: address.encode(),
    spendingArkScript: hex.encode(script.pkScript),
  } as unknown as VaultStatus
}

function destination(): string {
  return new ArkAddress(
    hex.decode(golden.fixtures.arkdServerPub),
    hex.decode(golden.fixtures.exitHardwarePub),
    'tark',
  ).encode()
}

/** Fully signed Spending successor built with the retained covenant keys:
 * phone scalar 1, vault scalar 2 and operator scalar 4 match the golden
 * enrollment pubs, so existing signature validators verify for real. */
async function signedFinalizedOp(vaultId: string, changeSats = 7_500) {
  const status = retirementStatus(vaultId)
  const scriptHex = String(status.spendingArkScript)
  const inputSats = 12_000 + 500 + changeSats
  const parent = new Transaction({ version: 2 })
  parent.addInput({ txid: 'cc'.repeat(32), index: 0 })
  parent.addOutput({ amount: BigInt(inputSats), script: hex.decode(scriptHex) })
  const zeroChange = changeSats === 0
  const reservation = {
    operationId: OP,
    bundleDigest: '44'.repeat(32),
    reservationExpires: '2099-08-20T00:02:00Z',
    inputs: [{ txid: parent.id, vout: 0, valueSats: inputSats, scriptHex }],
    changeAddress: zeroChange ? '' : status.spendingArkAddress!,
    changeScript: zeroChange ? '' : scriptHex,
    changeSats,
    ...(zeroChange ? {} : { changeVout: 1 }),
    destScript: `5120${golden.fixtures.exitHardwarePub}`,
    feeSats: 500,
    feePolicyDigest: FEE_POLICY,
    checkpointTapscript: networkPins('mutinynet').checkpointTapscript,
  }
  const built = buildReservedVtxoSpend(status, reservation, 12_000, destination(), FEE_POLICY)
  const authorizedArk = await VAULT_KEY.sign(await PHONE.sign(built.arkTx))
  const operatorArk = await OPERATOR.sign(authorizedArk)
  const operatorCheckpointPsbts: string[] = []
  const checkpointPsbts: string[] = []
  for (const checkpoint of built.checkpoints) {
    const operatorSigned = await OPERATOR.sign(checkpoint)
    operatorCheckpointPsbts.push(base64.encode(operatorSigned.toPSBT()))
    checkpointPsbts.push(base64.encode((await VAULT_KEY.sign(await PHONE.sign(operatorSigned))).toPSBT()))
  }
  const pending: PersistedVtxoSpend = {
    vaultId,
    operationId: OP,
    bundleDigest: '44'.repeat(32),
    destAddress: destination(),
    amountSats: 12_000,
    arkTxid: built.arkTx.id,
    reservationExpires: reservation.reservationExpires,
    checkpointTapscript: reservation.checkpointTapscript,
    feePolicyDigest: FEE_POLICY,
    feeSats: 500,
    changeSats,
    ...(zeroChange ? {} : { changeVout: 1 }),
    unsignedArkPsbt: base64.encode(built.arkTx.toPSBT()),
    unsignedCheckpointPsbts: built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    authorizedPsbt: base64.encode(authorizedArk.toPSBT()),
    authorizedPendingProof: base64.encode(
      (
        await VAULT_KEY.sign(
          Transaction.fromPSBT(
            base64.decode(
              await createPhoneSignedPendingProof(
                built.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
                PHONE,
                hex.decode(golden.fixtures.userPub),
              ),
            ),
          ),
        )
      ).toPSBT(),
    ),
    operatorArkPsbt: base64.encode(operatorArk.toPSBT()),
    operatorCheckpointPsbts,
    checkpointPsbts,
    sdkBundleVersion: 1,
    reservedInputs: reservation.inputs.map((input) => ({ ...input })),
    reservedOutputs: [
      { scriptHex: reservation.destScript.toLowerCase(), amountSats: 12_000 },
      ...(zeroChange ? [] : [{ scriptHex, amountSats: changeSats }]),
    ],
    stage: 'operator-finalized',
  }
  const checkpointId = Transaction.fromPSBT(base64.decode(checkpointPsbts[0])).id
  return { status, parent, built, pending, checkpointId }
}

function finalizationArchive(
  vaultId: string,
  pending: PersistedVtxoSpend,
  parent: Transaction,
  checkpointId: string,
  checkpointPsbt: string,
  mutate?: (archive: {
    version: 1
    descriptorHash: string
    capturedAt: string
    info: string
    coins: string
    branches: Record<string, { txid: string; type: ChainTxType; expiresAt: string; spends: string[] }[]>
    transactions: Record<string, string>
  }) => void,
) {
  const pins = networkPins('mutinynet')
  const status = retirementStatus(vaultId)
  const scriptHex = String(status.spendingArkScript)
  const hasChange = (pending.changeSats ?? 0) > 0 && pending.changeVout !== undefined
  const inputBranches = Object.fromEntries(
    (pending.reservedInputs ?? []).map((input) => [
      `${input.txid}:${input.vout}`,
      [
        { txid: 'cc'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] as string[] },
        { txid: parent.id, type: ChainTxType.TREE, expiresAt: '0', spends: ['cc'.repeat(32)] },
      ],
    ]),
  )
  const archive = {
    version: 1 as const,
    descriptorHash: vaultId,
    capturedAt: new Date().toISOString(),
    info: packExitArchive({
      network: 'mutinynet',
      signerPubkey: pins.operatorSignerPub,
      checkpointTapscript: pins.checkpointTapscript,
      forfeitPubkey: pins.checkpointForfeitPub,
    }),
    coins: packExitArchive(
      hasChange
        ? [
            {
              txid: pending.arkTxid,
              vout: pending.changeVout,
              value: pending.changeSats,
              script: scriptHex,
              isSpent: false,
              createdAt: new Date(),
            },
          ]
        : [],
    ),
    branches: {
      ...inputBranches,
      ...(hasChange
        ? {
            [`${pending.arkTxid}:${pending.changeVout}`]: [
              { txid: 'cc'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] as string[] },
              { txid: parent.id, type: ChainTxType.TREE, expiresAt: '0', spends: ['cc'.repeat(32)] },
              { txid: checkpointId, type: ChainTxType.CHECKPOINT, expiresAt: '0', spends: [parent.id] },
              { txid: pending.arkTxid, type: ChainTxType.ARK, expiresAt: '0', spends: [checkpointId] },
            ],
          }
        : {}),
    },
    transactions: {
      [parent.id]: base64.encode(parent.toPSBT()),
      [checkpointId]: checkpointPsbt,
      [pending.arkTxid]: pending.operatorArkPsbt!,
    } as Record<string, string>,
  }
  mutate?.(archive)
  return archive
}

function finalizedView(pending: PersistedVtxoSpend, overrides: Partial<VtxoOperationView> = {}): VtxoOperationView {
  return {
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    state: 'finalized',
    arkTxid: pending.arkTxid,
    feeSats: pending.feeSats,
    feePolicyDigest: pending.feePolicyDigest,
    changeSats: pending.changeSats,
    changeVout: pending.changeVout,
    ...overrides,
  }
}

function coverageFor(vaultId: string, pending: PersistedVtxoSpend) {
  const status = retirementStatus(vaultId)
  const hasChange = (pending.changeSats ?? 0) > 0 && pending.changeVout !== undefined
  return {
    vaultId,
    network: 'mutinynet',
    descriptorHash: vaultId,
    fileDigest: `digest-${vaultId}`,
    outputs: hasChange
      ? [
          {
            txid: pending.arkTxid,
            vout: pending.changeVout as number,
            value: pending.changeSats as number,
            script: status.spendingArkScript as string,
          },
        ]
      : [],
  }
}

function installImmediateLock() {
  const original = (navigator as Navigator & { locks?: unknown }).locks
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

let vaultCounter = 0

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Seed the finalized view, history and coverage around a signed fixture. */
function agreeEvidence(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  viewOverrides: Partial<VtxoOperationView> = {},
) {
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue({
    network: 'mutinynet',
    signerPubkey: networkPins('mutinynet').operatorSignerPub,
    checkpointTapscript: networkPins('mutinynet').checkpointTapscript,
    forfeitPubkey: networkPins('mutinynet').checkpointForfeitPub,
    fees: { intentFee: {} },
  } as never)
  vi.spyOn(vaultCosignerClient.spending, 'operation').mockResolvedValue(finalizedView(pending, viewOverrides) as never)
  vi.mocked(fetchVaultWalletVtxoSnapshot).mockResolvedValue({
    history: [
      { account: 'spend', type: 'sent', txid: pending.arkTxid, amount: pending.amountSats + (pending.feeSats ?? 0) },
    ],
  } as never)
  vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor(status.vaultId, pending) as never)
}

async function acknowledgeCase(
  changeSats = 7_500,
  seed: (f: Awaited<ReturnType<typeof signedFinalizedOp>>) => Promise<void> | void = async (f) => {
    await recoveryFileStore(
      `finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`,
      finalizationArchive(f.status.vaultId, f.pending, f.parent, f.checkpointId, f.pending.checkpointPsbts![0]),
    )
  },
) {
  const vaultId = `vault-retire-${++vaultCounter}`
  const f = await signedFinalizedOp(vaultId, changeSats)
  persistVtxoSpend(f.pending)
  agreeEvidence(f.status, f.pending)
  await seed(f)
  return f
}

describe('shared Spending retirement predicate', () => {
  it.each([
    { changeSats: 7_500, mutation: 'none' },
    { changeSats: 0, mutation: 'none' },
    { changeSats: 0, mutation: 'missing-root' },
    { changeSats: 0, mutation: 'false-parent' },
  ])('validates captured input ancestry with $changeSats change and $mutation', async ({ changeSats, mutation }) => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase(changeSats, async (f) => {
        vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
          chain: [
            { txid: 'cc'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] },
            { txid: f.parent.id, type: ChainTxType.TREE, expiresAt: '0', spends: ['cc'.repeat(32)] },
          ],
        })
        vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockResolvedValue({
          txs: [base64.encode(f.parent.toPSBT())],
        })
        await retainFinalizationRecovery(f.status, f.pending)
      })
      const key = `finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`
      const archive = await recoveryFileStore<ExitArchive>(key)
      expect(archive?.transactions[f.pending.arkTxid]).toBe(f.pending.operatorArkPsbt)
      expect(archive?.branches[`${f.parent.id}:0`].some((node) => node.txid === f.parent.id)).toBe(true)
      if (mutation === 'missing-root') {
        delete archive!.transactions[f.parent.id]
        archive!.branches[`${f.parent.id}:0`] = [
          { txid: 'cc'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] },
        ]
      } else if (mutation === 'false-parent') {
        archive!.branches[`${f.parent.id}:0`] = [
          { txid: 'dd'.repeat(32), type: ChainTxType.COMMITMENT, expiresAt: '0', spends: [] },
          { txid: f.parent.id, type: ChainTxType.TREE, expiresAt: '0', spends: ['dd'.repeat(32)] },
        ]
      }
      if (mutation !== 'none') await recoveryFileStore(key, archive)
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(mutation === 'none')
      expect(Boolean(loadPersistedVtxoSpendById(f.status.vaultId, OP))).toBe(mutation !== 'none')
    } finally {
      restoreLock()
    }
  })

  it('validates the signed fixture through the retained validators', async () => {
    const vaultId = `vault-retire-${++vaultCounter}`
    const f = await signedFinalizedOp(vaultId)
    const { validateExitArchive } = await import('../recovery/exitArchive')
    const { createVaultSdkOperationValidation, checkpointPairsInCanonicalOrder, xOnly } = await import(
      './spendingTransaction'
    )
    expect(() =>
      validateExitArchive(
        finalizationArchive(vaultId, f.pending, f.parent, f.checkpointId, f.pending.checkpointPsbts![0]),
        {
          network: 'mutinynet',
          scriptPubKey: String(f.status.spendingArkScript),
          descriptorHash: vaultId,
        },
      ),
    ).not.toThrow()
    const operatorPub = xOnly(golden.fixtures.arkdServerPub, 'Operator signer pubkey')
    const validation = createVaultSdkOperationValidation(
      f.status,
      Transaction.fromPSBT(base64.decode(f.pending.unsignedArkPsbt!)),
      operatorPub,
    )
    expect(() =>
      validation.assertArkTransaction(
        Transaction.fromPSBT(base64.decode(f.pending.operatorArkPsbt!)),
        'operator-signed',
      ),
    ).not.toThrow()
    const pairs = checkpointPairsInCanonicalOrder(
      f.pending.unsignedCheckpointPsbts!,
      f.pending.checkpointPsbts!,
      'Recovery',
    )
    for (const { original, candidate } of pairs)
      expect(() => validation.assertCheckpointTransaction(candidate, original, 'vault-authorized')).not.toThrow()
  })

  it('retires only when receipt, archive, history and coverage agree', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      await expect(
        acknowledgeSpendingVtxoRecovery(f.status, OP, {
          ...(coverageFor(f.status.vaultId, f.pending) as CommittedRecoveryCoverage),
          fileDigest: `digest-${f.status.vaultId}`,
        }),
      ).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it.each([
    ['different operation id', { operationId: '55'.repeat(16) }],
    ['different bundle digest', { bundleDigest: '66'.repeat(32) }],
    ['different transaction', { arkTxid: 'ff'.repeat(32) }],
    ['different fee', { feeSats: 501 }],
    ['different change', { changeSats: 7_499 }],
  ])('retains the journal for a receipt with %s', async (_label, changes) => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      vi.mocked(vaultCosignerClient.spending.operation).mockResolvedValue({
        ...finalizedView(f.pending),
        ...changes,
      } as never)
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
      const retained = loadPersistedVtxoSpendById(f.status.vaultId, OP)!
      expect(retained.stage).toBe('operator-finalized')
      expect(retained.receiptFinalized).not.toBe(true)
      expect(vtxoSpendIsLivePending(retained)).toBe(true)
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when the stored finalization archive is missing or malformed', async () => {
    const restoreLock = installImmediateLock()
    try {
      const missing = await acknowledgeCase(7_500, async () => {})
      await expect(acknowledgeSpendingVtxoRecovery(missing.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(missing.status.vaultId, OP)?.stage).toBe('operator-finalized')
      const malformed = await acknowledgeCase(7_500, async (f) => {
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, {
          transactions: { [f.pending.arkTxid]: 'cHNidP9ark' },
        })
      })
      await expect(acknowledgeSpendingVtxoRecovery(malformed.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(malformed.status.vaultId, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when ancestry is stripped or the binding is foreign', async () => {
    const restoreLock = installImmediateLock()
    try {
      const stripped = await acknowledgeCase(7_500, async (f) => {
        const archive = finalizationArchive(
          f.status.vaultId,
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
          (draft) => {
            draft.branches = {}
          },
        )
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(stripped.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(stripped.status.vaultId, OP)?.stage).toBe('operator-finalized')
      const foreign = await acknowledgeCase(7_500, async (f) => {
        const archive = finalizationArchive(
          'other-vault',
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(foreign.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(foreign.status.vaultId, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when required signatures are missing or substituted', async () => {
    const restoreLock = installImmediateLock()
    try {
      const unsigned = await acknowledgeCase(7_500, async (f) => {
        const bare = Transaction.fromPSBT(base64.decode(f.pending.unsignedArkPsbt!))
        const archive = finalizationArchive(
          f.status.vaultId,
          { ...f.pending, operatorArkPsbt: undefined },
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        archive.transactions[f.pending.arkTxid] = base64.encode(bare.toPSBT())
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(unsigned.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(unsigned.status.vaultId, OP)?.stage).toBe('operator-finalized')
      const substituted = await acknowledgeCase(7_500, async (f) => {
        const unsigned = Transaction.fromPSBT(base64.decode(f.pending.unsignedArkPsbt!))
        const rogueArk = await ROGUE.sign(await VAULT_KEY.sign(await PHONE.sign(unsigned)))
        const journalBytes = base64.encode(rogueArk.toPSBT())
        persistVtxoSpend({ ...f.pending, operatorArkPsbt: journalBytes })
        const archive = finalizationArchive(
          f.status.vaultId,
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        archive.transactions[f.pending.arkTxid] = journalBytes
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(substituted.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(substituted.status.vaultId, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when archived checkpoints lack valid operator signatures', async () => {
    const restoreLock = installImmediateLock()
    try {
      for (const sign of ['unsigned', 'wrong-operator'] as const) {
        const f = await acknowledgeCase()
        const unsigned = Transaction.fromPSBT(base64.decode(f.pending.unsignedCheckpointPsbts![0]))
        const rogueBytes =
          sign === 'unsigned'
            ? base64.encode(unsigned.toPSBT())
            : base64.encode((await ROGUE.sign(await VAULT_KEY.sign(await PHONE.sign(unsigned)))).toPSBT())
        const archive = finalizationArchive(
          f.status.vaultId,
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        archive.transactions[f.checkpointId] = rogueBytes
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
        await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
        expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('operator-finalized')
      }
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when repository checkpoints lack valid operator signatures', async () => {
    const restoreLock = installImmediateLock()
    try {
      for (const sign of ['unsigned', 'wrong-operator'] as const) {
        const f = await acknowledgeCase()
        persistVtxoSpend({ ...f.pending, operatorArkPsbt: undefined, checkpointPsbts: undefined, stage: 'authorized' })
        const unsigned = Transaction.fromPSBT(base64.decode(f.pending.unsignedCheckpointPsbts![0]))
        const checkpointBytes =
          sign === 'unsigned'
            ? base64.encode(unsigned.toPSBT())
            : base64.encode((await ROGUE.sign(await VAULT_KEY.sign(await PHONE.sign(unsigned)))).toPSBT())
        const repository = vaultExitRepository(f.status.vaultId, f.status.network)
        try {
          await repository.upsertVirtualTxs([
            {
              txid: f.pending.arkTxid,
              psbt: f.pending.operatorArkPsbt ?? null,
              expiresAt: null,
              type: ChainedTxType.Ark,
            },
            { txid: f.parent.id, psbt: base64.encode(f.parent.toPSBT()), expiresAt: null, type: ChainedTxType.Tree },
            { txid: f.checkpointId, psbt: checkpointBytes, expiresAt: null, type: ChainedTxType.Checkpoint },
            { txid: 'cc'.repeat(32), psbt: null, expiresAt: null, type: ChainedTxType.Commitment },
          ])
        } finally {
          await repository[Symbol.asyncDispose]()
        }
        await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
        expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('authorized')
      }
    } finally {
      restoreLock()
    }
  })

  it('retains the journal when input ancestry is missing, including zero-change archives', async () => {
    const restoreLock = installImmediateLock()
    try {
      const zeroChange = await acknowledgeCase(0, async (f) => {
        const archive = finalizationArchive(
          f.status.vaultId,
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        delete archive.transactions[f.parent.id]
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(zeroChange.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(zeroChange.status.vaultId, OP)?.stage).toBe('operator-finalized')
      const noInputBranches = await acknowledgeCase(7_500, async (f) => {
        const archive = finalizationArchive(
          f.status.vaultId,
          f.pending,
          f.parent,
          f.checkpointId,
          f.pending.checkpointPsbts![0],
        )
        for (const key of Object.keys(archive.branches)) {
          if (key !== `${f.pending.arkTxid}:${f.pending.changeVout}`) delete archive.branches[key]
        }
        await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.pending.arkTxid}`, archive)
      })
      await expect(acknowledgeSpendingVtxoRecovery(noInputBranches.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(noInputBranches.status.vaultId, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('retains the journal on missing history, coverage or change successor', async () => {
    const restoreLock = installImmediateLock()
    try {
      const cases: ((f: Awaited<ReturnType<typeof signedFinalizedOp>>) => void)[] = [
        () => vi.mocked(fetchVaultWalletVtxoSnapshot).mockResolvedValue({ history: [] } as never),
        () => vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(null),
        (f) =>
          vi
            .mocked(readCommittedRecoveryCoverage)
            .mockResolvedValue({ ...coverageFor(f.status.vaultId, f.pending), outputs: [] } as never),
      ]
      for (const mutate of cases) {
        const f = await acknowledgeCase()
        mutate(f)
        await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
        expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('operator-finalized')
      }
    } finally {
      restoreLock()
    }
  })

  it('rejects a mismatched evidence digest and a journal rewritten mid-flight', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      const coverage = coverageFor(f.status.vaultId, f.pending)
      await expect(
        acknowledgeSpendingVtxoRecovery(f.status, OP, { ...coverage, fileDigest: 'other-digest' }),
      ).resolves.toBe(false)
      vi.mocked(readCommittedRecoveryCoverage).mockImplementation(async () => {
        persistVtxoSpend({ ...f.pending, reservationExpires: '2030-01-01T00:00:00Z' })
        return coverageFor(f.status.vaultId, f.pending) as never
      })
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.reservationExpires).toBe('2030-01-01T00:00:00Z')
    } finally {
      restoreLock()
    }
  })

  it('retires a zero-change successor without requiring a change output', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase(0)
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it('retires through the exit repository when the operation finalized without a local operator result', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      persistVtxoSpend({ ...f.pending, operatorArkPsbt: undefined, checkpointPsbts: undefined, stage: 'authorized' })
      const repository = vaultExitRepository(f.status.vaultId, f.status.network)
      try {
        await repository.upsertVirtualTxs([
          {
            txid: f.pending.arkTxid,
            psbt: f.pending.operatorArkPsbt ?? null,
            expiresAt: null,
            type: ChainedTxType.Ark,
          },
          { txid: f.parent.id, psbt: base64.encode(f.parent.toPSBT()), expiresAt: null, type: ChainedTxType.Tree },
          {
            txid: f.checkpointId,
            psbt: f.pending.checkpointPsbts![0],
            expiresAt: null,
            type: ChainedTxType.Checkpoint,
          },
          { txid: 'cc'.repeat(32), psbt: null, expiresAt: null, type: ChainedTxType.Commitment },
        ])
      } finally {
        await repository[Symbol.asyncDispose]()
      }
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)).toBeUndefined()
    } finally {
      restoreLock()
    }
  })

  it('retains when the repository successor is missing, unsigned or orphaned', async () => {
    const restoreLock = installImmediateLock()
    try {
      for (const seed of ['missing', 'unsigned', 'orphaned'] as const) {
        const f = await acknowledgeCase()
        persistVtxoSpend({ ...f.pending, operatorArkPsbt: undefined, checkpointPsbts: undefined, stage: 'authorized' })
        const repository = vaultExitRepository(f.status.vaultId, f.status.network)
        try {
          if (seed === 'unsigned') {
            await repository.upsertVirtualTxs([
              {
                txid: f.pending.arkTxid,
                psbt: f.pending.unsignedArkPsbt ?? null,
                expiresAt: null,
                type: ChainedTxType.Ark,
              },
            ])
          } else if (seed === 'orphaned') {
            await repository.upsertVirtualTxs([
              {
                txid: f.pending.arkTxid,
                psbt: f.pending.operatorArkPsbt ?? null,
                expiresAt: null,
                type: ChainedTxType.Ark,
              },
            ])
          }
        } finally {
          await repository[Symbol.asyncDispose]()
        }
        await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
        expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('authorized')
      }
    } finally {
      restoreLock()
    }
  })

  it('retires on a later capture after missing evidence', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(null)
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('operator-finalized')
      vi.mocked(readCommittedRecoveryCoverage).mockResolvedValue(coverageFor(f.status.vaultId, f.pending) as never)
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(true)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)).toBeUndefined()
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP)).resolves.toBe(false)
    } finally {
      restoreLock()
    }
  })

  it('aborts acknowledgment on a cancelled caller without retiring', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      const controller = new AbortController()
      controller.abort()
      await expect(acknowledgeSpendingVtxoRecovery(f.status, OP, undefined, controller.signal)).rejects.toThrow()
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)?.stage).toBe('operator-finalized')
    } finally {
      restoreLock()
    }
  })

  it('settles only finalized operations and skips pre-reserve records', async () => {
    const restoreLock = installImmediateLock()
    try {
      const f = await acknowledgeCase()
      persistVtxoSpend({
        vaultId: f.status.vaultId,
        operationId: '55'.repeat(16),
        bundleDigest: '',
        destAddress: 'tb1qdestination',
        amountSats: 1_000,
        arkTxid: '',
        stage: 'pre-reserve',
      })
      agreeEvidence(f.status, f.pending)
      await expect(acknowledgeSettledVtxoSpends(f.status)).resolves.toBe(1)
      expect(loadPersistedVtxoSpendById(f.status.vaultId, OP)).toBeUndefined()
      expect(loadPersistedVtxoSpendById(f.status.vaultId, '55'.repeat(16))?.stage).toBe('pre-reserve')
    } finally {
      restoreLock()
    }
  })

  it('reconcile reports the service receipt while retaining the journal without evidence', async () => {
    const restoreLock = installImmediateLock()
    try {
      const vaultId = `vault-retire-${++vaultCounter}`
      const f = await signedFinalizedOp(vaultId)
      persistVtxoSpend(f.pending)
      vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue({
        network: 'mutinynet',
        signerPubkey: networkPins('mutinynet').operatorSignerPub,
        checkpointTapscript: networkPins('mutinynet').checkpointTapscript,
        fees: { intentFee: {} },
      } as never)
      vi.spyOn(vaultCosignerClient.spending, 'operation').mockResolvedValue(finalizedView(f.pending) as never)
      await expect(reconcilePersistedVtxoSpend(f.status)).resolves.toEqual({
        kind: 'receipt-finalized',
        txid: f.pending.arkTxid,
        operationId: OP,
      })
      const retained = loadPersistedVtxoSpendById(vaultId, OP)!
      expect(retained).toMatchObject({ ...f.pending, stage: 'operator-finalized', receiptFinalized: true })
      expect(vtxoSpendIsLivePending(retained)).toBe(false)
      expect(vtxoSpendIsAbortable({ ...retained, stage: 'reserved' })).toBe(false)
      await expect(previewVaultVtxoSend(f.status, retained.destAddress, retained.amountSats)).resolves.toMatchObject({
        operationId: '',
        bundleDigest: '',
      })
      // Restoring the recovery bytes on another device requires a fresh receipt.
      localStorage.clear()
      await restoreSpendingRecoveryJournal(f.status, { version: 1, vaultId, operations: [retained] })
      const restored = loadPersistedVtxoSpendById(vaultId, OP)!
      expect(restored.checkpointPsbts).toEqual(retained.checkpointPsbts)
      expect(restored.receiptFinalized).toBeUndefined()
      expect(vtxoSpendIsLivePending(restored)).toBe(true)
    } finally {
      restoreLock()
    }
  })

  it('keeps a live operation on a lost reservation response instead of clearing it', async () => {
    const restoreLock = installImmediateLock()
    try {
      const vaultId = `vault-retire-${++vaultCounter}`
      const f = await signedFinalizedOp(vaultId)
      const reservationExpires = new Date(Date.now() + 3600_000).toISOString()
      persistVtxoSpend({
        ...f.pending,
        stage: 'authorized',
        reservationExpires,
        authorizedPsbt: f.pending.authorizedPsbt,
        authorizedPendingProof: f.pending.authorizedPendingProof,
      })
      vi.spyOn(vaultCosignerClient.spending, 'operation').mockRejectedValue(new VaultRequestError('gone', 404))
      const quote = {
        operationId: OP,
        bundleDigest: f.pending.bundleDigest,
        destAddress: f.pending.destAddress,
        amountSats: f.pending.amountSats,
        feeSats: f.pending.feeSats!,
        feePolicyDigest: f.pending.feePolicyDigest!,
        reservationExpires,
        changeSats: f.pending.changeSats!,
        changeVout: 1,
      }
      const unlocker = () => ({ unlock: async () => ({}), dispose: () => {} })
      await expect(sendVaultVtxo({} as never, f.status, quote, unlocker as never)).rejects.toThrow()
      expect(loadPersistedVtxoSpendById(vaultId, OP)?.stage).toBe('authorized')
    } finally {
      restoreLock()
    }
  })
})
