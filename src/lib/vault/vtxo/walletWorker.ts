import { importLightningAddressReceipts } from '../lnurl'
import { reconcileVaultLightningReceives } from '../lightningReceiveClaim'
import {
  ArkAddress,
  Estimator,
  IndexedDBContractRepository,
  IndexedDBWalletRepository,
  ReadonlySingleKey,
  RestArkProvider,
  RestIndexerProvider,
  ServiceWorkerWallet,
  type ExtendedCoin,
  type IContractManager,
  type SettleParams,
} from '@arkade-os/sdk'
import {
  IndexedDbAssetSwapRepository,
  rfqSwapActivityInputs,
  swapActivityResolver,
  type RfqSwapManager,
} from '@arkade-os/swap'
import { hex } from '@scure/base'
import { consoleError } from '../../logs'
import { vaultLatency } from '../latency'
import { ABSOLUTE_FEE_CEILING_SATS, DUST_SATS } from '../constants'
import { historyFromBoardingUtxos, historyFromSdkActivities, type VaultHistoryItem } from '../history'
import { tryVaultLightningLifecycleLock } from '../lightningLock'
import {
  createVaultLightningObserver,
  listRetiredReceiveActivityRecords,
  listVaultLightningActivityRecords,
  maintainVaultLightningObserver,
  vaultLightningSwapStorageName,
} from '../lightningLifecycle'
import type { VaultStatus } from '../types'
import { registerVaultPolicyV1ContractHandler } from './contractHandler'
import { browserVaultLockManager, type VaultLockManager } from './lock'
import {
  vaultWalletUpdaterTag,
  vaultWalletDatabase,
  vaultWalletWorkerPath,
  vaultWalletWorkerScope,
} from './walletWorkerNames'
import { hasLivePendingVtxoSpend, listPersistedVtxoSpends } from './spendingJournal'
import { vaultOperatorOrigin } from '../networkPins'
import { readSpendingBitcoin } from '../spendingBitcoinStore'
import { vtxoBalanceWithPending } from './pendingBalance'
import { requireBoardingStatus } from './board'
import {
  activeVaultAccountRuntime,
  disposeVaultAccountRuntime,
  vaultAccountRuntime,
  vaultWalletRuntimeKey,
  type VaultAccountRuntime,
} from '../accountRuntime'
import type { VaultMaintenanceTask } from '../accountMaintenance'
export { vaultWalletRuntimeKey } from '../accountRuntime'

export type WalletConnection = {
  key: string
  vaultId: string
  registration: ServiceWorkerRegistration
  wallet: ServiceWorkerWallet
  walletRepository: IndexedDBWalletRepository
  contractRepository: IndexedDBContractRepository
  swapRepository: IndexedDbAssetSwapRepository
  swapManager: RfqSwapManager
  lightningReceiveError: string
  notify: () => void
  unsubscribeContract: () => void
  unsubscribeSwap: () => void
  onWorkerMessage: (event: MessageEvent) => void
  lightningObserver: VaultMaintenanceTask<void>
  /** One shared in-flight VTXO snapshot per live connection. */
  vtxoSnapshot?: Promise<VaultWalletVtxoSnapshot>
  /** Verified balance for the current in-flight pass, plus late subscribers. */
  verifiedBalance?: VaultWalletVerifiedBalance
  verifiedBalanceSubscribers?: Set<(balance: VaultWalletVerifiedBalance) => void>
  boardingSettle?: Promise<void>
  boardingError?: string
  boardingRetryAfter?: number
}

const VAULT_WORKER_STOP_TIMEOUT_MS = 60_000
/** Idle Lightning observation fallback; events remain the primary trigger. */
const IDLE_LIGHTNING_OBSERVER_INTERVAL_MS = 15_000
/** Bounded faster fallback while a submitted Spending payment is unfinished. */
const ACTIVE_PAYMENT_OBSERVER_INTERVAL_MS = 2_000

export function isVaultWalletStateUpdate(message: unknown, updaterTag: string): boolean {
  const value = message as { tag?: string; type?: string } | null
  return value?.tag === updaterTag && (value.type === 'VTXO_UPDATE' || value.type === 'UTXO_UPDATE')
}

export function subscribeVaultLightningObserver(
  manager: Pick<RfqSwapManager, 'onSwapUpdate' | 'onSwapCompleted' | 'onSwapFailed'>,
  listener: () => void,
): () => void {
  const unsubscribers = [
    manager.onSwapUpdate(listener),
    manager.onSwapCompleted(listener),
    manager.onSwapFailed(listener),
  ]
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}

