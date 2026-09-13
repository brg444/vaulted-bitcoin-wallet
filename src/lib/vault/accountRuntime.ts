import { createVaultAccountMaintenance, type VaultAccountMaintenance } from './accountMaintenance'
import { vaultOperatorOrigin } from './networkPins'
import type { VaultStatus } from './types'
import type { VaultBalanceController } from './accountBalances'
import type { VaultRecoveryWatch } from './accountRecoveryWatch'
import type { LedgerPayments } from './ledgerPayments'
import type { BitcoinPayments } from './bitcoinPayments'
import type { SpendingPayments } from './spendingPayments'
import type { WalletConnection } from './vtxo/walletWorker'

export interface VaultAccountRuntime {
  key: string
  vaultId: string
  network: string
  enrolled: boolean
  balances?: VaultBalanceController
  recoveryWatch?: VaultRecoveryWatch
  ledgerPayments?: LedgerPayments
  bitcoinPayments?: BitcoinPayments
  spendingPayments?: SpendingPayments
  maintenance: VaultAccountMaintenance
  listeners: Set<() => void>
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
  account.listeners.clear()
  account.balances?.dispose()
  account.recoveryWatch?.dispose()
  const payments = account.ledgerPayments?.suspend()
  const bitcoin = account.bitcoinPayments?.suspend()
  const spending = account.spendingPayments?.suspend()
  if (current === account) current = undefined
  const drain = account.maintenance.dispose()
  account.disposal = (async () => {
    await drain
    await payments
    await bitcoin
    await spending
    await account.initialization?.catch(() => undefined)
    await account.replacement?.promise.catch(() => undefined)
    await account.closeConnection?.()
  })()
  retiring = Promise.all([retiring, account.disposal]).then(() => undefined)
  // A later SDK connection still observes retirement failures through previous.
  void retiring.catch(() => undefined)
  return account.disposal
}

/** A selected account can recover status before its SDK identity is available. */
export function selectedVaultAccountRuntime(vaultId: string, network = ''): VaultAccountRuntime {
  if (!vaultId.trim()) throw new Error('Selected vault required for account state')
  if (
    current?.vaultId === vaultId &&
    !current.disposed &&
    (!network || !current.network || current.network === network)
  ) {
    if (!current.network && network) current.network = network
    return current
  }
  if (current) void disposeVaultAccountRuntime(current).catch(() => undefined)
  current = {
    key: JSON.stringify(['selected', vaultId, network]),
    vaultId,
    network,
    enrolled: false,
    maintenance: createVaultAccountMaintenance(vaultId),
    listeners: new Set(),
    disposed: false,
    previous: retiring,
  }
  return current
}

/** Status binds the selected owner once; signing-identity changes replace it. */
export function vaultAccountRuntime(status: VaultStatus): VaultAccountRuntime {
  const key = vaultWalletRuntimeKey(status)
  if (current?.key === key && !current.disposed) return current
  if (
    current &&
    (current.enrolled || current.vaultId !== status.vaultId || (current.network && current.network !== status.network))
  )
    void disposeVaultAccountRuntime(current).catch(() => undefined)
  const account = selectedVaultAccountRuntime(status.vaultId, status.network)
  account.key = key
  account.enrolled = true
  return account
}
