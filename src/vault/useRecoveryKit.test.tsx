import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useRecoveryKit } from './useRecoveryKit'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import { sharedSpendingRecoveryFixture } from '../lib/vault/recovery/testdata/helpers'

const mocks = vi.hoisted(() => ({ unlock: vi.fn(), save: vi.fn(), push: vi.fn(), pull: vi.fn() }))
vi.mock('../lib/vault/savingsSpend', () => ({ unlockPhoneBip340: mocks.unlock }))
vi.mock('../lib/vault/program/kitStore', () => ({ loadLocalKit: vi.fn(() => null), saveLocalKit: mocks.save }))
vi.mock('../lib/vault/program/kitBackup', async (original) => ({
  ...(await original<typeof import('../lib/vault/program/kitBackup')>()),
  pushMapBackup: mocks.push,
  pullMapBackup: mocks.pull,
}))
const { status, kit } = sharedSpendingRecoveryFixture()
const enrollment = {
  vaultId: status.vaultId,
  phoneBip340Pub: status.phoneBip340Pub,
  phoneDirectP256: status.phoneDirectP256,
} as EnrollmentSecrets
beforeEach(() => {
  vi.resetAllMocks()
})
it.each(['backupRecoveryKit', 'restoreRecoveryKit'] as const)(
  'verifies and wipes the device key before %s without activating a wallet',
  async (command) => {
    const secret = new Uint8Array(32).fill(7)
    mocks.unlock.mockResolvedValue(secret)
    mocks.push.mockImplementation(async () => {
      expect(secret.every((b) => b === 0)).toBe(true)
      return true
    })
    mocks.pull.mockImplementation(async () => {
      expect(secret.every((b) => b === 0)).toBe(true)
      return { kit }
    })
    const { result } = renderHook(() =>
      useRecoveryKit({ enrollment, status, hardwarePub: '', recoveryPub: '', clearError: vi.fn() }),
    )
    await act(async () => {
      await result.current[command]()
    })
    expect(mocks.unlock).toHaveBeenCalledExactlyOnceWith(enrollment, status)
    expect(secret.every((b) => b === 0)).toBe(true)
    expect(mocks.save).toHaveBeenCalledWith(kit)
  },
)
it('does not fetch or replace the map after passkey rejection', async () => {
  mocks.unlock.mockRejectedValue(new DOMException('Canceled', 'NotAllowedError'))
  const { result } = renderHook(() =>
    useRecoveryKit({ enrollment, status, hardwarePub: '', recoveryPub: '', clearError: vi.fn() }),
  )
  await expect(result.current.restoreRecoveryKit()).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(mocks.pull).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})
