import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import { kitFromFacts } from '../program/kitBackup'
import { exportConnectorRecoveryJournal } from '../program/connectorStore'
import { isConnectorTemplate } from '../program/connector'
import { captureVaultRecoveryArchive, vaultRecoveryBinding } from '../vtxo/recoveryArchive'
import { buildRecoveryHeader, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { captureRecoveryJournals } from './journals'
import { recoveryFileStore } from './fileStore'
import { lightRecoveryStatus } from '../light/status'
import { lightDescriptorDigest } from '../light/contract'
import { syncLightCloudBackup, type LightBackupSession } from '../light/cloudBackup'
import type { LightRecoveryArchive } from '../light/recoveryArchive'
import { validateLightRecoveryFile, type LightRecoveryFile } from '../light/recovery'
import { IndexedDBWalletRepository } from '@arkade-os/sdk'
import { vaultWalletDatabase } from '../vtxo/walletWorkerNames'
import { requireSpendingRecoveryCoverage } from './coverage'

export async function captureVaultRecoveryFile(status: VaultStatus, enrollment: EnrollmentSecrets) {
  const kit = kitFromFacts({ status, enrollment })
  if (!kit) throw new Error('Committed recovery descriptor is unavailable')
  const header = buildRecoveryHeader(kit, status, enrollment)
  const key = header.binding.descriptorHash
  if (!navigator.locks) throw new Error('Web Locks required for complete recovery capture')
  return navigator.locks.request(`vaulted:complete-recovery:${key}`, async () => {
    const wallet = new IndexedDBWalletRepository(vaultWalletDatabase(status.vaultId))
    const binding = vaultRecoveryBinding(kit, status)
    const knownOutputs = async () =>
      (await wallet.getVtxosForScript(binding.scriptPubKey)).filter((coin) => !coin.isSpent && !coin.spentBy)
    try {
      const expected = await knownOutputs()
      const previous = await recoveryFileStore<VaultRecoveryFile>(key)
      if (previous) validateVaultRecoveryFile(previous)
      const archive = await captureVaultRecoveryArchive(kit, status)
      requireSpendingRecoveryCoverage(archive.spending, binding, expected)
      const journals = await captureRecoveryJournals(status, previous || undefined)
      const connectorJournal = isConnectorTemplate(status.templateVersion)
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
      // Capturing onchain data and payment journals can race a receive or renewal.
      // Compare identities again before replacing the complete offline copy.
      requireSpendingRecoveryCoverage(archive.spending, binding, await knownOutputs())
      await recoveryFileStore(key, file)
      return file
    } finally {
      await wallet[Symbol.asyncDispose]()
    }
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
