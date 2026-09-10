import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { openLocalRecoveryBackup, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { openLocalLightBackup } from '../light/backupCodec'
import { validateLightRecoveryFile, type LightRecoveryFile } from '../light/recovery'
import { parseLightRecoveryPackage } from '../light/portable'
import { parsePortableRecoveryPackage } from './portable'
import { recordRecoveryCopy, recoveryPathDigest, type RecoveryCopyKind, type RecoveryContents } from './copyStatus'

export type CompleteRecoveryFile = VaultRecoveryFile | LightRecoveryFile
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}
export function recoveryFileFacts(raw: CompleteRecoveryFile) {
  const file = raw.name === 'vaulted-recovery' ? validateVaultRecoveryFile(raw) : validateLightRecoveryFile(raw)
  const standard = file.name === 'vaulted-recovery' ? file : null
  const light = file.name === 'vaulted-light-recovery' ? file : null
  const archive = standard?.archive.spending || light?.archive
  if (!archive) throw new Error('Spending paths are missing from this file')
  // Capture dates change on every refresh; operational dates and approvals remain
  // part of the digest. Only hashes and counts are persisted in the status store.
  const identity = standard
    ? standard.header
    : light
      ? { ...light, archive: undefined, createdAt: undefined, spendingJournal: undefined, lightningJournal: undefined }
      : undefined
  const contents: RecoveryContents = {
    digest: hex.encode(
      sha256(
        new TextEncoder().encode(
          canonical({
            identity,
            paths: recoveryPathDigest(archive),
            onchain: standard?.archive.onchain
              .slice()
              .sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
            spendingJournal: file.spendingJournal,
            lightningJournal: file.lightningJournal,
            connectorJournal: standard?.connectorJournal,
          }),
        ),
      ),
    ),
    pendingPayments: file.spendingJournal?.operations.length || 0,
    lightningContracts: file.lightningJournal?.entries.length || 0,
    pendingConnector: Boolean(standard?.connectorJournal?.pending),
    journalsPresent: Boolean(file.spendingJournal && file.lightningJournal),
  }
  return {
    file,
    archive,
    contents,
    vaultId: standard?.header.binding.vaultId || light!.descriptor.vaultId,
    network: standard?.header.binding.network || light!.descriptor.network,
  }
}
export async function recordRecoveryFileCopy(kind: RecoveryCopyKind, file: CompleteRecoveryFile) {
  const facts = recoveryFileFacts(file)
  await recordRecoveryCopy(facts.vaultId, facts.network, kind, facts.archive, facts.contents)
}

/** Read and validate only. No restore callback, wallet writes, signing, or broadcast. */
export async function checkProtectedRecoveryPackage(raw: unknown, expected: { vaultId: string; network: string }) {
  let file: CompleteRecoveryFile
  let publicPaths: string
  if ((raw as { name?: string })?.name === 'vaulted-light-recovery-package') {
    const pkg = parseLightRecoveryPackage(raw)
    if (
      pkg.backup.header.descriptor.vaultId !== expected.vaultId ||
      pkg.backup.header.descriptor.network !== expected.network
    )
      throw new Error('This package belongs to another wallet')
    publicPaths = recoveryPathDigest(pkg.archive)
    file = (await openLocalLightBackup(pkg.backup)).file
  } else {
    const pkg = parsePortableRecoveryPackage(raw)
    if (
      pkg.backup.header.binding.vaultId !== expected.vaultId ||
      pkg.backup.header.binding.network !== expected.network
    )
      throw new Error('This package belongs to another wallet')
    publicPaths = recoveryPathDigest(pkg.archive.spending)
    file = await openLocalRecoveryBackup(pkg.backup)
    if (canonical(pkg.archive.onchain) !== canonical(file.archive.onchain))
      throw new Error('Readable and protected onchain records disagree')
  }
  const facts = recoveryFileFacts(file)
  if (publicPaths !== recoveryPathDigest(facts.archive))
    throw new Error('Readable and protected Spending paths disagree')
  await recordRecoveryFileCopy('checked', file)
  return facts
}
