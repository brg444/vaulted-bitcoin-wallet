import { spendingEnrollmentHash } from '../spendingEnrollment'
import {
  SPENDING_RECOVERY_SCHEMA,
  buildSpendingRecoveryDescriptor,
  type SpendingRecoveryDescriptor,
} from './spendingRecoveryDescriptor'
import { PROGRAM_CSV, familyKeysFor } from './constants'
import type { ProtectionTier } from '../protectionTier'
import { canonicalLedgerValue } from './ledgerEnrollment'
import {
  LEDGER_RECOVERY_SCHEMA,
  hashLedgerRecoveryDescriptor,
  validateLedgerRecoveryDescriptor,
  type LedgerRecoveryDescriptor,
} from './ledgerRecoveryDescriptor'

export const RECOVERY_KIT_NAME = 'arkade-recovery-kit'
export interface LedgerRecoveryKit {
  name: typeof RECOVERY_KIT_NAME
  version: 4
  descriptor: LedgerRecoveryDescriptor
  descriptorHash: string
  spendingPolicyDigest: string
  protectionTier: ProtectionTier
}

export interface SpendingRecoveryKit {
  name: typeof RECOVERY_KIT_NAME
  version: 5
  descriptor: SpendingRecoveryDescriptor
  descriptorHash: string
  spendingPolicyDigest: string
  protectionTier: 'light'
}
export type RecoveryKit = LedgerRecoveryKit | SpendingRecoveryKit
export function isSpendingRecoveryKit(kit: RecoveryKit): kit is SpendingRecoveryKit {
  return kit.version === 5
}

export function isLedgerRecoveryKit(kit: RecoveryKit): kit is LedgerRecoveryKit {
  return kit.version === 4
}

export interface RecoveryKitReport {
  vaultId: string
  hash: string
  trees: { role: string; address: string; delay?: number; guardians?: readonly string[] }[]
  warnings: string[]
}

export function buildRecoveryKit(descriptor: SpendingRecoveryDescriptor): SpendingRecoveryKit
export function buildRecoveryKit(descriptor: LedgerRecoveryDescriptor): LedgerRecoveryKit
export function buildRecoveryKit(descriptor: LedgerRecoveryDescriptor | SpendingRecoveryDescriptor): RecoveryKit
export function buildRecoveryKit(descriptor: LedgerRecoveryDescriptor | SpendingRecoveryDescriptor): RecoveryKit {
  if (descriptor.schema === SPENDING_RECOVERY_SCHEMA) {
    const d = buildSpendingRecoveryDescriptor(descriptor.enrollment)
    if (canonicalLedgerValue(d) !== canonicalLedgerValue(descriptor))
      throw new Error('Spending Recovery Kit descriptor changed')
    return {
      name: RECOVERY_KIT_NAME,
      version: 5,
      descriptor: d,
      descriptorHash: spendingEnrollmentHash(d.enrollment),
      spendingPolicyDigest: d.policy.digest,
      protectionTier: 'light',
    }
  }

  if (descriptor.schema === LEDGER_RECOVERY_SCHEMA) {
    const d = validateLedgerRecoveryDescriptor(descriptor)
    return {
      name: RECOVERY_KIT_NAME,
      version: 4,
      descriptor: d,
      descriptorHash: hashLedgerRecoveryDescriptor(d),
      spendingPolicyDigest: d.policy.digest,
      protectionTier: d.protectionTier,
    }
  }
  throw new Error('Unsupported Recovery Kit descriptor')
}

export function parseRecoveryKit(raw: unknown): RecoveryKit {
  const kit = raw as RecoveryKit
  if (!kit || kit.name !== RECOVERY_KIT_NAME) throw new Error('not a Recovery Kit')
  if (kit.version === 5) {
    const built = buildRecoveryKit(kit.descriptor)
    if (canonicalLedgerValue(kit) !== canonicalLedgerValue(built))
      throw new Error('Spending Recovery Kit binding changed')
    return built
  }
  if (kit.version === 4) {
    const built = buildRecoveryKit(validateLedgerRecoveryDescriptor(kit.descriptor))
    if (canonicalLedgerValue(kit) !== canonicalLedgerValue(built))
      throw new Error('Ledger Recovery Kit binding changed')
    return built
  }
  throw new Error('unsupported Recovery Kit version')
}

export function inspectRecoveryKit(kit: RecoveryKit): RecoveryKitReport {
  const parsed = parseRecoveryKit(kit)
  if (isSpendingRecoveryKit(parsed))
    return {
      vaultId: parsed.descriptor.vaultId,
      hash: parsed.descriptorHash,
      trees: [
        { role: 'spending', address: parsed.descriptor.enrollment.address },
        { role: 'boarding', address: parsed.descriptor.enrollment.boarding.address },
      ],
      warnings: ['Spending and boarding recovery require the saved device key and their committed delays.'],
    }
  const d = parsed.descriptor
  const familyKeys = familyKeysFor(Boolean(d.keys.recovery))
  const trees = [
    { role: 'savings', address: d.savings.address },
    { role: 'savings-change', address: d.savingsChange.address },
    ...familyKeys.map((key) => ({
      role: `pending-${key}`,
      address: d.pending[key].address,
      delay: d.pending[key].delay,
    })),
    ...familyKeys.map((key) => ({
      role: `quarantine-${key}`,
      address: d.quarantine[key].address,
      guardians: d.quarantine[key].guardians,
    })),
  ]
  return {
    vaultId: d.vaultId,
    hash: parsed.descriptorHash,
    trees,
    warnings: [
      'Normal Savings can be recovered with the phone and hardware keys without either service.',
      'Pending cancellation requires the exact remaining keys or service approvals in the saved script.',
      'A mature Pending recovery claim can pay any destination.',
      `Delays are ${PROGRAM_CSV.hardware}, ${PROGRAM_CSV.phone}, and ${PROGRAM_CSV.recovery} blocks. Mutinynet is much faster than a 10-minute chain.`,
    ],
  }
}

export function requireSavingsRecoveryKit(kit: RecoveryKit): LedgerRecoveryKit {
  if (isSpendingRecoveryKit(kit)) throw new Error('This wallet has no protected Savings contract')
  return kit
}