export async function waitForVaultWorkerActivation(
  registration: Pick<ServiceWorkerRegistration, 'active' | 'installing' | 'waiting'>,
  timeoutMs = 15_000,
): Promise<ServiceWorker> {
  const worker = registration.installing || registration.waiting || registration.active
  if (!worker) throw new Error('Vault wallet worker did not install')
  if (worker.state === 'activated') return worker
  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener('statechange', onStateChange)
      reject(new Error('Vault wallet worker activation timed out'))
    }, timeoutMs)
    const onStateChange = () => {
      if (worker.state === 'activated') {
        window.clearTimeout(timeout)
        worker.removeEventListener('statechange', onStateChange)
        resolve(worker)
      } else if (worker.state === 'redundant') {
        window.clearTimeout(timeout)
        worker.removeEventListener('statechange', onStateChange)
        reject(new Error('Vault wallet worker became redundant before activation'))
      }
    }
    worker.addEventListener('statechange', onStateChange)
  })
}

export async function registerVaultWalletServiceWorker(
  vaultId: string,
  serviceWorkers: Pick<ServiceWorkerContainer, 'register'> = navigator.serviceWorker,
  locks: VaultLockManager | undefined = browserVaultLockManager(),
  network?: string,
): Promise<{ registration: ServiceWorkerRegistration; worker: ServiceWorker }> {
  const register = async () => {
    const registration = await serviceWorkers.register(vaultWalletWorkerPath(vaultId, network), {
      scope: vaultWalletWorkerScope(vaultId),
      updateViaCache: 'none',
    })
    await registration.update()
    return { registration, worker: await waitForVaultWorkerActivation(registration) }
  }
  if (!locks) return register()
  return locks.request(
    `arkade-vault-wallet-worker:${vaultWalletUpdaterTag(vaultId)}`,
    { mode: 'exclusive' },
    async (lock) => {
      if (!lock) throw new Error('Web Locks API returned no Vault wallet worker lock')
      return register()
    },
  )
}

export function vaultWalletIdentity(status: VaultStatus) {
  const advertised = status.vtxoBoardingDescriptor?.boardingPub || ''
  const descriptor = requireBoardingStatus(status, advertised)
  return ReadonlySingleKey.fromPublicKey(hex.decode(descriptor.boardingPub))
}

async function disposeConnection(current: WalletConnection | undefined) {
  if (!current) return
  current.unsubscribeContract()
  current.unsubscribeSwap()
  navigator.serviceWorker.removeEventListener('message', current.onWorkerMessage)
  // Drain every page-side consumer before stopping the worker they call.
  // Otherwise an in-flight Lightning restore can race STOP and report
  // "Failed to get contracts" against an already-closed MessageBus.
  await current.lightningObserver.dispose()
  await current.swapManager.stop().catch(() => undefined)
  await current.wallet.dispose()
  await Promise.allSettled([
    current.walletRepository[Symbol.asyncDispose](),
    current.contractRepository[Symbol.asyncDispose](),
    current.swapRepository[Symbol.asyncDispose](),
  ])
  await current.registration.unregister()
}

export async function shutdownVaultWalletWorker(vaultId: string): Promise<void> {
  const id = String(vaultId || '').trim()
  if (!id) return
  const account = activeVaultAccountRuntime(id)
  if (account) {
    account.closeConnection ??= () => stopRegisteredVaultWorker(id)
    await disposeVaultAccountRuntime(account)
    return
  }
  await stopRegisteredVaultWorker(id)
}

async function stopRegisteredVaultWorker(vaultId: string): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration(vaultWalletWorkerScope(vaultId))
  if (!registration) return
  const worker = registration.active || registration.waiting || registration.installing
  if (worker) await ServiceWorkerWallet.stop(worker, VAULT_WORKER_STOP_TIMEOUT_MS)
  await registration.unregister()
}

