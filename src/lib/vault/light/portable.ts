import { encryptLightBackup, parseLightEncryptedBackup, type LightEncryptedBackup } from './backupCodec'
import { validateLightRecoveryFile, type LightRecoveryFile } from './recovery'
import { validateLightRecoveryArchive, type LightRecoveryArchive } from './recoveryArchive'
import { publicExitArchive, MAX_PORTABLE_RECOVERY_BYTES } from '../recovery/portable'

export interface LightRecoveryPackage {
  name: 'vaulted-light-recovery-package'
  version: 1
  archive: LightRecoveryArchive
  backup: LightEncryptedBackup
}
export function parseLightRecoveryPackage(raw: unknown): LightRecoveryPackage {
  const value = raw as LightRecoveryPackage
  if (
    !value ||
    value.name !== 'vaulted-light-recovery-package' ||
    value.version !== 1 ||
    Object.keys(value).sort().join(',') !== 'archive,backup,name,version' ||
    JSON.stringify(value).length > MAX_PORTABLE_RECOVERY_BYTES
  )
    throw new Error('Invalid Light recovery package')
  const backup = parseLightEncryptedBackup(value.backup)
  const archive = validateLightRecoveryArchive(value.archive, backup.header.descriptor).archive
  return { name: value.name, version: 1, archive, backup }
}
export async function createLightRecoveryPackage(file: LightRecoveryFile, key: CryptoKey) {
  const valid = validateLightRecoveryFile(file)
  if (!valid.archive) throw new Error('Current Spending paths are required')
  return parseLightRecoveryPackage({
    name: 'vaulted-light-recovery-package',
    version: 1,
    archive: publicExitArchive(valid.archive),
    backup: await encryptLightBackup(valid, key),
  })
}
export function unwrapLightRecoveryPackage(raw: unknown) {
  return (raw as { name?: string })?.name === 'vaulted-light-recovery-package'
    ? parseLightRecoveryPackage(raw).backup
    : raw
}
