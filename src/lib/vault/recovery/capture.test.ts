import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBWalletRepository } from '@arkade-os/sdk'
import { recoveryFixture } from './testdata/helpers'
import { buildRecoveryHeader, type VaultRecoveryFile } from './backupCodec'
import { recoveryFileStore } from './fileStore'
import { captureVaultRecoveryFile } from './capture'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), journals: vi.fn(), setup: vi.fn(), clearBitcoinPayment: vi.fn() }))
vi.mock('../spendingBitcoinStore', () => ({
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
  mocks.setup.mockReset().mockReturnValue(null)
  mocks.clearBitcoinPayment.mockReset()
  const f = recoveryFixture()
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
  const enrollment = {
    vaultId: f.status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: f.kit.descriptor.keys.phoneDirectP256,
    phoneBip340Pub: f.kit.descriptor.keys.phoneBip340,
    phoneDirectP256: f.kit.descriptor.keys.phoneDirectP256,
    nonce: 'aa'.repeat(12),
    ciphertext: 'bb'.repeat(48),
  }
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
    expect(saved.archive).toEqual(next)
    expect(await recoveryFileStore(f.key)).toEqual(saved)
  })
})

it('keeps confirmed signer setup until the exact replacement recovery output has been saved', async () => {
  const f = await fixture()
  const setup = {
    stage: 'confirmed',
    receipt: { receiverTxid: 'ee'.repeat(32), receiverVout: 0 },
    plan: { plan: { changeSats: f.coin.value } },
  }
  mocks.setup.mockReturnValue(setup)
  await expect(captureVaultRecoveryFile(f.status, f.enrollment)).rejects.toThrow('Bitcoin payment recovery data')
  expect(await recoveryFileStore(f.key)).toEqual(f.previous)
  expect(mocks.clearBitcoinPayment).not.toHaveBeenCalled()
  setup.receipt.receiverTxid = f.coin.txid
  mocks.clearBitcoinPayment.mockImplementation(async () => {
    expect(await recoveryFileStore(f.key)).not.toBeNull()
  })
  const saved = await captureVaultRecoveryFile(f.status, f.enrollment)
  expect(mocks.clearBitcoinPayment).toHaveBeenCalledWith(setup)
  expect(await recoveryFileStore(f.key)).toEqual(saved)
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