async function createConnection(status: VaultStatus, account: VaultAccountRuntime): Promise<WalletConnection> {
  const { maintenance, listeners } = account
  registerVaultPolicyV1ContractHandler()
  const key = vaultWalletRuntimeKey(status)
  const walletDatabase = vaultWalletDatabase(status.vaultId)
  const walletRepository = new IndexedDBWalletRepository(walletDatabase)
  const contractRepository = new IndexedDBContractRepository(walletDatabase)
  const swapRepository = new IndexedDbAssetSwapRepository(vaultLightningSwapStorageName(status.vaultId))
  let registration: ServiceWorkerRegistration | undefined
  let wallet: ServiceWorkerWallet | undefined
  let swapManager: RfqSwapManager | undefined
  try {
    const registered = await registerVaultWalletServiceWorker(
      status.vaultId,
      navigator.serviceWorker,
      browserVaultLockManager(),
      status.network,
    )
    registration = registered.registration
    const serviceWorker = registered.worker
    const updaterTag = vaultWalletUpdaterTag(status.vaultId)
    const common = {
      serviceWorker,
      identity: vaultWalletIdentity(status),
      arkServerUrl: vaultOperatorOrigin(status.network),
      esploraUrl: '/esplora',
      walletMode: 'static' as const,
      walletUpdaterTag: updaterTag,
      storage: { walletRepository, contractRepository },
    }
    wallet = await ServiceWorkerWallet.create({
      ...common,
      workerOwnedIdentity: true,
      messageBusTimeoutMs: VAULT_WORKER_STOP_TIMEOUT_MS,
    })
    if ((await wallet.getBoardingAddress()) !== status.vtxoBoardingAddress) {
      throw new Error('SDK worker derived a different boarding address')
    }
    const manager = await wallet.getContractManager()
    const contract = (await manager.getContracts()).find(
      (candidate) => candidate.script === String(status.spendingArkScript || '').toLowerCase(),
    )
    if (!contract) throw new Error('SDK worker did not register the Spending contract')
    if (contract.script !== String(status.spendingArkScript || '').toLowerCase()) {
      throw new Error('SDK worker registered a different Spending contract')
    }
    if (contract.state !== 'active' || (contract.watch || 'watched') !== 'watched') {
      throw new Error('SDK worker did not activate the Spending contract')
    }
    const activityIndexer = new RestIndexerProvider(vaultOperatorOrigin(status.network))
    wallet.activity.use(
      swapActivityResolver({
        listSwaps: () => rfqSwapActivityInputs({ repository: swapRepository, indexer: activityIndexer }),
      }),
    )

    const activeSwapManager = createVaultLightningObserver({
      contracts: manager,
      indexer: activityIndexer,
      repository: swapRepository,
    })
    swapManager = activeSwapManager
    let lightningReceiveError = ''
    const maintainLightning = async () => {
      try {
        await importLightningAddressReceipts({ status, repository: swapRepository, contracts: manager })
      } catch (error) {
        consoleError(error, 'Lightning address reconciliation')
      }
      try {
        await reconcileVaultLightningReceives({ status, repository: swapRepository, contracts: manager })
        lightningReceiveError = ''
      } catch (error) {
        lightningReceiveError =
          error instanceof Error ? error.message : 'Waiting for payment status. Keep this wallet open.'
        consoleError(error, 'Lightning receive reconciliation')
      }
      return maintainVaultLightningObserver({
        manager: activeSwapManager,
        contracts: manager,
        indexer: activityIndexer,
        repository: swapRepository,
      })
    }
    const logMaintenanceFailures = (result: Awaited<ReturnType<typeof maintainLightning>>) => {
      for (const failure of result.restoreFailures) {
        consoleError(failure.error, `Lightning swap ${failure.rfqId} restore failed`)
      }
      for (const failure of result.retirementFailures) {
        consoleError(failure.error, `Lightning swap ${failure.rfqId} contract retirement failed`)
      }
    }
    const notify = () => {
      listeners.forEach((listener) => listener())
      maintenance.invalidate('wallet')
    }
    let lightningObserver: VaultMaintenanceTask<void>
    lightningObserver = maintenance.observe(
      'lightning-observer',
      async () => {
        const attempt = await tryVaultLightningLifecycleLock(status.vaultId, maintainLightning)
        if (!attempt.held) return
        logMaintenanceFailures(attempt.value)
        if (!lightningObserver.isDisposed()) notify()
      },
      {
        // Bounded faster observation while a submitted payment is unfinished,
        // then back off to the idle fallback. Wallet, contract and swap events
        // remain the primary trigger; this only shortens the fallback window.
        intervalMs: () =>
          hasLivePendingVtxoSpend(status.vaultId)
            ? ACTIVE_PAYMENT_OBSERVER_INTERVAL_MS
            : IDLE_LIGHTNING_OBSERVER_INTERVAL_MS,
        failed: (error) => consoleError(error, 'Lightning observer refresh'),
      },
    )
    const unsubscribeContract = manager.onContractEvent(() => {
      notify()
      lightningObserver.request()
    })
    const unsubscribeSwap = subscribeVaultLightningObserver(activeSwapManager, () => {
      notify()
      lightningObserver.request()
    })
    const onWorkerMessage = (event: MessageEvent) => {
      if (!isVaultWalletStateUpdate(event.data, updaterTag)) return
      notify()
      lightningObserver.request()
    }
    navigator.serviceWorker.addEventListener('message', onWorkerMessage)
    return {
      key,
      vaultId: status.vaultId,
      registration,
      wallet,
      walletRepository,
      contractRepository,
      swapRepository,
      swapManager: activeSwapManager,
      get lightningReceiveError() {
        return lightningReceiveError
      },
      notify,
      unsubscribeContract,
      unsubscribeSwap,
      onWorkerMessage,
      lightningObserver,
    }
  } catch (error) {
    let teardownError: unknown
    // A manager restore can still be reading contracts through the worker.
    // Drain it before disposing the MessageBus on initialization failures too.
    await swapManager?.stop().catch(() => undefined)
    if (wallet) {
      try {
        await wallet.dispose()
      } catch (failure) {
        teardownError = failure
      }
    }
    await Promise.allSettled([
      walletRepository[Symbol.asyncDispose](),
      contractRepository[Symbol.asyncDispose](),
      swapRepository[Symbol.asyncDispose](),
    ])
    if (!teardownError) await registration?.unregister().catch(() => undefined)
    if (teardownError) consoleError(teardownError, 'Vault wallet teardown after failed initialization')
    throw error
  }
}

