import * as delegation from './vtxo/guardianRenewal'
import * as spendModule from './vtxo/spend'
import * as apiModule from './api'
import * as streamModule from './vtxo/settlementEventSource'
import { humanizeVaultError } from './humanize'
import { writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import {
  Wallet,
  Batch,
  SettlementEventType,
  RestArkProvider,
  EsploraProvider,
  RestIndexerProvider,
  SingleKey,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  Transaction,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { sharedSpendingRecoveryFixture } from './recovery/testdata/helpers'
import { ledgerRecoveryFixture } from './recovery/testdata/ledger'
import { sharedSpendingEnrollment, sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { scalarSecret } from './program/fixtures'
import {
  savingsSetupDigest,
  validateBitcoinOutputs,
  saveBitcoinPayment,
  readSpendingBitcoin,
  validateSpendingBitcoinPlan,
  type BitcoinPaymentJournal,
  type SpendingBitcoinPlan,
} from './spendingBitcoinStore'
import { validateExitArchive, exitArchiveProviders } from './recovery/exitArchive'
import { vaultRecoveryBinding } from './vtxo/recoveryArchive'
import { registerVaultPolicyV1ContractHandler, vaultPolicyV1Contract } from './vtxo/contractHandler'
import {
  bitcoinPaymentClient,
  sendSpendingToBitcoin,
  checkSpendingBitcoin,
  cancelSpendingBitcoin,
  scopeBitcoinBatchFailures,
  normalizeBitcoinResponse,
} from './spendingBitcoinFunding'

async function bitcoinFixture(count = 1, light = false) {
  const source = light ? sharedSpendingRecoveryFixture() : await ledgerRecoveryFixture(false, 'mainnet')
  const spending = spendModule.vaultPolicyV1ScriptFromStatus(source.status)
  const coin = JSON.parse(source.archive.spending.coins)[0]
  // Public deterministic key from the shared Spending vector, or the Ledger fixture phone key.
  const phoneSecret = light ? new Uint8Array(32).fill(7) : scalarSecret(3)
  expect(hex.encode(schnorr.getPublicKey(phoneSecret))).toBe(source.status.phoneBip340Pub!.slice(2))
  const outputs = Array.from({ length: count }, () => ({
    script: '0014' + '43'.repeat(20),
    amountSats: count === 2 ? 500 : 1500,
  }))
  const plan: SpendingBitcoinPlan = {
    operationId: 'aa'.repeat(16),
    vaultId: source.status.vaultId,
    descriptorHash: guardianRenewalContextDigest(source.status),
    enrollmentDigest: '',
    txid: 'bb'.repeat(32),
    vout: 0,
    valueSats: 40000,
    changeSats: 40000 - outputs.reduce((n, o) => n + o.amountSats, 0) - 400,
    reserveScript: '',
    reserveSats: 0,
    reserveCount: 0,
    feeSats: 400,
    feePolicyDigest: 'cc'.repeat(32),
    registerExpireAt: Math.floor(Date.now() / 1000) + 240,
    outputs,
  }
  const prepared = { plan, planDigest: savingsSetupDigest('bitcoin-plan', plan), state: 'prepared' }
  const request = {
    vaultId: plan.vaultId,
    operationId: plan.operationId,
    txid: plan.txid,
    vout: plan.vout,
    outputs,
    expiresAt: plan.registerExpireAt,
  }
  const journal: BitcoinPaymentJournal = {
    version: 1,
    vaultId: plan.vaultId,
    descriptorHash: plan.descriptorHash,
    operationId: plan.operationId,
    txid: plan.txid,
    vout: 0,
    valueSats: plan.valueSats,
    reserveCount: 0,
    outputs,
    stage: 'preparing',
    prepareRequest: {
      ...request,
      ownerSignature: hex.encode(schnorr.sign(hex.decode(savingsSetupDigest('bitcoin-prepare', request)), phoneSecret)),
    },
  }
  const operatorInfo = validateExitArchive(
    source.archive.spending,
    vaultRecoveryBinding(source.kit, source.status),
  ).info
  return { ...source, spending, coin, phoneSecret, plan, prepared, journal, operatorInfo }
}
beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.spyOn(EsploraProvider.prototype, 'getCoins').mockResolvedValue([])
  vi.spyOn(delegation, 'authorizeSpendingRenewals').mockResolvedValue(null)
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) },
  })
})
describe('Bitcoin payment binding and lifecycle', () => {
  it('binds destination, fee, enrollment, outputs and signed prepare expiry', async () => {
    const f = await bitcoinFixture(2)
    expect(validateSpendingBitcoinPlan(f.prepared, f.status)).toEqual(f.prepared)
    saveBitcoinPayment({ ...f.journal, plan: f.prepared })
    expect(readSpendingBitcoin(f.status)?.plan).toEqual(f.prepared)
    for (const change of [
      { reserveScript: '0014' + 'dd'.repeat(20) },
      { reserveSats: 1000 },
      { changeSats: 0 },
      { feeSats: 5001 },
      { valueSats: Number.MAX_SAFE_INTEGER },
    ])
      expect(() => validateSpendingBitcoinPlan({ ...f.prepared, plan: { ...f.plan, ...change } }, f.status)).toThrow()
    for (const change of [
      { txid: 'ee'.repeat(32) },
      { reserveCount: 1 },
      { expiresAt: f.plan.registerExpireAt + 1 },
      { ownerSignature: '00'.repeat(64) },
    ]) {
      saveBitcoinPayment({ ...f.journal, prepareRequest: { ...f.journal.prepareRequest!, ...change } })
      expect(() => readSpendingBitcoin(f.status)).toThrow('authorization changed')
    }
  })
  it('checks a lost prepare without replaying it or cancelling it', async () => {
    const f = await bitcoinFixture(2)
    saveBitcoinPayment(f.journal)
    vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'not_found' })
    const prepare = vi.spyOn(bitcoinPaymentClient, 'prepare')
    const release = vi.spyOn(bitcoinPaymentClient, 'release')
    expect((await checkSpendingBitcoin(f.status))?.state).toBe('not_found')
    expect(prepare).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(readSpendingBitcoin(f.status)).not.toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 16) * 1000)
    expect((await checkSpendingBitcoin(f.status))?.state).toBe('cancelled')
    expect(readSpendingBitcoin(f.status)).toBeNull()
  })
  it.each(['prepared', 'registered', 'register_dispatched', 'delete_dispatched'])(
    'unexpired status %s never requests cancellation',
    async (state) => {
      const f = await bitcoinFixture(2)
      saveBitcoinPayment({ ...f.journal, plan: f.prepared, stage: 'registered' })
      vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state })
      const release = vi.spyOn(bitcoinPaymentClient, 'release')
      expect((await checkSpendingBitcoin(f.status))?.state).toBe(state)
      expect(release).not.toHaveBeenCalled()
      expect(readSpendingBitcoin(f.status)).not.toBeNull()
    },
  )
  it.each(['released', 'uncertain', 'waiting_expiry'])(
    'expired registration requests cancellation and preserves funds unless Guardian returns released (%s)',
    async (state) => {
      const f = await bitcoinFixture(2)
      const deletion = { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' }
      saveBitcoinPayment({ ...f.journal, plan: f.prepared, stage: 'registered', deleteIntent: deletion })
      vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 15) * 1000)
      vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'registered' })
      const release = vi.spyOn(bitcoinPaymentClient, 'release').mockResolvedValue({ state })
      expect((await checkSpendingBitcoin(f.status))?.state).toBe(state)
      expect(release).toHaveBeenCalledWith({
        vaultId: f.status.vaultId,
        operationId: f.plan.operationId,
        deleteIntent: deletion,
      })
      expect(readSpendingBitcoin(f.status) === null).toBe(state === 'released')
    },
  )
  it.each(['final_dispatched', 'submitted', 'confirmed', 'uncertain', 'not_found'])(
    'expired status %s does not infer that final submission failed',
    async (state) => {
      const f = await bitcoinFixture(2)
      saveBitcoinPayment({
        ...f.journal,
        plan: f.prepared,
        stage: 'registered',
        deleteIntent: { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' },
      })
      vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 16) * 1000)
      vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state })
      const release = vi.spyOn(bitcoinPaymentClient, 'release')
      // Submitted/confirmed without a matching receipt must also remain reserved.
      await checkSpendingBitcoin(f.status).catch(() => undefined)
      expect(release).not.toHaveBeenCalled()
      expect(readSpendingBitcoin(f.status)).not.toBeNull()
    },
  )
  it('asks Guardian to release an expired final authorization that never reached dispatch', async () => {
    const f = await bitcoinFixture(2)
    const deletion = { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' }
    saveBitcoinPayment({
      ...f.journal,
      plan: f.prepared,
      stage: 'finalizing',
      deleteIntent: deletion,
      final: { batchId: 'failed-batch' } as never,
    })
    vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 16) * 1000)
    vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'final_authorized' })
    const release = vi.spyOn(bitcoinPaymentClient, 'release').mockResolvedValue({ state: 'released' })
    expect((await checkSpendingBitcoin(f.status))?.state).toBe('released')
    expect(release).toHaveBeenCalledWith({
      vaultId: f.status.vaultId,
      operationId: f.plan.operationId,
      deleteIntent: deletion,
    })
    expect(readSpendingBitcoin(f.status)).toBeNull()
  })
  it('retains an expired registration after cancellation transport failure or missing owner proof', async () => {
    const f = await bitcoinFixture(2)
    const saved = { ...f.journal, plan: f.prepared, stage: 'registered' as const }
    saveBitcoinPayment(saved)
    vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 16) * 1000)
    vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'registered' })
    const release = vi.spyOn(bitcoinPaymentClient, 'release').mockRejectedValue(new Error('connection reset'))
    await checkSpendingBitcoin(f.status)
    expect(release).not.toHaveBeenCalled()
    const deletion = { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' }
    saveBitcoinPayment({ ...saved, deleteIntent: deletion })
    await expect(checkSpendingBitcoin(f.status)).rejects.toThrow('connection reset')
    expect(readSpendingBitcoin(f.status)?.deleteIntent).toEqual(deletion)
  })
  it('explicit cancellation uses the retained proof and keeps ambiguous funds reserved', async () => {
    const f = await bitcoinFixture(2)
    const deletion = { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' }
    saveBitcoinPayment({ ...f.journal, plan: f.prepared, stage: 'registered', deleteIntent: deletion })
    const release = vi.spyOn(bitcoinPaymentClient, 'release').mockResolvedValue({ state: 'uncertain' })
    expect((await cancelSpendingBitcoin(f.status))?.state).toBe('uncertain')
    expect(release).toHaveBeenCalledWith({
      vaultId: f.status.vaultId,
      operationId: f.plan.operationId,
      deleteIntent: deletion,
    })
    expect(readSpendingBitcoin(f.status)?.deleteIntent).toEqual(deletion)
    release.mockResolvedValue({ state: 'released' })
    expect((await cancelSpendingBitcoin(f.status))?.state).toBe('released')
    expect(readSpendingBitcoin(f.status)).toBeNull()
  })
  it('uses the stock SDK to sign both intent inputs for a Bitcoin payment', async () => {
    const f = await bitcoinFixture(2)
    const provider = new RestArkProvider('https://operator.invalid')
    vi.spyOn(provider, 'getInfo').mockResolvedValue(
      validateExitArchive(f.archive.spending, vaultRecoveryBinding(f.kit, f.status)).info,
    )
    registerVaultPolicyV1ContractHandler()
    const wallet = await Wallet.create({
      identity: SingleKey.fromPrivateKey(f.phoneSecret),
      arkProvider: provider,
      indexerProvider: exitArchiveProviders(f.archive.spending, vaultRecoveryBinding(f.kit, f.status)).indexerProvider,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
      walletMode: 'static',
      settlementConfig: false,
    })
    try {
      const manager = await wallet.getContractManager()
      await manager.createContract(vaultPolicyV1Contract(f.spending, f.status.spendingArkAddress!))
      const input = {
        ...f.coin,
        txid: f.plan.txid,
        createdAt: new Date(),
        virtualStatus: { state: 'settled' },
        tapTree: f.spending.encode(),
        forfeitTapLeafScript: f.spending.forfeit(),
        intentTapLeafScript: f.spending.forfeit(),
      } as ExtendedVirtualCoin
      const intent = await wallet.makeRegisterIntentSignature(
        [input],
        [
          { amount: BigInt(f.plan.changeSats), script: f.spending.pkScript },
          { amount: 500n, script: hex.decode(f.plan.outputs[0].script) },
          { amount: 500n, script: hex.decode(f.plan.outputs[0].script) },
        ],
        [1, 2],
        ['02' + hex.encode(schnorr.getPublicKey(scalarSecret(25)))],
        undefined,
        f.plan.registerExpireAt,
      )
      const deletion = await wallet.makeDeleteIntentSignature([input])
      const deleteIntent = { proof: deletion.proof, message: JSON.stringify(deletion.message) }
      saveBitcoinPayment({ ...f.journal, plan: f.prepared, stage: 'registered', deleteIntent })
      expect(readSpendingBitcoin(f.status)?.deleteIntent).toEqual(deleteIntent)
      const proof = Transaction.fromPSBT(base64.decode(intent.proof))
      const vector = process.env.VAULT_BITCOIN_SDK_VECTOR
      if (vector)
        writeFileSync(
          vector,
          JSON.stringify(
            {
              status: f.status,
              context: guardianRenewalContext(f.status),
              prepared: f.prepared,
              prepare: f.journal.prepareRequest,
              deleteIntent,
              psbt: intent.proof,
              message: JSON.stringify(intent.message),
            },
            null,
            2,
          ) + '\n',
        )
      expect(proof.inputsLength).toBe(2)
      for (let i = 0; i < 2; i++) expect(proof.getInput(i).tapScriptSig?.[0][1]).toHaveLength(65)
      expect(proof.getOutput(1)).toEqual(proof.getOutput(2))
      expect(await manager.getSpendablePaths({ contractScript: hex.encode(f.spending.pkScript), vtxo: input })).toEqual(
        [],
      )
    } finally {
      await wallet.dispose()
    }
  })
})

