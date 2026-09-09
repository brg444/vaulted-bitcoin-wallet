import { SAVINGS_TEMPLATE } from './constants'
import { sameBip340Key } from '../setupPlan'
import type { VaultStatus } from '../types'
import { isLedgerRecoveryKit, type RecoveryKit } from './kit'
import { LEDGER_NATIVE_TEMPLATE } from './ledgerNativeKeys'
import {
  buildLedgerRecoveryDescriptor,
  hashLedgerRecoveryDescriptor,
  ledgerEnrollmentFromStatus,
} from './ledgerRecoveryDescriptor'

export function watcherEnabledForTemplate(templateVersion?: string): boolean {
  return templateVersion === SAVINGS_TEMPLATE || templateVersion === LEDGER_NATIVE_TEMPLATE
}

export function kitMatchesLiveVault(kit: RecoveryKit, status: VaultStatus): boolean {
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
  const descriptor = kit.descriptor
  if (!status.enrolled || status.templateVersion !== SAVINGS_TEMPLATE) return false
  return (
    descriptor.vaultId === status.vaultId &&
    descriptor.protectionTier === status.protectionTier &&
    descriptor.templateVersion === status.templateVersion &&
    descriptor.savings.address === status.savingsAddress &&
    descriptor.savings.script === status.savingsScript &&
    sameBip340Key(descriptor.keys.phoneBip340, status.phoneBip340Pub) &&
    sameBip340Key(descriptor.keys.hardware, status.externalOwnerWalletPub) &&
    ((!descriptor.keys.recovery && !status.recoveryPub) ||
      sameBip340Key(descriptor.keys.recovery, status.recoveryPub)) &&
    sameBip340Key(descriptor.keys.vaultCosignerBase, status.vaultCosignerBasePub) &&
    sameBip340Key(descriptor.keys.arkadeCosignerBase, status.arkadeCosignerBasePub) &&
    descriptor.arkadeCosigner.origin === status.arkadeCosignerOrigin &&
    descriptor.arkadeCosigner.version === status.arkadeCosignerVersion
  )
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