export interface VaultWalletStateSession {
  wallet: ServiceWorkerWallet
  contracts: IContractManager
  swapRepository: IndexedDbAssetSwapRepository
  swapManager: RfqSwapManager
  lightningReceiveError: string
}

export async function withVaultWalletState<T>(
  status: VaultStatus,
  run: (session: VaultWalletStateSession) => Promise<T>,
): Promise<T> {
  const current = await ensureVaultWalletWorker(status)
  return run({
    wallet: current.wallet,
    contracts: await current.wallet.getContractManager(),
    swapRepository: current.swapRepository,
    swapManager: current.swapManager,
    lightningReceiveError: current.lightningReceiveError,
  })
}

export async function withActiveVaultWalletState<T>(
  vaultId: string,
  run: (session: VaultWalletStateSession) => Promise<T>,
): Promise<T> {
  const id = String(vaultId || '').trim()
  const current = activeVaultAccountRuntime(id)?.connection
  if (!current) throw new Error('Vault wallet state is not ready for this vault')
  return run({
    wallet: current.wallet,
    contracts: await current.wallet.getContractManager(),
    swapRepository: current.swapRepository,
    swapManager: current.swapManager,
    lightningReceiveError: current.lightningReceiveError,
  })
}

export async function ensureVaultWalletWorker(status: VaultStatus): Promise<WalletConnection> {
  const account = vaultAccountRuntime(status)
  if (account.connection) return account.connection
  if (account.initialization) return account.initialization
  // A draining task may reach its first SDK read after replacement begins.
  // Waiting for replacement here would make it wait for its own completion.
  if (account.replacement?.phase === 'draining') throw new Error('Vault SDK connection is being replaced')
  if (account.replacement) return account.replacement.promise
  return connectAccountWallet(status, account)
}

async function connectAccountWallet(status: VaultStatus, account: VaultAccountRuntime): Promise<WalletConnection> {
  // Failed SDK initialization can leave a registered worker without a connection.
  // Keep its STOP inside account retirement so the next owner waits for cleanup.
  account.closeConnection = () => stopRegisteredVaultWorker(status.vaultId)
  const promise = (async () => {
    await account.previous
    if (account.disposed) throw new Error('Vault account closed during worker initialization')
    const next = await createConnection(status, account)
    if (account.disposed) {
      await disposeConnection(next)
      throw new Error('Vault account closed during worker initialization')
    }
    account.connection = next
    account.closeConnection = async () => {
      await disposeConnection(next)
      if (account.connection === next) account.connection = undefined
    }
    account.maintenance.invalidate('wallet')
    // Publish Spending before foreground receipt and swap reconciliation.
    next.lightningObserver.request()
    return next
  })()
  account.initialization = promise
  try {
    return await promise
  } finally {
    if (account.initialization === promise) account.initialization = undefined
  }
}

