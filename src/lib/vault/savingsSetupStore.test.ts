import { writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import {
  Wallet,
  Batch,
  SettlementEventType,
  RestArkProvider,
  SingleKey,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  Transaction,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { recoveryFixture } from './recovery/testdata/helpers'
import { DUAL_CONNECTOR_TEMPLATE, buildConnectorFamily } from './program/connector'
import { connectorPinFromVerifiedStatus, saveConnectorEnrollmentPin } from './program/connectorEnroll'
import { connectorContract } from './connectorWithdrawal'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { scalarSecret } from './program/fixtures'
import {
  savingsSetupDigest,
  saveSetup,
  readSavingsSetup,
  validateSavingsSetupPlan,
  type SetupJournal,
  type SavingsSetupPlan,
} from './savingsSetupStore'
import { validateExitArchive, exitArchiveProviders } from './recovery/exitArchive'
import { vaultRecoveryBinding } from './vtxo/recoveryArchive'
import { registerVaultPolicyV1ContractHandler, vaultPolicyV1Contract } from './vtxo/contractHandler'
import {
  setupClient,
  checkSpendingSignerFunding,
  scopeSavingsSetupBatchFailures,
  normalizeSavingsSetupResponse,
} from './savingsSetupFunding'

export function setupFixture() {
  const f = recoveryFixture(false, 'mainnet', undefined, undefined, {
    templateVersion: DUAL_CONNECTOR_TEMPLATE,
    connectorType: 'p2wpkh',
  })
  saveConnectorEnrollmentPin(connectorPinFromVerifiedStatus(f.status))
  const plan: SavingsSetupPlan = {
    operationId: 'aa'.repeat(16),
    vaultId: f.status.vaultId,
    descriptorHash: guardianRenewalContextDigest(f.status),
    enrollmentDigest: f.status.connectorEnrollment!.enrollmentDigest,
    txid: 'bb'.repeat(32),
    vout: 0,
    valueSats: 40000,
    changeSats: 38600,
    reserveScript: hex.encode(buildConnectorFamily(connectorContract(f.status)).connector.script),
    reserveSats: 500,
    reserveCount: 2,
    feeSats: 400,
    feePolicyDigest: 'cc'.repeat(32),
    registerExpireAt: Math.floor(Date.now() / 1000) + 240,
  }
  const prepared = { plan, planDigest: savingsSetupDigest('plan', plan), state: 'prepared' }
  const request = {
    vaultId: plan.vaultId,
    operationId: plan.operationId,
    txid: plan.txid,
    vout: plan.vout,
    reserveCount: plan.reserveCount,
    expiresAt: plan.registerExpireAt,
  }
  const journal: SetupJournal = {
    version: 1,
    vaultId: plan.vaultId,
    descriptorHash: plan.descriptorHash,
    operationId: plan.operationId,
    txid: plan.txid,
    vout: 0,
    valueSats: plan.valueSats,
    reserveCount: 2,
    stage: 'preparing',
    prepareRequest: {
      ...request,
      ownerSignature: hex.encode(schnorr.sign(hex.decode(savingsSetupDigest('prepare', request)), scalarSecret(3))),
    },
  }
  return { ...f, plan, prepared, journal }
}
beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) },
  })
})
describe('Spending signer setup binding and lifecycle', () => {
  it('binds destination, fee, enrollment, count and signed prepare expiry', () => {
    const f = setupFixture()
    expect(validateSavingsSetupPlan(f.prepared, f.status)).toEqual(f.prepared)
    saveSetup({ ...f.journal, plan: f.prepared })
    expect(readSavingsSetup(f.status)?.plan).toEqual(f.prepared)
    for (const change of [
      { reserveScript: '0014' + 'dd'.repeat(20) },
      { reserveSats: 1000 },
      { changeSats: 0 },
      { feeSats: 5001 },
      { valueSats: Number.MAX_SAFE_INTEGER },
    ])
      expect(() => validateSavingsSetupPlan({ ...f.prepared, plan: { ...f.plan, ...change } }, f.status)).toThrow()
    for (const change of [
      { txid: 'ee'.repeat(32) },
      { reserveCount: 1 },
      { expiresAt: f.plan.registerExpireAt + 1 },
      { ownerSignature: '00'.repeat(64) },
    ]) {
      saveSetup({ ...f.journal, prepareRequest: { ...f.journal.prepareRequest!, ...change } })
      expect(() => readSavingsSetup(f.status)).toThrow('authorization changed')
    }
  })
  it('replays a lost prepare exactly, then releases it without signing a batch', async () => {
    const f = setupFixture()
    saveSetup(f.journal)
    vi.spyOn(setupClient, 'status')
      .mockResolvedValueOnce({ state: 'not_found' })
      .mockResolvedValueOnce({ state: 'prepared' })
    const prepare = vi.spyOn(setupClient, 'prepare').mockResolvedValue(f.prepared)
    vi.spyOn(setupClient, 'release').mockResolvedValue({ state: 'cancelled' })
    expect((await checkSpendingSignerFunding(f.status))?.state).toBe('cancelled')
    expect(prepare).toHaveBeenCalledWith(f.journal.prepareRequest)
    expect(readSavingsSetup(f.status)).toBeNull()
  })
  it('retains an uncertain prepare until absence is checked after its signed expiry', async () => {
    const f = setupFixture()
    saveSetup(f.journal)
    vi.spyOn(setupClient, 'status').mockResolvedValue({ state: 'not_found' })
    const prepare = vi.spyOn(setupClient, 'prepare').mockRejectedValue(new Error('Insufficient allowance'))
    await expect(checkSpendingSignerFunding(f.status)).rejects.toThrow('allowance')
    expect(readSavingsSetup(f.status)).not.toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue((f.plan.registerExpireAt + 16) * 1000)
    expect((await checkSpendingSignerFunding(f.status))?.state).toBe('cancelled')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(readSavingsSetup(f.status)).toBeNull()
  })
  it('replays retained cancellation while keeping ambiguous funds reserved', async () => {
    const f = setupFixture()
    const deletion = { proof: 'public-test-proof', message: '{"type":"delete","expire_at":0}' }
    saveSetup({ ...f.journal, plan: f.prepared, stage: 'registered', deleteIntent: deletion })
    vi.spyOn(setupClient, 'status').mockResolvedValue({ state: 'delete_dispatched' })
    const release = vi.spyOn(setupClient, 'release').mockResolvedValue({ state: 'uncertain' })
    expect((await checkSpendingSignerFunding(f.status))?.state).toBe('uncertain')
    expect(release).toHaveBeenCalledWith({
      vaultId: f.status.vaultId,
      operationId: f.plan.operationId,
      deleteIntent: deletion,
    })
    expect(readSavingsSetup(f.status)?.deleteIntent).toEqual(deletion)
    release.mockResolvedValue({ state: 'released' })
    expect((await checkSpendingSignerFunding(f.status))?.state).toBe('released')
    expect(readSavingsSetup(f.status)).toBeNull()
  })
  it('uses the stock SDK to sign both intent inputs without enabling generic contract spending', async () => {
    const f = setupFixture()
    const provider = new RestArkProvider('https://operator.invalid')
    vi.spyOn(provider, 'getInfo').mockResolvedValue(
      validateExitArchive(f.archive.spending, vaultRecoveryBinding(f.kit, f.status)).info,
    )
    registerVaultPolicyV1ContractHandler()
    const wallet = await Wallet.create({
      identity: SingleKey.fromPrivateKey(scalarSecret(3)),
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
          { amount: 500n, script: hex.decode(f.plan.reserveScript) },
          { amount: 500n, script: hex.decode(f.plan.reserveScript) },
        ],
        [1, 2],
        ['02' + hex.encode(schnorr.getPublicKey(scalarSecret(25)))],
        undefined,
        f.plan.registerExpireAt,
      )
      const deletion = await wallet.makeDeleteIntentSignature([input])
      const deleteIntent = { proof: deletion.proof, message: JSON.stringify(deletion.message) }
      saveSetup({ ...f.journal, plan: f.prepared, stage: 'registered', deleteIntent })
      expect(readSavingsSetup(f.status)?.deleteIntent).toEqual(deleteIntent)
      const proof = Transaction.fromPSBT(base64.decode(intent.proof))
      if (process.env.VAULT_SETUP_SDK_VECTOR)
        writeFileSync(
          process.env.VAULT_SETUP_SDK_VECTOR,
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
  const handler = scopeSavingsSetupBatchFailures({
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
  expect(normalizeSavingsSetupResponse(receipt).receiverVout).toBe(0)
  expect(normalizeSavingsSetupResponse({ ...receipt, receiverVout: 2 }).receiverVout).toBe(2)
  expect(normalizeSavingsSetupResponse({ ...receipt, receiverVout: -1 }).receiverVout).toBe(-1)
  expect(normalizeSavingsSetupResponse({ state: 'uncertain' }).receiverVout).toBeUndefined()
})
