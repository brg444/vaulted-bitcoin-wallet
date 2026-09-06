import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useRecoveryArchive } from './useRecoveryArchive'
import type { VaultStatus } from '../lib/vault/types'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  open: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
  header: vi.fn(),
  encrypt: vi.fn(),
  key: vi.fn(),
  unlock: vi.fn(),
}))
vi.mock('../lib/vault/recovery/capture', () => ({ captureVaultRecoveryFile: mocks.capture }))
vi.mock('../lib/vault/recovery/cloudBackup', () => ({
  openRecoveryCloudBackup: mocks.open,
  syncRecoveryCloudBackup: mocks.sync,
}))
vi.mock('../lib/vault/recovery/backupCodec', () => ({
  buildRecoveryHeader: mocks.header,
  encryptRecoveryBackup: mocks.encrypt,
  recoveryBackupKey: mocks.key,
}))
vi.mock('../lib/vault/program/kitBackup', () => ({ kitFromFacts: () => ({ descriptorHash: 'aa' }) }))
vi.mock('../lib/vault/vtxo/walletWorker', () => ({ subscribeVaultWalletEvents: mocks.subscribe }))
vi.mock('../lib/vault/savingsSpend', () => ({ unlockPhoneBip340: mocks.unlock }))
const status = { vaultId: 'test', enrolled: true } as VaultStatus
const enrollment = { vaultId: 'test' } as EnrollmentSecrets
const file = { header: { binding: { vaultId: 'test' } } }
let event: () => void
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capture.mockResolvedValue(file)
  mocks.sync.mockImplementation(async (session) => {
    session.file = file
    return file
  })
  mocks.open.mockResolvedValue({
    header: file.header,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    key: {},
  })
  mocks.header.mockReturnValue(file.header)
  mocks.encrypt.mockResolvedValue({ encrypted: true })
  mocks.subscribe.mockImplementation((_status, callback) => {
    event = callback
    return vi.fn()
  })
  mocks.unlock.mockResolvedValue(new Uint8Array(32).fill(1))
  mocks.key.mockResolvedValue({})
})
afterEach(() => {
  vi.restoreAllMocks()
})
describe('automatic program recovery backups', () => {
  it('captures receipt events and only reports a cloud save after verified synchronization', async () => {
    const { result, unmount } = renderHook(() => useRecoveryArchive(enrollment, status, false))
    await act(() => result.current.backupRecoveryArchive())
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(result.current.recoveryArchiveStatus).toContain('cloud backup verified')
    mocks.capture.mockRejectedValueOnce(new Error('Incomplete exit graph'))
    act(() => event())
    await waitFor(() => expect(result.current.recoveryArchiveError).toBe('Incomplete exit graph'))
    expect(mocks.sync).toHaveBeenCalledTimes(1)
    act(() => event())
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2))
    expect(mocks.open).toHaveBeenCalledTimes(1)
    unmount()
  })
  it('drops the cloud capability when locked and exports locally without requiring cloud availability', async () => {
    const { result, rerender, unmount } = renderHook(({ locked }) => useRecoveryArchive(enrollment, status, locked), {
      initialProps: { locked: false },
    })
    const phone = new Uint8Array(32).fill(2)
    mocks.unlock.mockResolvedValue(phone)
    await act(async () => {
      expect(await result.current.downloadRecoveryArchive()).toContain('encrypted')
    })
    expect(mocks.open).not.toHaveBeenCalled()
    expect(phone.every((byte) => byte === 0)).toBe(true)
    await act(() => result.current.backupRecoveryArchive())
    rerender({ locked: true })
    await expect(result.current.backupRecoveryArchive()).rejects.toThrow('Unlock')
    rerender({ locked: false })
    await act(() => result.current.backupRecoveryArchive())
    expect(mocks.open).toHaveBeenCalledTimes(2)
    unmount()
  })
})