export function subscribeVaultWalletEvents(status: VaultStatus, listener: () => void): () => void {
  const account = vaultAccountRuntime(status)
  account.listeners.add(listener)
  void ensureVaultWalletWorker(status).catch(() => undefined)
  return () => {
    account.listeners.delete(listener)
  }
}

export async function reloadVaultWalletWorker(status: VaultStatus) {
  const current = await ensureVaultWalletWorker(status)
  if (current.boardingSettle) return
  await current.wallet.reload()
  current.lightningObserver.request()
}

/** Tear down a wedged worker and create a new one so boarding can resume. */
export async function reviveVaultWalletWorker(status: VaultStatus): Promise<WalletConnection> {
  const account = vaultAccountRuntime(status)
  if (account.connection?.boardingSettle) return account.connection
  if (account.replacement) return account.replacement.promise
  const drain = Boolean(account.connection || account.initialization)
  const reconnect = async () => {
    await account.initialization?.catch(() => undefined)
    replacement.phase = 'connecting'
    const previous = account.connection
    account.connection = undefined
    await account.closeConnection?.()
    if (previous) account.closeConnection = undefined
    if (account.disposed) throw new Error('Vault account closed during worker replacement')
    return connectAccountWallet(status, account)
  }
  const replacement: NonNullable<VaultAccountRuntime['replacement']> = {
    phase: drain ? 'draining' : 'connecting',
    // A failed cold start has no SDK connection for maintenance to release.
    // Its retry must remain independent of an ongoing recovery capture.
    promise: drain ? account.maintenance.withPaused(reconnect) : reconnect(),
  }
  account.replacement = replacement
  try {
    return await replacement.promise
  } finally {
    if (account.replacement === replacement) account.replacement = undefined
  }
}

export interface VaultBoardingSettlementRuntime {
  notify: () => void
  boardingSettle?: Promise<void>
  boardingError?: string
  boardingRetryAfter?: number
}

// Each confirmed input is enumerated over 0..cap. Size the budget so later
// deposits are not starved by earlier uneconomical outpoints.
const MAX_VAULT_BOARDING_FEE_INPUTS = 16
const MAX_VAULT_BOARDING_FEE_EVALUATIONS = MAX_VAULT_BOARDING_FEE_INPUTS * (ABSOLUTE_FEE_CEILING_SATS + 1)

export async function vaultBoardingSettleParams(
  boardingUtxos: ExtendedCoin[],
  spendingAddress: string,
  absoluteFeeCapSats: number,
  provider: Pick<RestArkProvider, 'getInfo'> = new RestArkProvider(vaultOperatorOrigin()),
): Promise<SettleParams | undefined> {
  if (
    !Number.isSafeInteger(absoluteFeeCapSats) ||
    absoluteFeeCapSats < 0 ||
    absoluteFeeCapSats > ABSOLUTE_FEE_CEILING_SATS
  ) {
    throw new Error('vault-board-v1 fee cap is invalid')
  }
  const confirmed = boardingUtxos
    .filter((candidate) => candidate.status.confirmed)
    .sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
  if (confirmed.length === 0) return undefined

  const { fees, vtxoMaxAmount } = await provider.getInfo()
  let estimator: Estimator
  try {
    estimator = new Estimator(fees.intentFee)
  } catch {
    throw new Error('vault-board-v1 Operator fee policy is invalid')
  }
  const outputScript = hex.encode(ArkAddress.decode(spendingAddress).pkScript)
  let remainingFeeEvaluations = MAX_VAULT_BOARDING_FEE_EVALUATIONS
  for (const input of confirmed) {
    if (!Number.isSafeInteger(input.value) || input.value <= 0) continue
    const maxFee = Math.min(absoluteFeeCapSats, input.value - DUST_SATS)
    if (maxFee < 0) continue
    for (let candidateFee = 0; candidateFee <= maxFee; candidateFee++) {
      const amount = BigInt(input.value - candidateFee)
      if (vtxoMaxAmount >= 0n && amount > vtxoMaxAmount) continue
      if (remainingFeeEvaluations === 0) {
        throw new Error('vault-board-v1 Operator fee policy exceeds the evaluation limit')
      }
      remainingFeeEvaluations--
      let evaluated
      try {
        evaluated = estimator.evaluate([], [{ amount: BigInt(input.value) }], [{ amount, script: outputScript }], [])
      } catch {
        throw new Error('vault-board-v1 Operator fee result is invalid')
      }
      if (!Number.isFinite(evaluated.value) || evaluated.value < 0 || !Number.isSafeInteger(evaluated.satoshis)) {
        throw new Error('vault-board-v1 Operator fee result is invalid')
      }
      const exactFee = evaluated.satoshis
      if (exactFee === candidateFee) {
        return { inputs: [input], outputs: [{ address: spendingAddress, amount }] }
      }
    }
  }
  throw new Error('vault-board-v1 has no economical confirmed input within the Operator limit')
}