it('ignores failures outside the participating batch and preserves failures inside it', async () => {
  const handler = scopeBitcoinBatchFailures({
    onBatchStarted: async (event: { id: string }) => ({ skip: event.id !== 'ours' }),
    onTreeSigningStarted: vi.fn(),
    onTreeNonces: vi.fn(),
    onBatchFinalization: vi.fn(),
  })
  const events = async function* () {
    yield { type: SettlementEventType.BatchFailed as const, id: 'previous', reason: 'Previous batch timed out' }
    yield { type: SettlementEventType.BatchStarted as const, id: 'ours', intentIdHashes: [], batchExpiry: 4194980n }
    yield { type: SettlementEventType.BatchFailed as const, id: 'unrelated', reason: 'Another batch timed out' }
    yield { type: SettlementEventType.BatchFailed as const, id: 'ours', reason: 'Our batch timed out' }
  }
  await expect(Batch.join(events(), handler)).rejects.toThrow('Our batch timed out')
})

it('decodes the shared response zero output index without replacing explicit invalid values', () => {
  const receipt = { state: 'submitted', receiverTxid: 'aa'.repeat(32) }
  expect(normalizeBitcoinResponse(receipt).receiverVout).toBe(0)
  expect(normalizeBitcoinResponse({ ...receipt, receiverVout: 2 }).receiverVout).toBe(2)
  expect(normalizeBitcoinResponse({ ...receipt, receiverVout: -1 }).receiverVout).toBe(-1)
  expect(normalizeBitcoinResponse({ state: 'uncertain' }).receiverVout).toBeUndefined()
})

