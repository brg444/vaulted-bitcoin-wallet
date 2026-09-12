import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import type { VaultStatus } from '../types'
import { kitFromFacts } from '../program/kitBackup'
import { vaultRecoveryBinding } from '../vtxo/recoveryArchive'
import { recoveryBinding, recoveryStatusFacts, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { validateExitArchive } from './exitArchive'
import { recoveryFileStore } from './fileStore'
import type { RecoveryOutput } from './coverage'

export interface CommittedRecoveryCoverage {
  vaultId: string
  network: string
  descriptorHash: string
  fileDigest: string
  outputs: readonly RecoveryOutput[]
}

/** Read back a complete, committed file. Callers cannot acknowledge an unsaved capture. */
export async function readCommittedRecoveryCoverage(status: VaultStatus): Promise<CommittedRecoveryCoverage | null> {
  const kit = kitFromFacts({ status })
  if (!kit) throw new Error('Committed recovery descriptor is unavailable')
  const expected = recoveryBinding(kit, status)
  const saved = await recoveryFileStore<VaultRecoveryFile>(expected.descriptorHash)
  if (!saved) return null
  const file = validateVaultRecoveryFile(saved)
  if (
    JSON.stringify(file.header.binding) !== JSON.stringify(expected) ||
    JSON.stringify(file.header.status) !== JSON.stringify(recoveryStatusFacts(status))
  )
    throw new Error('Committed recovery coverage belongs to another account')
  const { coins } = validateExitArchive(file.archive.spending, vaultRecoveryBinding(kit, status))
  return {
    vaultId: status.vaultId,
    network: status.network,
    descriptorHash: expected.descriptorHash,
    fileDigest: hex.encode(sha256(new TextEncoder().encode(JSON.stringify(file)))),
    outputs: coins.map(({ txid, vout, value, script }) => ({ txid, vout, value, script })),
  }
}