const VAULT_BOARDING_RETRY_DELAY_MS = 15_000

export function scheduleVaultBoardingSettlement(
  current: VaultBoardingSettlementRuntime,
  settle: () => Promise<string>,
): Promise<void> {
  if (current.boardingSettle) return current.boardingSettle
  if (Date.now() < (current.boardingRetryAfter || 0)) return Promise.resolve()
  let tracked: Promise<void>
  tracked = settle()
    .then(() => {
      current.boardingError = undefined
      current.boardingRetryAfter = undefined
      current.notify()
    })
    .catch((error) => {
      // A listener refresh must not immediately start another failed attempt.
      current.boardingRetryAfter = Date.now() + VAULT_BOARDING_RETRY_DELAY_MS
      if (!(error instanceof Error) || !error.message.includes('No inputs found')) {
        const awaitingEvidence =
          error instanceof Error && error.message.includes('final submission awaits exact VTXO evidence')
        if (!awaitingEvidence) consoleError(error, 'Vault boarding settlement')
        const message = awaitingEvidence
          ? 'Deposit is settling. Waiting for Spending confirmation.'
          : error instanceof Error && error.message.includes('final authorization cannot be released')
            ? 'Deposit boarding needs attention. Guardian could not complete this attempt. The deposit is not yet available in Spending.'
            : 'Deposit boarding is delayed. The deposit is not yet available in Spending.'
        if (current.boardingError !== message) {
          current.boardingError = message
          current.notify()
        }
      }
    })
    .finally(() => {
      if (current.boardingSettle === tracked) current.boardingSettle = undefined
    })
  current.boardingSettle = tracked
  return tracked
}

export interface VaultWalletVtxoSnapshot {
  balance: number
  pendingBalance?: number
  boardingBalance?: number
  boardingConfirmedBalance?: number
  boardingError?: string
  commitmentIds?: string[]
  recoveryVtxos?: { txid: string; vout: number; value: number; script: string }[]
  history: VaultHistoryItem[]
}

/** Verified, non-history balance facts. Safe to publish before enrichment. */
export interface VaultWalletVerifiedBalance {
  balance: number
  pendingBalance?: number
  boardingBalance?: number
  boardingConfirmedBalance?: number
}

export async function fetchVaultWalletVtxoSnapshot(
  status: VaultStatus,
  onVerifiedBalance?: (balance: VaultWalletVerifiedBalance) => void,
): Promise<VaultWalletVtxoSnapshot> {
  const current = await ensureVaultWalletWorker(status)
  // Coalesce concurrent foreground readers onto one exact account generation.
  // The connection is replaced wholesale on revive, so a shared pass can never
  // cross a generation boundary.
  //
  // Every subscriber for the same generation gets the verified balance, even
  // when it joins a pass that another caller started without a callback, or
  // after verification but while history is still loading.
  if (onVerifiedBalance) {
    if (current.verifiedBalance) onVerifiedBalance(current.verifiedBalance)
    else (current.verifiedBalanceSubscribers ??= new Set()).add(onVerifiedBalance)
  }
  if (current.vtxoSnapshot) return current.vtxoSnapshot
  // A new pass owns a fresh verified channel for this generation.
  current.verifiedBalance = undefined
  const promise = readVaultWalletVtxoSnapshot(status, current, (balance) => {
    current.verifiedBalance = balance
    const subscribers = current.verifiedBalanceSubscribers
    current.verifiedBalanceSubscribers = undefined
    if (subscribers) {
      for (const subscriber of subscribers) subscriber(balance)
      subscribers.clear()
    }
  }).finally(() => {
    if (current.vtxoSnapshot === promise) current.vtxoSnapshot = undefined
    if (!current.vtxoSnapshot) {
      current.verifiedBalance = undefined
      current.verifiedBalanceSubscribers?.clear()
      current.verifiedBalanceSubscribers = undefined
    }
  })
  current.vtxoSnapshot = promise
  return promise
}