it.each([1, 2])(
  'retains an exact Bitcoin payment with %s outputs and rejects destination substitution',
  async (count) => {
    const f = await bitcoinFixture(count)
    expect(validateSpendingBitcoinPlan(f.prepared, f.status)).toEqual(f.prepared)
    saveBitcoinPayment(f.journal)
    expect(readSpendingBitcoin(f.status)?.outputs).toEqual(f.plan.outputs)
    const outputs = [{ script: '0014' + '44'.repeat(20), amountSats: 1500 }]
    expect(() => validateSpendingBitcoinPlan({ ...f.prepared, plan: { ...f.plan, outputs } }, f.status)).toThrow()
    // Even replacing both the display and quote with a new valid hash cannot change the owner's signed request.
    const plan = { ...f.plan, outputs, changeSats: f.plan.valueSats - 1500 - f.plan.feeSats }
    saveBitcoinPayment({
      ...f.journal,
      outputs,
      plan: { ...f.prepared, plan, planDigest: savingsSetupDigest('bitcoin-plan', plan) },
    })
    expect(() => readSpendingBitcoin(f.status)).toThrow('authorization changed')
  },
)
it('rejects retired reserve-only plans, journals and prepare requests without posting', async () => {
  const f = await bitcoinFixture(2)
  const plan = {
    ...f.plan,
    outputs: undefined,
    reserveScript: f.plan.outputs[0].script,
    reserveSats: 500,
    reserveCount: 2,
  }
  expect(() => validateSpendingBitcoinPlan({ ...f.prepared, plan } as never, f.status)).toThrow()
  saveBitcoinPayment({ ...f.journal, outputs: undefined, reserveCount: 2 } as never)
  expect(() => readSpendingBitcoin(f.status)).toThrow('does not match this wallet')
  const post = vi.spyOn(apiModule, 'vaultPost')
  const request = { ...f.journal.prepareRequest!, outputs: undefined, reserveCount: 2 }
  expect(() => bitcoinPaymentClient.prepare(request as never)).toThrow('Unsupported Bitcoin payment request')
  expect(() => bitcoinPaymentClient.prepare({ ...f.journal.prepareRequest!, outputs: undefined } as never)).toThrow()
  expect(post).not.toHaveBeenCalled()
})

