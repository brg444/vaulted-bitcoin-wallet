import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBWalletRepository } from '@arkade-os/sdk'
import { ledgerRecoveryFixture } from './testdata/ledger'
import { buildRecoveryHeader, type VaultRecoveryFile } from './backupCodec'
import { recoveryFileStore } from './fileStore'
import { readCommittedRecoveryCoverage } from './committedCoverage'
import { captureVaultRecoveryFile } from './capture'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  journals: vi.fn(),
  setup: vi.fn(),
  clearBitcoinPayment: vi.fn(),
  snapshot: vi.fn(),
}))
vi.mock('../vtxo/walletWorker', () => ({ fetchVaultWalletVtxoSnapshot: mocks.snapshot }))
vi.mock('../spendingBitcoinStore', () => ({
  bitcoinPlanOutputs: (plan: { outputs: unknown[] }) => plan.outputs,
  readSpendingBitcoin: mocks.setup,
  clearBitcoinPayment: mocks.clearBitcoinPayment,
}))
vi.mock('../vtxo/recoveryArchive', async (original) => ({
  ...(await original<typeof import('../vtxo/recoveryArchive')>()),
  captureVaultRecoveryArchive: mocks.capture,
}))
vi.mock('./journals', async (original) => ({
  ...(await original<typeof import('./journals')>()),
  captureRecoveryJournals: mocks.journals,
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture() {
  mocks.snapshot.mockReset().mockResolvedValue({ history: [] })
  mocks.setup.mockReset().mockReturnValue(null)
  mocks.clearBitcoinPayment.mockReset()
  const f = await ledgerRecoveryFixture(true)
  const coin = {
    ...f.coin,
    createdAt: new Date(f.coin.createdAt),
    status: { confirmed: true as const },
    virtualStatus: { state: 'settled' as const },
    isUnrolled: false,
    tapTree: f.spending.encode(),
    forfeitTapLeafScript: f.spending.forfeit(),
    intentTapLeafScript: f.spending.forfeit(),
  }
  const { enrollment } = f
  const header = buildRecoveryHeader(f.kit, f.status, enrollment)
  const previous: VaultRecoveryFile = { name: 'vaulted-recovery', version: 1, header, archive: f.archive }
  await recoveryFileStore(header.binding.descriptorHash, previous)
  vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => Promise<unknown>) => run() } })
  const read = vi.spyOn(IndexedDBWalletRepository.prototype, 'getVtxosForScript').mockResolvedValue([coin])
  mocks.capture.mockReset().mockResolvedValue(structuredClone(f.archive))
  mocks.journals.mockReset().mockResolvedValue({})
  return { ...f, coin, enrollment, previous, key: header.binding.descriptorHash, read }
}

describe('complete recovery snapshot replacement', () => {
  it('retains the previous complete file when paths miss a known received output', async () => {
    const f = await fixture()
    f.read.mockResolvedValue([f.coin, { ...f.coin, txid: 'ee'.repeat(32) }])
    await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('previous backup')
    expect(await recoveryFileStore(f.key)).toEqual(f.previous)
  })
  it('retains the previous file when an equal-balance renewal arrives during journal capture', async () => {
    const f = await fixture()
    mocks.journals.mockImplementation(async () => {
      f.read.mockResolvedValue([{ ...f.coin, txid: 'ee'.repeat(32) }])
      return {}
    })
    await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('previous backup')
    expect(await recoveryFileStore(f.key)).toEqual(f.previous)
  })
  it('replaces only a file that matches the known outputs before and after capture', async () => {
    const f = await fixture()
    const next = structuredClone(f.archive)
    next.spending.capturedAt = new Date(Date.now() + 1000).toISOString()
    mocks.capture.mockResolvedValue(next)
    const saved = await captureVaultRecoveryFile(f.status, f.enrollment)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(saved.file.archive).toEqual(next)
    expect(await recoveryFileStore(f.key)).toEqual(saved.file)
  })
})

it('returns committed coverage without retiring the confirmed payment or querying history', async () => {
  const f = await fixture()
  const setup = {
    stage: 'confirmed',
    receipt: { receiverTxid: 'ee'.repeat(32), receiverVout: 0, commitmentTxid: 'ab'.repeat(32) },
    plan: { plan: { changeSats: f.coin.value, feeSats: 200, outputs: [{ amountSats: 1500 }] } },
  }
  mocks.setup.mockReturnValue(setup)
  await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('Bitcoin payment recovery data')
  expect(await recoveryFileStore(f.key)).toEqual(f.previous)
  setup.receipt.receiverTxid = f.coin.txid
  mocks.snapshot.mockRejectedValue(new Error('History is still syncing'))
  const saved = await captureVaultRecoveryFile(f.status, f.enrollment)
  expect(saved.coverage).toEqual(await readCommittedRecoveryCoverage(f.status))
  expect(saved.coverage.outputs).toContainEqual({
    txid: f.coin.txid,
    vout: f.coin.vout,
    value: f.coin.value,
    script: f.coin.script,
  })
  expect(mocks.clearBitcoinPayment).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
  expect(await recoveryFileStore(f.key)).toEqual(saved.file)
})

it('retains the complete file when a setup final appears during capture before its replacement is indexed', async () => {
  const f = await fixture()
  const setup = { stage: 'finalizing', final: { commitmentPsbt: 'retained-final' } }
  mocks.journals.mockImplementation(async () => {
    mocks.setup.mockReturnValue(setup)
    return {}
  })
  await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('previous recovery file is retained')
  expect(await recoveryFileStore(f.key)).toEqual(f.previous)
  expect(mocks.clearBitcoinPayment).not.toHaveBeenCalled()
  setup.stage = 'submitted'
  await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('previous recovery file is retained')
  expect(await recoveryFileStore(f.key)).toEqual(f.previous)
})
