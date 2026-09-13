import { afterEach, describe, expect, it, vi } from 'vitest'
import { vaultCosignerClient } from './cosignerClient'
import { loadStagedEnrollment, saveStagedEnrollment } from './enrollmentStore'
import { vaultStatusPath } from './status'
import {
  beginTenantEnrollment,
  finishTenantEnrollment,
  reconcileStagedEnrollment,
  type EnrollmentRoles,
} from './tenantEnrollment'
import { defaultSpendingPolicy, spendingPolicyDigest } from './spendingPolicy'
import { sharedSpendingEnrollment } from './vtxo/testdata/sharedSpending'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('current enrollment boundary', () => {
  it('requires an explicit vault id on the status path', () => {
    expect(() => vaultStatusPath('')).toThrow(/vault id required/)
  })

  it.each([{}, { connector: {} }, { connector: { connectorType: 'p2tr' } }])(
    'rejects retired protected setup before requesting a credential or server enrollment: %o',
    async (extra) => {
      const publicStatus = vi.spyOn(vaultCosignerClient.enrollment, 'publicStatus')
      const start = vi.spyOn(vaultCosignerClient.enrollment, 'start')
      await expect(
        beginTenantEnrollment('token', {
          protectionTier: 'standard',
          hardwarePub: '',
          spendingPolicy: defaultSpendingPolicy(),
          ...extra,
        } as unknown as EnrollmentRoles),
      ).rejects.toThrow(/Ledger|Unsupported/)
      expect(publicStatus).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(loadStagedEnrollment()).toBeNull()
    },
  )

  it('rejects historical staged setup before finish or reconciliation can activate it', async () => {
    const spendingPolicy = defaultSpendingPolicy()
    saveStagedEnrollment({
      ...sharedSpendingEnrollment(),
      handle: 'retired-handle',
      userHandle: 'user',
      clientDataJSON: '01',
      authenticatorData: '02',
      attestationObject: '03',
      hardwareXOnly: '04',
      protectionTier: 'standard',
      descriptorHash: 'ab'.repeat(32),
      boardingPub: '02' + '11'.repeat(32),
      boardingDescriptorHash: 'ab'.repeat(32),
      spendingPolicy,
      spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
    })
    const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
    const status = vi.spyOn(vaultCosignerClient.enrollment, 'status')
    await expect(finishTenantEnrollment('token')).rejects.toThrow('Unsupported staged enrollment')
    await expect(reconcileStagedEnrollment()).rejects.toThrow('Unsupported staged enrollment')
    expect(finish).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(loadStagedEnrollment()?.handle).toBe('retired-handle')
  })
})