async function readVaultWalletVtxoSnapshot(
  status: VaultStatus,
  current: WalletConnection,
  onVerifiedBalance?: (balance: VaultWalletVerifiedBalance) => void,
): Promise<VaultWalletVtxoSnapshot> {
  vaultLatency.count('snapshot')
  const manager = await current.wallet.getContractManager()
  const script = String(status.spendingArkScript || '').toLowerCase()
  const contracts = await manager.getContractsWithVtxos({ script })
  const vtxos = contracts.flatMap((contract) => contract.vtxos)
  const commitmentIds = new Set<string>()
  for (const vtxo of vtxos) {
    commitmentIds.add(vtxo.txid)
    if (vtxo.arkTxId) commitmentIds.add(vtxo.arkTxId)
    if (vtxo.settledBy) commitmentIds.add(vtxo.settledBy)
    for (const txid of vtxo.commitmentTxIds || []) commitmentIds.add(txid)
  }
  // Verified balance facts come from the VTXO set and the exact persisted
  // operations only. History enrichment below never holds them up.
  const setup = readSpendingBitcoin(status)
  const position = vtxoBalanceWithPending(
    vtxos,
    listPersistedVtxoSpends(status.vaultId),
    setup
      ? {
          txid: setup.txid,
          vout: setup.vout,
          valueSats: setup.valueSats,
          changeSats: setup.plan?.plan.changeSats,
          receiverTxid: setup.receipt?.receiverTxid,
          receiverVout: setup.receipt?.receiverVout,
          submitted: ['submitted', 'confirmed'].includes(setup.stage),
        }
      : null,
  )
  const [boardingUtxos, balance] = await Promise.all([current.wallet.getBoardingUtxos(), current.wallet.getBalance()])
  if (balance.boarding.confirmed === 0 && !current.boardingSettle) {
    current.boardingError = undefined
    current.boardingRetryAfter = undefined
  }
  if (balance.boarding.confirmed > 0) {
    void scheduleVaultBoardingSettlement(current, async () => {
      const params = await vaultBoardingSettleParams(
        boardingUtxos,
        String(status.spendingArkAddress || ''),
        status.absoluteFeeCap,
        new RestArkProvider(vaultOperatorOrigin(status.network)),
      )
      if (!params) throw new Error('No inputs found')
      return current.wallet.settle(params)
    })
  }
  onVerifiedBalance?.({
    balance: position.availableSats,
    pendingBalance: position.pendingSats,
    boardingBalance: balance.boarding.total,
    boardingConfirmedBalance: balance.boarding.confirmed,
  })
  const [activities, swapRecords, lightningRecords] = await Promise.all([
    current.wallet.getActivityHistory(),
    current.swapRepository.getAllRfqSwaps(),
    listVaultLightningActivityRecords(current.swapRepository),
  ])
  const retiredReceives = listRetiredReceiveActivityRecords({ vaultId: status.vaultId, network: status.network })
  const liveRfqIds = new Set(lightningRecords.map((record) => record.rfqId))
  const mergedLightningRecords = [
    ...lightningRecords,
    ...retiredReceives.filter((record) => !liveRfqIds.has(record.rfqId)),
  ]
  const lightningRfqIds = new Set([
    ...swapRecords
      .filter((record) => record.kind === 'lightning_send' || record.kind === 'lightning_receive')
      .map((record) => record.rfqId),
    ...retiredReceives.map((record) => record.rfqId),
  ])
  const activityHistory = historyFromSdkActivities(
    activities,
    { vaultTxids: commitmentIds, lightningRfqIds },
    mergedLightningRecords,
    { includeBoarding: true },
  )
  const knownTransactions = new Set(activityHistory.map((item) => item.txid))
  const detectedBoardingHistory = historyFromBoardingUtxos(boardingUtxos).filter(
    (item) => !knownTransactions.has(item.txid),
  )
  return {
    balance: position.availableSats,
    pendingBalance: position.pendingSats,
    commitmentIds: [...commitmentIds],
    boardingBalance: balance.boarding.total,
    boardingConfirmedBalance: balance.boarding.confirmed,
    boardingError: current.boardingError,
    history: [...detectedBoardingHistory, ...activityHistory],
  }
}
