import { SPENDING_ONLY_TEMPLATE } from './spendingEnrollment'
import type { LedgerEnrollmentSecrets, EnrollmentSecrets, SpendingEnrollmentSecrets } from './tenantEnrollment'
import type {
  LedgerStandardVaultStatus,
  LedgerAdvancedVaultStatus,
  SpendingOnlyVaultStatus,
  VaultStatus,
} from './types'

/** The single admitted account: shared Spending facts paired with the Savings choice. */
export type AdmittedAccount =
  | {
      savings: 'absent'
      status: SpendingOnlyVaultStatus
      enrollment: SpendingEnrollmentSecrets
    }
  | {
      savings: 'ledger'
      status: LedgerStandardVaultStatus | LedgerAdvancedVaultStatus
      enrollment: LedgerEnrollmentSecrets
    }

export function admitVaultAccount(status: VaultStatus, enrollment: EnrollmentSecrets): AdmittedAccount {
  if (status.vaultId !== enrollment.vaultId) throw new Error('Account status and enrollment vault do not match')
  if (status.templateVersion === SPENDING_ONLY_TEMPLATE) {
    if (enrollment.ledgerSavings) throw new Error('Spending account cannot carry Ledger enrollment facts')
    return { savings: 'absent', status, enrollment }
  }
  if (!enrollment.ledgerSavings) throw new Error('Ledger account requires its enrollment facts')
  return { savings: 'ledger', status, enrollment }
}
