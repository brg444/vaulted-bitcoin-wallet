import { vaultAccountRuntime, type VaultAccountRuntime } from './accountRuntime'
import type { VaultMaintenanceTask } from './accountMaintenance'
import { fetchAddressUtxos } from './esplora'
import { isLedgerRecoveryKit, type RecoveryKit } from './program/kit'
import { loadLocalKit } from './program/kitStore'
import { selectLiveKit } from './program/liveKit'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { loadSeenOutpoints, pollPendingInitiates, saveSeenOutpoints, type InitiateAlert } from './program/watch'
import type { VaultStatus } from './types'

function createRecoveryWatch(account: VaultAccountRuntime, identity: string, kit: RecoveryKit) {
  if (!isLedgerRecoveryKit(kit)) throw new Error('Ledger recovery observation requires its enrolled kit')
  const descriptor = kit.descriptor
  const scope = { vaultId: descriptor.vaultId, network: descriptor.network, descriptorHash: kit.descriptorHash }
  const listeners = new Set<() => void>()
  let snapshot: InitiateAlert | null = null
  let task: VaultMaintenanceTask<void> | undefined
  let disposed = false
  const stop = () => {
    void task?.dispose()
    task = undefined
  }
  const start = () => {
    if (task || disposed || account.disposed) return
    task = account.maintenance.observe(
      'recovery-watch',
      async (signal) => {
        const next = await pollPendingInitiates({
          descriptor,
          seen: loadSeenOutpoints(scope),
          fetchUtxos: fetchAddressUtxos,
          signal,
        })
        if (signal.aborted || disposed || account.disposed) return
        saveSeenOutpoints(scope, next.seen)
        if (next.alerts.length) {
          snapshot = next.alerts[0]
          for (const listener of listeners) listener()
        }
      },
      { intervalMs: 20_000 },
    )
    task.request()
  }
  return {
    identity,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed || account.disposed) return () => {}
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) stop()
      }
    },
    dispose() {
      disposed = true
      stop()
      listeners.clear()
    },
  }
}

export type VaultRecoveryWatch = ReturnType<typeof createRecoveryWatch>

/** One retained Ledger watcher shares state and scheduling across its views. */
export function vaultRecoveryWatch(status: VaultStatus): VaultRecoveryWatch | undefined {
  if (!status.enrolled || status.templateVersion !== LEDGER_NATIVE_TEMPLATE || !status.ledgerSavings) return
  const account = vaultAccountRuntime(status)
  const identity = status.ledgerSavings.descriptorHash
  if (account.recoveryWatch?.identity === identity) return account.recoveryWatch
  account.recoveryWatch?.dispose()
  account.recoveryWatch = undefined
  const kit = selectLiveKit({ status, stored: loadLocalKit(status.vaultId) })
  if (!kit) return
  account.recoveryWatch = createRecoveryWatch(account, identity, kit)
  return account.recoveryWatch
}
