import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import { kitFromFacts } from '../program/kitBackup'
import { exportConnectorRecoveryJournal } from '../program/connectorStore'
import { CONNECTOR_TEMPLATE } from '../program/connector'
import { captureVaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { buildRecoveryHeader, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { captureRecoveryJournals } from './journals'
import { recoveryFileStore } from './fileStore'
import { lightRecoveryStatus } from '../light/status'
import { lightDescriptorDigest } from '../light/contract'
import { syncLightCloudBackup, type LightBackupSession } from '../light/cloudBackup'
import type { LightRecoveryArchive } from '../light/recoveryArchive'
import { validateLightRecoveryFile, type LightRecoveryFile } from '../light/recovery'

export async function captureVaultRecoveryFile(status: VaultStatus, enrollment: EnrollmentSecrets) {
  const kit = kitFromFacts({ status, enrollment })
  if (!kit) throw new Error('Committed recovery descriptor is unavailable')
  const header = buildRecoveryHeader(kit, status, enrollment)
  const key = header.binding.descriptorHash
  if (!navigator.locks) throw new Error('Web Locks required for complete recovery capture')
  return navigator.locks.request(`vaulted:complete-recovery:${key}`, async () => {
    const previous = await recoveryFileStore<VaultRecoveryFile>(key)
    if (previous) validateVaultRecoveryFile(previous)
    const archive = await captureVaultRecoveryArchive(kit, status)
    const journals = await captureRecoveryJournals(status, previous || undefined)
    const connectorJournal =
      status.templateVersion === CONNECTOR_TEMPLATE
        ? await exportConnectorRecoveryJournal(
            { vaultId: status.vaultId, enrollmentDigest: status.connectorEnrollment!.enrollmentDigest },
            localStorage,
          )
        : undefined
    const file = validateVaultRecoveryFile({
      name: 'vaulted-recovery',
      version: 1,
      header,
      archive,
      ...journals,
      ...(connectorJournal ? { connectorJournal } : {}),
    })
    await recoveryFileStore(key, file)
    return file
  })
}

/** Both automatic and manual Light uploads carry all independently funded contracts. */
export async function syncCompleteLightBackup(session: LightBackupSession, archive: LightRecoveryArchive) {
  const status = lightRecoveryStatus(session.record.descriptor)
  const key = lightDescriptorDigest(session.record.descriptor)
  if (!navigator.locks) throw new Error('Web Locks required for complete recovery capture')
  return navigator.locks.request(`vaulted:complete-recovery:${key}`, async () => {
    const previous = await recoveryFileStore<LightRecoveryFile>(key)
    if (previous) validateLightRecoveryFile(previous)
    const journals = await captureRecoveryJournals(status, previous || session.file)
    const file = validateLightRecoveryFile({
      ...session.record,
      name: 'vaulted-light-recovery',
      version: 1,
      createdAt: archive.capturedAt,
      archive,
      ...journals,
    })
    await recoveryFileStore(key, file)
    return syncLightCloudBackup(session, archive, journals)
  })
}
