import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardianRenewalSpendUnlocker } from './delegationCeremony'
import { authorizeGuardianRenewals } from './guardianDelegation'
import { lightTestEnrollment, lightTestStatus, testDescriptor, testOwner } from './testdata/helpers'
import type { VaultStatus } from '../types'
vi.mock('./guardianDelegation', () => ({ authorizeGuardianRenewals: vi.fn(async () => null) }))
afterEach(() => vi.clearAllMocks())
describe('renewal in an existing reviewed payment ceremony', () => {
  it('uses the same owner once, does not add a passkey prompt, and preserves disposal', async () => {
    const record = await lightTestEnrollment()
    const phoneSecret = Uint8Array.from(testOwner),
      scalar = new Uint8Array(32).fill(9)
    const auth = {
      phoneSecret,
      scalar,
      assertion: { credentialId: '', clientDataJSON: '', authenticatorData: '', signature: '' },
    }
    const passkey = vi.fn(async () => auth)
    const unlocker = guardianRenewalSpendUnlocker(testDescriptor)(
      record.enrollment,
      lightTestStatus() as unknown as VaultStatus,
      'ab'.repeat(32),
      passkey,
    )
    expect(await unlocker.unlock()).toBe(auth)
    expect(await unlocker.unlock()).toBe(auth)
    expect(passkey).toHaveBeenCalledTimes(1)
    expect(authorizeGuardianRenewals).toHaveBeenCalledExactlyOnceWith(testDescriptor, phoneSecret)
    expect(phoneSecret[31]).toBe(1)
    unlocker.dispose()
    expect(phoneSecret.every((b) => b === 0)).toBe(true)
    expect(scalar.every((b) => b === 0)).toBe(true)
  })
  it('does not authorize anything after a cancelled existing passkey ceremony', async () => {
    const record = await lightTestEnrollment()
    const unlocker = guardianRenewalSpendUnlocker(testDescriptor)(
      record.enrollment,
      lightTestStatus() as unknown as VaultStatus,
      'ab'.repeat(32),
      async () => {
        throw new Error('cancelled')
      },
    )
    await expect(unlocker.unlock()).rejects.toThrow('cancelled')
    unlocker.dispose()
    expect(authorizeGuardianRenewals).not.toHaveBeenCalled()
  })
})
