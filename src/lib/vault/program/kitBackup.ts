import { SPENDING_ONLY_TEMPLATE, requireSpendingEnrollmentStatus } from '../spendingEnrollment'
import { buildSpendingRecoveryDescriptor } from './spendingRecoveryDescriptor'
import { vaultCosignerClient } from '../cosignerClient'
import { beginPasskeySession } from '../signIn'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { buildRecoveryKit, parseRecoveryKit, type RecoveryKit } from './kit'
import { LEDGER_NATIVE_TEMPLATE } from './ledgerNativeKeys'
import { buildLedgerRecoveryDescriptor, ledgerEnrollmentFromStatus } from './ledgerRecoveryDescriptor'

export const MAP_BACKUP_NAME = 'arkade-vault-map'
export const MAP_BACKUP_VERSION = 3

export interface MapBackup {
  name: typeof MAP_BACKUP_NAME
  version: typeof MAP_BACKUP_VERSION
  kit: RecoveryKit
  backedUpAt: string
}

export function parseMapBackup(raw: unknown): MapBackup {
  const rec = raw as MapBackup
  if (!rec || rec.name !== MAP_BACKUP_NAME) throw new Error('not a vault map backup')
  if (rec.version !== MAP_BACKUP_VERSION) throw new Error('unsupported map backup version')
  return {
    name: MAP_BACKUP_NAME,
    version: MAP_BACKUP_VERSION,
    kit: parseRecoveryKit(rec.kit),
    backedUpAt: String(rec.backedUpAt || ''),
  }
}

export function buildMapBackup(kit: RecoveryKit, now = new Date().toISOString()): MapBackup {
  return {
    name: MAP_BACKUP_NAME,
    version: MAP_BACKUP_VERSION,
    kit: parseRecoveryKit(kit),
    backedUpAt: now,
  }
}

export function kitFromFacts(input: {
  enrollment?: Pick<EnrollmentSecrets, 'phoneBip340Pub' | 'phoneDirectP256' | 'vaultId'> | null
  status?: VaultStatus | null
  hardwarePub?: string
  recoveryPub?: string
}): RecoveryKit | null {
  if (input.status?.templateVersion === SPENDING_ONLY_TEMPLATE) {
    try {
      const d = requireSpendingEnrollmentStatus(input.status)
      if (
        (input.enrollment?.phoneBip340Pub && input.enrollment.phoneBip340Pub !== d.phonePub) ||
        (input.enrollment?.phoneDirectP256 && input.enrollment.phoneDirectP256 !== d.phoneDirectP256) ||
        input.hardwarePub ||
        input.recoveryPub
      )
        return null
      return buildRecoveryKit(buildSpendingRecoveryDescriptor(d))
    } catch {
      return null
    }
  }

  if (input.status?.templateVersion === LEDGER_NATIVE_TEMPLATE) {
    try {
      const descriptor = buildLedgerRecoveryDescriptor(ledgerEnrollmentFromStatus(input.status))
      if (
        (input.enrollment?.phoneBip340Pub && input.enrollment.phoneBip340Pub !== descriptor.keys.phoneBip340) ||
        (input.hardwarePub && input.hardwarePub !== descriptor.keys.hardware) ||
        (input.recoveryPub && input.recoveryPub !== descriptor.keys.recovery)
      )
        return null
      return buildRecoveryKit(descriptor)
    } catch {
      return null
    }
  }

  return null
}

export async function pushMapBackup(vaultId: string, kit: RecoveryKit): Promise<boolean> {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  if (kit.descriptor.vaultId !== id) throw new Error('Recovery Kit does not match this vault')
  const backup = buildMapBackup(kit)
  try {
    const status = await vaultCosignerClient.enrollment.status(id)
    const session = await beginPasskeySession('map-write', status)
    await vaultCosignerClient.recovery.writeMap({
      vaultId: id,
      ...session.assertion,
      payload: backup,
    })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/404|not found|cannot store|not running|unknown|passkey/i.test(msg)) return false
    throw err
  }
}

export async function pullMapBackup(vaultId: string): Promise<{ kit: RecoveryKit } | null> {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  try {
    const raw = await vaultCosignerClient.recovery.readMap(id)
    const backup = parseMapBackup(raw)
    return { kit: backup.kit }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/404|not found|cannot store|not running|unknown/i.test(msg)) return null
    throw err
  }
}
