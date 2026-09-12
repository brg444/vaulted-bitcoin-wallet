import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { openLocalRecoveryBackup, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { parsePortableRecoveryPackage } from './portable'
import { recordRecoveryCopy, recoveryPathDigest, type RecoveryCopyKind, type RecoveryContents } from './copyStatus'

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}
export function recoveryFileFacts(raw: VaultRecoveryFile) {
  const file = validateVaultRecoveryFile(raw)
  const archive = file.archive.spending
  if (!archive) throw new Error('Spending paths are missing from this file')
  // Capture dates change on every refresh; operational dates and approvals remain
  // part of the digest. Only hashes and counts are persisted in the status store.
  const contents: RecoveryContents = {
    digest: hex.encode(
      sha256(
        new TextEncoder().encode(
          canonical({
            identity: file.header,
            paths: recoveryPathDigest(archive),
            onchain: file.archive.onchain
              .slice()
              .sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
            spendingJournal: file.spendingJournal,
            lightningJournal: file.lightningJournal,
          }),
        ),
      ),
    ),
    pendingPayments: file.spendingJournal?.operations.length || 0,
    lightningContracts: file.lightningJournal?.entries.length || 0,
    journalsPresent: Boolean(file.spendingJournal && file.lightningJournal),
  }
  return {
    file,
    archive,
    contents,
    vaultId: file.header.binding.vaultId,
    network: file.header.binding.network,
  }
}
export async function recordRecoveryFileCopy(kind: RecoveryCopyKind, file: VaultRecoveryFile) {
  const facts = recoveryFileFacts(file)
  await recordRecoveryCopy(facts.vaultId, facts.network, kind, facts.archive, facts.contents)
}

/** Read and validate only. No restore callback, wallet writes, signing, or broadcast. */
export async function checkProtectedRecoveryPackage(raw: unknown, expected: { vaultId: string; network: string }) {
  const pkg = parsePortableRecoveryPackage(raw)
  if (pkg.backup.header.binding.vaultId !== expected.vaultId || pkg.backup.header.binding.network !== expected.network)
    throw new Error('This package belongs to another wallet')
  const publicPaths = recoveryPathDigest(pkg.archive.spending)
  const file = await openLocalRecoveryBackup(pkg.backup)
  if (canonical(pkg.archive.onchain) !== canonical(file.archive.onchain))
    throw new Error('Readable and protected onchain records disagree')
  const facts = recoveryFileFacts(file)
  if (publicPaths !== recoveryPathDigest(facts.archive))
    throw new Error('Readable and protected Spending paths disagree')
  await recordRecoveryFileCopy('checked', file)
  return facts
}
