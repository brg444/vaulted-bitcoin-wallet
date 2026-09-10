import { spendingEnrollmentHash } from '../spendingEnrollment'
import {
  SPENDING_RECOVERY_SCHEMA,
  buildSpendingRecoveryDescriptor,
  type SpendingRecoveryDescriptor,
} from './spendingRecoveryDescriptor'
import { isConnectorTemplate } from './connector'
import { CONNECTOR_KIT_NAME, connectorRecoveryDescriptor } from './connectorEnrollmentCore'
import { PROGRAM_CSV, PROGRAM_SCHEMA, familyKeysFor, isSavingsTemplate } from './constants'
import { hashVaultProgramDescriptor, validateVaultProgramDescriptor, type VaultProgramDescriptor } from './descriptor'
import type { ProtectionTier } from '../protectionTier'
import { canonicalLedgerValue } from './ledgerEnrollment'
import {
  LEDGER_RECOVERY_SCHEMA,
  hashLedgerRecoveryDescriptor,
  validateLedgerRecoveryDescriptor,
  type LedgerRecoveryDescriptor,
} from './ledgerRecoveryDescriptor'

export const RECOVERY_KIT_NAME = 'arkade-recovery-kit'
export const RECOVERY_KIT_VERSION = 3

export interface LegacyRecoveryKit {
  name: typeof RECOVERY_KIT_NAME
  version: typeof RECOVERY_KIT_VERSION
  descriptor: VaultProgramDescriptor
  descriptorHash: string
  spendingPolicyDigest: string
  protectionTier: ProtectionTier
}

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
export type SavingsRecoveryKit = LegacyRecoveryKit | LedgerRecoveryKit
export type RecoveryKit = SavingsRecoveryKit | SpendingRecoveryKit
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
export function buildRecoveryKit(descriptor: VaultProgramDescriptor): LegacyRecoveryKit
export function buildRecoveryKit(descriptor: LedgerRecoveryDescriptor): LedgerRecoveryKit
export function buildRecoveryKit(
  descriptor: VaultProgramDescriptor | LedgerRecoveryDescriptor | SpendingRecoveryDescriptor,
): RecoveryKit
export function buildRecoveryKit(
  descriptor: VaultProgramDescriptor | LedgerRecoveryDescriptor | SpendingRecoveryDescriptor,
): RecoveryKit {
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
  const d = validateVaultProgramDescriptor(descriptor)
  return {
    name: RECOVERY_KIT_NAME,
    version: RECOVERY_KIT_VERSION,
    descriptor: d,
    descriptorHash: hashVaultProgramDescriptor(d),
    spendingPolicyDigest: d.policy.digest,
    protectionTier: d.protectionTier,
  }
}

export function parseRecoveryKit(raw: unknown): RecoveryKit {
  if (raw && typeof raw === 'object' && 'name' in raw && raw.name === CONNECTOR_KIT_NAME)
    return buildRecoveryKit(connectorRecoveryDescriptor(raw))
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
  if (kit.version !== RECOVERY_KIT_VERSION) throw new Error('unsupported Recovery Kit version')
  if (kit.descriptor.schema !== PROGRAM_SCHEMA) throw new Error('Recovery Kit version does not match its descriptor')
  const built = buildRecoveryKit(kit.descriptor)
  if (kit.descriptorHash && kit.descriptorHash !== built.descriptorHash) {
    throw new Error('Recovery Kit hash does not match the rebuilt descriptor')
  }
  if (kit.spendingPolicyDigest !== built.spendingPolicyDigest) {
    throw new Error('Recovery Kit spending policy digest does not match the rebuilt descriptor')
  }
  if (kit.protectionTier !== built.protectionTier) {
    throw new Error('Recovery Kit protection tier does not match the rebuilt descriptor')
  }
  return built
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
    ...(isLedgerRecoveryKit(parsed)
      ? [{ role: 'savings-change', address: parsed.descriptor.savingsChange.address }]
      : []),
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
      isConnectorTemplate(d.templateVersion)
        ? 'A new connector Savings payment needs its existing service approvals and hardware signature.'
        : 'Normal Savings can be recovered with the phone and hardware keys without either service.',
      'Pending cancellation requires the exact remaining keys or service approvals in the saved script.',
      'A mature Pending recovery claim can pay any destination.',
      `Delays are ${PROGRAM_CSV.hardware}, ${PROGRAM_CSV.phone}, and ${PROGRAM_CSV.recovery} blocks. Mutinynet is much faster than a 10-minute chain.`,
    ],
  }
}

export function assertKitTemplate(d: VaultProgramDescriptor) {
  if (
    d.schema !== PROGRAM_SCHEMA ||
    (!isSavingsTemplate(d.templateVersion) && !isConnectorTemplate(d.templateVersion))
  ) {
    throw new Error('Recovery Kit does not match the current Vault Program')
  }
}

export function requireSavingsRecoveryKit(kit: RecoveryKit): LegacyRecoveryKit | LedgerRecoveryKit {
  if (isSpendingRecoveryKit(kit)) throw new Error('This wallet has no protected Savings contract')
  return kit
}