it('rejects nonstandard outputs, dust and unsafe values before preparing a payment', () => {
  for (const output of [
    { script: '6a', amountSats: 1000 },
    { script: '0014' + '44'.repeat(20), amountSats: 329 },
    { script: '5120' + 'EE'.repeat(32), amountSats: 1000 },
    { script: '0014' + '44'.repeat(20), amountSats: Number.MAX_SAFE_INTEGER },
  ])
    expect(() => validateBitcoinOutputs([output])).toThrow()
  expect(() => validateBitcoinOutputs([])).toThrow()
})
it('reconciles a new Bitcoin payment through the shared status path without creating another authorization', async () => {
  const f = await bitcoinFixture(2)
  saveBitcoinPayment(f.journal)
  const status = vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'uncertain' })
  const prepare = vi.spyOn(bitcoinPaymentClient, 'prepare')
  const release = vi.spyOn(bitcoinPaymentClient, 'release')
  await checkSpendingBitcoin(f.status)
  expect(status).toHaveBeenCalledOnce()
  expect(prepare).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
  expect(readSpendingBitcoin(f.status)?.operationId).toBe(f.plan.operationId)
})

it.each(
  ['protected', 'light'].flatMap((profile) =>
    ['rejected', 'expiry', 'uncertain', 'registered'].map((state) => [profile, state]),
  ),
)('%s explicit batch preserves the Guardian %s outcome without retrying or cancelling', async (profile, state) => {
  const f = await bitcoinFixture(1, profile === 'light')
  vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt - 240) * 1000)
  const dispose = vi.fn()
  const unlock = vi.fn(async () => ({
    phoneSecret: f.phoneSecret,
    scalar: scalarSecret(4),
    assertion: {},
  }))
  vi.spyOn(spendModule, 'createVtxoSpendUnlocker').mockReturnValue({
    unlock,
    dispose,
  } as never)
  vi.spyOn(spendModule, 'createVtxoOperationId').mockReturnValue(f.plan.operationId)
  vi.spyOn(apiModule, 'vaultGet').mockResolvedValue({
    version: 1,
    maxInputs: 1,
    descriptorHash: f.plan.descriptorHash,
  })
  vi.spyOn(streamModule, 'installVaultSettlementEventSource').mockImplementation(() => {})
  vi.spyOn(streamModule, 'waitForVaultSettlementStream').mockResolvedValue(undefined)
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.operatorInfo)
  vi.spyOn(RestArkProvider.prototype, 'getEventStream').mockImplementation(async function* () {})
  vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({
    vtxos: [
      {
        ...f.coin,
        txid: f.plan.txid,
        value: f.plan.valueSats,
        script: hex.encode(f.spending.pkScript),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        isSpent: false,
        virtualStatus: { state: 'settled' },
        commitmentTxIds: ['cc'.repeat(32)],
      },
    ],
  } as never)
  vi.spyOn(bitcoinPaymentClient, 'prepare').mockResolvedValue(f.prepared)
  vi.spyOn(bitcoinPaymentClient, 'status').mockResolvedValue({ state: 'uncertain' })
  const settle = vi.spyOn(Wallet.prototype, 'settle')
  const join = vi.spyOn(Batch, 'join').mockResolvedValue('dd'.repeat(32))
  const registered = vi.spyOn(bitcoinPaymentClient, 'register').mockImplementation(async (request) => {
    expect(JSON.parse(request.message).expire_at).toBe(f.plan.registerExpireAt)
    expect(readSpendingBitcoin(f.status)?.deleteIntent).toBeDefined()
    const proof = Transaction.fromPSBT(base64.decode(request.psbt))
    expect(proof.inputsLength).toBe(2)
    expect(hex.encode(proof.getOutput(1).script!)).toBe(f.plan.outputs![0].script)
    return state === 'registered'
      ? { state: 'registered', intentId: 'protected-intent' }
      : {
          state: state === 'expiry' ? 'rejected' : state,
          reason:
            state === 'expiry'
              ? 'INVALID_PSBT_INPUT (5): vtxo [redacted] expires after 2026-10-07 (minExpiryGap: 1h0m0s)'
              : 'input already spent',
        }
  })
  const released = vi.spyOn(bitcoinPaymentClient, 'release')
  let error: unknown
  try {
    await sendSpendingToBitcoin(
      { vaultId: f.status.vaultId } as never,
      f.status,
      f.plan.outputs!,
      async () => true,
      () => {},
    )
  } catch (caught) {
    error = caught
  }
  expect(registered, String(error)).toHaveBeenCalledOnce()
  expect(released).not.toHaveBeenCalled()
  expect(settle).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
  expect(delegation.authorizeSpendingRenewals).not.toHaveBeenCalled()
  if (state === 'rejected') {
    expect(humanizeVaultError(error)).toContain('funds changed or are in use')
    expect(readSpendingBitcoin(f.status)).toBeNull()
  } else if (state === 'expiry') {
    expect(humanizeVaultError(error)).toContain('Expected availability')
    expect(humanizeVaultError(error)).not.toContain('INVALID_PSBT_INPUT')
    expect(readSpendingBitcoin(f.status)).toBeNull()
    await expect(
      sendSpendingToBitcoin(
        { vaultId: f.status.vaultId } as never,
        f.status,
        f.plan.outputs!,
        async () => true,
        () => {},
      ),
    ).rejects.toThrow('Expected availability')
    expect(unlock).toHaveBeenCalledOnce()
    expect(bitcoinPaymentClient.prepare).toHaveBeenCalledOnce()
    expect(registered).toHaveBeenCalledOnce()
    expect(readSpendingBitcoin(f.status)).toBeNull()
  } else if (state === 'uncertain') {
    expect(humanizeVaultError(error)).toContain('registration is still being checked')
    expect(readSpendingBitcoin(f.status)?.stage).toBe('registering')
  } else {
    expect(join).toHaveBeenCalledOnce()
    expect(humanizeVaultError(error)).toContain('receipt is still being checked')
    expect(readSpendingBitcoin(f.status)?.stage).toBe('registered')
  }
})

it('checks the enrolled Light output before asking for a Bitcoin payment signature', async () => {
  const enrollment = sharedSpendingEnrollment()
  const status = sharedSpendingStatus()
  const unlock = vi.fn()
  const dispose = vi.fn()
  vi.spyOn(spendModule, 'createVtxoSpendUnlocker').mockReturnValue({ unlock, dispose } as never)
  vi.spyOn(apiModule, 'vaultGet').mockResolvedValue({
    version: 1,
    maxInputs: 1,
    descriptorHash: guardianRenewalContextDigest(status),
  })
  const coins = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [] } as never)
  const approve = vi.fn()
  await expect(
    sendSpendingToBitcoin(
      enrollment,
      status,
      [{ script: '0014' + '43'.repeat(20), amountSats: 1500 }],
      approve,
      () => {},
    ),
  ).rejects.toThrow('No live Spending output is available')
  expect(coins).toHaveBeenCalledWith({ scripts: [status.spendingArkScript] })
  expect(unlock).not.toHaveBeenCalled()
  expect(approve).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})
