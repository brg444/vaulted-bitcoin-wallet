import { SPENDING_ONLY_TEMPLATE, spendingEnrollmentHash, validateSpendingEnrollment } from './spendingEnrollment'
import { validateLedgerSavingsEnrollmentSecrets } from './program/ledgerEnrollment'
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

/** Pair an admitted status with its enrollment, reusing retained admission invariants. */
export function admitVaultAccount(status: VaultStatus, enrollment: EnrollmentSecrets): AdmittedAccount {
  if (status.vaultId !== enrollment.vaultId) throw new Error('Account status and enrollment vault do not match')
  if (status.templateVersion === SPENDING_ONLY_TEMPLATE) {
    if (enrollment.ledgerSavings) throw new Error('Spending account cannot carry Ledger enrollment facts')
    const descriptor = validateSpendingEnrollment(status.spendingDescriptor)
    if (enrollment.phoneBip340Pub !== descriptor.phonePub || enrollment.phoneDirectP256 !== descriptor.phoneDirectP256)
      throw new Error('Spending enrollment keys do not match the admitted status')
    return { savings: 'absent', status, enrollment }
  }
  if (!enrollment.ledgerSavings) throw new Error('Ledger account requires its enrollment facts')
  const savings = status.ledgerSavings
  validateLedgerSavingsEnrollmentSecrets(enrollment.ledgerSavings, {
    context: savings.context,
    spendingPolicy: savings.spendingPolicy,
  })
  if (enrollment.phoneBip340Pub !== status.phoneBip340Pub)
    throw new Error('Ledger enrollment phone key does not match the admitted status')
  return { savings: 'ledger', status, enrollment }
}

/** Immutable identity that a live status refresh must preserve. */
export function accountIdentity(account: AdmittedAccount): string {
  if (account.savings === 'absent') {
    const { status } = account
    return JSON.stringify([
      'absent',
      status.vaultId,
      status.protectionTier,
      status.phoneBip340Pub,
      status.phoneDirectP256,
      spendingEnrollmentHash(status.spendingDescriptor),
    ])
  }
  const { status } = account
  return JSON.stringify([
    'ledger',
    status.vaultId,
    status.protectionTier,
    status.phoneBip340Pub,
    status.phoneDirectP256,
    status.ledgerSavings.descriptorHash,
    status.ledgerSavings.context,
  ])
}
