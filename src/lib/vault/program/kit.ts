import { CONNECTOR_TEMPLATE } from './connector'
import { CONNECTOR_KIT_NAME, connectorRecoveryDescriptor } from './connectorEnrollmentCore'
import { PROGRAM_CSV, PROGRAM_SCHEMA, familyKeysFor, isSavingsTemplate } from './constants'
import { hashVaultProgramDescriptor, validateVaultProgramDescriptor, type VaultProgramDescriptor } from './descriptor'
import type { ProtectionTier } from '../protectionTier'

export const RECOVERY_KIT_NAME = 'arkade-recovery-kit'
export const RECOVERY_KIT_VERSION = 3

export interface RecoveryKit {
  name: typeof RECOVERY_KIT_NAME
  version: typeof RECOVERY_KIT_VERSION
  descriptor: VaultProgramDescriptor
  descriptorHash: string
  spendingPolicyDigest: string
  protectionTier: ProtectionTier
}

export interface RecoveryKitReport {
  vaultId: string
  hash: string
  trees: { role: string; address: string; delay?: number; guardians?: readonly string[] }[]
  warnings: string[]
}

export function buildRecoveryKit(descriptor: VaultProgramDescriptor): RecoveryKit {
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
  if (kit.version !== RECOVERY_KIT_VERSION) throw new Error('unsupported Recovery Kit version')
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
  const d = parsed.descriptor
  const familyKeys = familyKeysFor(Boolean(d.keys.recovery))
  const trees = [
    { role: 'savings', address: d.savings.address },
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
      'Recovery cannot exit a Normal UTXO if both cosigners are gone.',
      'A pending recovery cannot be cancelled if both cosigners are gone, unless this vault has a hardware-only cancel path.',
      'A mature Pending recovery claim can pay any destination.',
      `Delays are ${PROGRAM_CSV.hardware}, ${PROGRAM_CSV.phone}, and ${PROGRAM_CSV.recovery} blocks. Mutinynet is much faster than a 10-minute chain.`,
    ],
  }
}

export function assertKitTemplate(d: VaultProgramDescriptor) {
  if (
    d.schema !== PROGRAM_SCHEMA ||
    (!isSavingsTemplate(d.templateVersion) && d.templateVersion !== CONNECTOR_TEMPLATE)
  ) {
    throw new Error('Recovery Kit does not match the current Vault Program')
  }
}
