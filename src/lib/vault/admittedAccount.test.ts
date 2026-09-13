import { describe, expect, it } from 'vitest'
import { admitVaultAccount } from './admittedAccount'
import { ledgerRecoveryFixture } from './recovery/testdata/ledger'
import { sharedSpendingEnrollment, sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import type { VaultStatus } from './types'
import type { EnrollmentSecrets } from './tenantEnrollment'

describe('admitted account pairing', () => {
  it('pairs a shared Spending status with its enrollment as absent Savings', () => {
    const enrollment = sharedSpendingEnrollment()
    const account = admitVaultAccount(sharedSpendingStatus(), enrollment)
    expect(account.savings).toBe('absent')
    expect(account.enrollment.ledgerSavings).toBeUndefined()
  })

  it.each([false, true])('pairs a Ledger status with its enrollment, advanced=%s', async (advanced) => {
    const fixture = await ledgerRecoveryFixture(advanced)
    const account = admitVaultAccount(fixture.status, fixture.enrollment)
    if (account.savings !== 'ledger') throw new Error('expected a Ledger account')
    expect(account.enrollment.ledgerSavings.contract.context.vaultId).toBe(fixture.status.vaultId)
  })

  it('rejects a Ledger status paired with a Spending enrollment', async () => {
    const fixture = await ledgerRecoveryFixture(false)
    const spending = { ...sharedSpendingEnrollment(), vaultId: fixture.status.vaultId } as EnrollmentSecrets
    expect(() => admitVaultAccount(fixture.status, spending)).toThrow(/Ledger account requires/)
  })

  it('rejects a Spending status paired with a Ledger enrollment', async () => {
    const fixture = await ledgerRecoveryFixture(false)
    const status = sharedSpendingStatus() as VaultStatus
    const ledgerEnrollment = { ...fixture.enrollment, vaultId: status.vaultId } as EnrollmentSecrets
    expect(() => admitVaultAccount(status, ledgerEnrollment)).toThrow(/cannot carry Ledger enrollment/)
  })

  it('rejects a vault mismatch', async () => {
    const fixture = await ledgerRecoveryFixture(false)
    const other = { ...fixture.enrollment, vaultId: 'another-vault' } as EnrollmentSecrets
    expect(() => admitVaultAccount(fixture.status, other)).toThrow(/vault do not match/)
  })
})
