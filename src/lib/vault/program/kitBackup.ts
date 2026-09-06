import { vaultCosignerClient } from '../cosignerClient'
import { beginPasskeySession } from '../signIn'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { buildVaultProgramDescriptor } from './descriptor'
import { buildRecoveryKit, parseRecoveryKit, type RecoveryKit } from './kit'
import { SAVINGS_TEMPLATE } from './constants'
import { isSupportedVaultNetwork } from '../constants'

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
  const recoveryPub = input.recoveryPub || input.status?.recoveryPub || ''
  const hardwarePub = input.hardwarePub || input.status?.externalOwnerWalletPub || ''
  const phonePub = input.enrollment?.phoneBip340Pub || input.status?.phoneBip340Pub || ''
  const phoneDirectP256 = input.enrollment?.phoneDirectP256 || input.status?.phoneDirectP256 || ''
  if (!hardwarePub) return null

  const vaultId = input.status?.vaultId || input.enrollment?.vaultId || ''
  const liveBases = Boolean(input.status?.vaultCosignerBasePub && input.status?.arkadeCosignerBasePub)
  const liveTemplate = String(input.status?.templateVersion || '')
  const signerOrigin = String(input.status?.arkadeCosignerOrigin || '').trim()
  const signerVersion = String(input.status?.arkadeCosignerVersion || '').trim()
  const spendingPolicy = input.status?.spendingPolicy
  const statusSpendingPolicyDigest = String(input.status?.spendingPolicyDigest || '').trim()
  const protectionTier = input.status?.protectionTier
  if (
    liveBases &&
    phonePub &&
    phoneDirectP256 &&
    vaultId &&
    signerOrigin &&
    signerVersion &&
    spendingPolicy &&
    spendingPolicy.program === 'vault-policy-v1' &&
    statusSpendingPolicyDigest &&
    protectionTier &&
    protectionTier !== 'light' &&
    isSupportedVaultNetwork(input.status?.network) &&
    liveTemplate === SAVINGS_TEMPLATE
  ) {
    try {
      const descriptor = buildVaultProgramDescriptor({
        vaultId,
        network: input.status!.network,
        phonePub,
        hardwarePub,
        recoveryPub,
        phoneDirectP256,
        vaultCosignerBase: input.status!.vaultCosignerBasePub!,
        arkadeCosignerBase: input.status!.arkadeCosignerBasePub!,
        arkadeCosigner: {
          origin: signerOrigin,
          version: signerVersion,
        },
        templateVersion: liveTemplate,
        protectionTier,
        spendingPolicy,
      })
      if (descriptor.policy.digest !== statusSpendingPolicyDigest) {
        throw new Error('rebuilt map spending policy does not match this vault')
      }
      if (input.status?.savingsAddress && descriptor.savings.address !== input.status.savingsAddress) {
        throw new Error('rebuilt map does not match this vault')
      }
      if (input.status?.savingsScript && descriptor.savings.script !== input.status.savingsScript) {
        throw new Error('rebuilt map does not match this vault')
      }
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
