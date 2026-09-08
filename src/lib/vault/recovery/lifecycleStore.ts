import { recoveryFileStore } from './fileStore'
import { validateExitArchive, type ExitArchive, type ExitArchiveBinding } from './exitArchive'
import { IndexedDBWalletRepository } from '@arkade-os/sdk'
import { requireSpendingRecoveryCoverage } from './coverage'

export interface RecoveryTransition {
  version: 1
  pending: boolean
  updatedAt: string
  archive: ExitArchive | null
  prepared?: ExitArchive
  retained?: ExitArchive
  // Public output identities only; the financial journal remains in its existing store.
  outputs: { txid: string; vout: number; value: number; script: string }[]
  error?: string
}

export const recoveryTransitionKey = (database: string, script: string) => `lifecycle:${database}:${script}`

export function readRecoveryTransition(database: string, script: string) {
  return recoveryFileStore<RecoveryTransition>(recoveryTransitionKey(database, script))
}

/** Return the worker's complete paths without querying the Operator. Legacy
 * wallets without a lifecycle record retain their existing capture route. */
export async function loadLifecycleArchive(database: string, binding: ExitArchiveBinding) {
  if (!(await readRecoveryTransition(database, binding.scriptPubKey))) return null
  const run = async () => {
    const transition = await readRecoveryTransition(database, binding.scriptPubKey)
    if (!transition) return null
    const repository = new IndexedDBWalletRepository(database)
    try {
      const coins = (await repository.getVtxosForScript(binding.scriptPubKey)).filter((v) => !v.isSpent && !v.spentBy)
      const source = transition.prepared ?? transition.archive
      if (!source) throw new Error('Recovery paths are still syncing. Previous paths are retained.')
      validateExitArchive(source, { ...binding, descriptorHash: recoveryTransitionKey(database, binding.scriptPubKey) })
      const archive = { ...source, descriptorHash: binding.descriptorHash }
      requireSpendingRecoveryCoverage(archive, binding, coins)
      // An unfinished transition can only be acknowledged after both its target
      // identities and persisted wallet state match the retained complete graph.
      requireSpendingRecoveryCoverage(archive, binding, transition.outputs)
      if (transition.pending)
        await recoveryFileStore(recoveryTransitionKey(database, binding.scriptPubKey), {
          ...transition,
          pending: false,
          archive: source,
          prepared: undefined,
          error: undefined,
        })
      return archive
    } finally {
      await repository[Symbol.asyncDispose]()
    }
  }
  if (!navigator.locks) throw new Error('Web Locks required for recovery persistence')
  return navigator.locks.request(`vaulted:recovery-write:${database}`, run)
}
