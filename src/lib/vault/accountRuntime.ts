import { createVaultAccountMaintenance, type VaultAccountMaintenance } from './accountMaintenance'
import { vaultOperatorOrigin } from './networkPins'
import type { VaultStatus } from './types'
import type { WalletConnection } from './vtxo/walletWorker'

export interface VaultAccountRuntime {
  key: string
  vaultId: string
  maintenance: VaultAccountMaintenance
  disposed: boolean
  previous: Promise<void>
  connection?: WalletConnection
  initialization?: Promise<WalletConnection>
  replacement?: { phase: 'draining' | 'connecting'; promise: Promise<WalletConnection> }
  closeConnection?: () => Promise<void>
  disposal?: Promise<void>
}

let current: VaultAccountRuntime | undefined
let retiring = Promise.resolve()

export function vaultWalletRuntimeKey(status: VaultStatus) {
  if (!status.enrolled || !status.vaultId) throw new Error('Enrolled vault required for VTXO state')
  return JSON.stringify([
    status.vaultId,
    status.network,
    String(status.phoneBip340Pub || '').toLowerCase(),
    String(status.spendingArkScript || '').toLowerCase(),
    String(status.spendingArkAddress || ''),
    String(status.vtxoBoardingScript || '').toLowerCase(),
    String(status.vtxoBoardingAddress || ''),
    String(status.vtxoBoardingDescriptorHash || ''),
    vaultOperatorOrigin(status.network),
  ])
}

export function activeVaultAccountRuntime(vaultId: string) {
  return current?.vaultId === vaultId && !current.disposed ? current : undefined
}

export function disposeVaultAccountRuntime(account: VaultAccountRuntime): Promise<void> {
  if (account.disposal) return account.disposal
  account.disposed = true
  if (current === account) current = undefined
  const drain = account.maintenance.dispose()
  account.disposal = (async () => {
    await drain
    await account.initialization?.catch(() => undefined)
    await account.replacement?.promise.catch(() => undefined)
    await account.closeConnection?.()
  })()
  retiring = Promise.all([retiring, account.disposal]).then(() => undefined)
  // A later SDK connection still observes retirement failures through previous.
  void retiring.catch(() => undefined)
  return account.disposal
}

/** Scheduling exists before SDK availability; this is the SDK connection's owner. */
export function vaultAccountRuntime(status: VaultStatus): VaultAccountRuntime {
  const key = vaultWalletRuntimeKey(status)
  if (current?.key === key && !current.disposed) return current
  if (current) void disposeVaultAccountRuntime(current).catch(() => undefined)
  current = {
    key,
    vaultId: status.vaultId,
    maintenance: createVaultAccountMaintenance(status.vaultId),
    disposed: false,
    previous: retiring,
  }
  return current
}
