import { isSpendingRecoveryKit, isLedgerRecoveryKit, type RecoveryKit } from './kit'
import { requireSpendingEnrollmentStatus, spendingEnrollmentHash } from '../spendingEnrollment'
import type { VaultStatus } from '../types'
import { LEDGER_NATIVE_TEMPLATE } from './ledgerNativeKeys'
import {
  buildLedgerRecoveryDescriptor,
  hashLedgerRecoveryDescriptor,
  ledgerEnrollmentFromStatus,
} from './ledgerRecoveryDescriptor'

export function watcherEnabledForTemplate(templateVersion?: string): boolean {
  return templateVersion === LEDGER_NATIVE_TEMPLATE
}

export function kitMatchesLiveVault(kit: RecoveryKit, status: VaultStatus): boolean {
  if (isSpendingRecoveryKit(kit)) {
    try {
      return spendingEnrollmentHash(requireSpendingEnrollmentStatus(status)) === kit.descriptorHash
    } catch {
      return false
    }
  }
  if (isLedgerRecoveryKit(kit)) {
    try {
      return (
        status.enrolled &&
        hashLedgerRecoveryDescriptor(buildLedgerRecoveryDescriptor(ledgerEnrollmentFromStatus(status))) ===
          kit.descriptorHash
      )
    } catch {
      return false
    }
  }
  return false
}

export function selectLiveKit(input: { status: VaultStatus; stored: RecoveryKit | null }): RecoveryKit | null {
  if (!watcherEnabledForTemplate(input.status.templateVersion)) return null
  if (!input.stored) return null
  if (!kitMatchesLiveVault(input.stored, input.status)) return null
  return input.stored
}

export function assertLiveKit(kit: RecoveryKit, status: VaultStatus): RecoveryKit {
  if (!kitMatchesLiveVault(kit, status)) {
    throw new Error('Recovery Kit does not match this vault')
  }
  return kit
}
