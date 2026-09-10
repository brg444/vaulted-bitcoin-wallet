import { DUST_SATS } from '../constants'
import {
  SPENDING_ONLY_TEMPLATE,
  validateSpendingEnrollment,
  type SpendingEnrollmentDescriptor,
} from '../spendingEnrollment'
import type { VaultProgramDescriptor } from './descriptor'

export const SPENDING_RECOVERY_SCHEMA = 'vaulted-spending/recovery-v1' as const
export interface SpendingRecoveryDescriptor {
  schema: typeof SPENDING_RECOVERY_SCHEMA
  templateVersion: typeof SPENDING_ONLY_TEMPLATE
  network: SpendingEnrollmentDescriptor['network']
  vaultId: string
  protectionTier: 'light'
  keys: { phoneBip340: string; phoneDirectP256: string }
  policy: VaultProgramDescriptor['policy']
  enrollment: SpendingEnrollmentDescriptor
}

export function buildSpendingRecoveryDescriptor(value: unknown): SpendingRecoveryDescriptor {
  const enrollment = validateSpendingEnrollment(value)
  const p = enrollment.spendingPolicy
  return {
    schema: SPENDING_RECOVERY_SCHEMA,
    templateVersion: SPENDING_ONLY_TEMPLATE,
    network: enrollment.network,
    vaultId: enrollment.vaultId,
    protectionTier: 'light',
    keys: { phoneBip340: enrollment.phonePub, phoneDirectP256: enrollment.phoneDirectP256 },
    policy: {
      program: p.program,
      schema: p.schema,
      period: p.period,
      digest: enrollment.spendingPolicyDigest,
      recipientDustSats: DUST_SATS,
      recipientCapSats: p.txRecipientCapSats,
      periodAllowanceSats: p.periodAllowanceSats,
      absoluteFeeCapSats: p.absoluteFeeCapSats,
      feerateCapSatVb: p.feerateCapSatPerV,
    },
    enrollment,
  }
}
