import { LIGHT_PROFILE } from '../light/contract'
import { requireLightStatus } from '../light/status'
import { registerLightContractHandler } from '../light/contractHandler'
import { storeLightWorkerDescriptor } from '../light/workerIdentity'
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
import { ABSOLUTE_FEE_CEILING_SATS, DUST_SATS } from '../constants'
import { historyFromBoardingUtxos, historyFromSdkActivities, type VaultHistoryItem } from '../history'
import { tryVaultLightningLifecycleLock } from '../lightningLock'
import {
  createVaultLightningObserver,
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
import { listPersistedVtxoSpends, vaultArkServer } from './spend'
import { vtxoBalanceWithPending } from './pendingBalance'
import { requireBoardingStatus } from './board'

type WalletRuntime = {
  key: string
  vaultId: string
  registration: ServiceWorkerRegistration
  wallet: ServiceWorkerWallet
  walletRepository: IndexedDBWalletRepository
  contractRepository: IndexedDBContractRepository
  swapRepository: IndexedDbAssetSwapRepository
  swapManager: RfqSwapManager
  listeners: Set<() => void>
  unsubscribeContract: () => void
  unsubscribeSwap: () => void
  onWorkerMessage: (event: MessageEvent) => void
  lightningObserver: VaultLightningObserverScheduler
  boardingSettle?: Promise<void>
}

let runtime: WalletRuntime | undefined
let initialization: Promise<WalletRuntime> | undefined

const VAULT_LIGHTNING_OBSERVER_INTERVAL_MS = 15_000
const VAULT_WORKER_STOP_TIMEOUT_MS = 60_000

export interface VaultLightningObserverScheduler {
  refresh: () => Promise<void>
  schedule: () => void
  isDisposed: () => boolean
  dispose: () => Promise<void>
}

/** Visible, coalesced foreground polling with deterministic resource cleanup. */
export function createVaultLightningObserverScheduler(
  run: () => Promise<void>,
  options: {
    intervalMs?: number
    debounceMs?: number
    isVisible?: () => boolean
  } = {},
): VaultLightningObserverScheduler {
  const intervalMs = options.intervalMs ?? VAULT_LIGHTNING_OBSERVER_INTERVAL_MS
  const debounceMs = options.debounceMs ?? 200
  const isVisible = options.isVisible ?? (() => document.visibilityState !== 'hidden')
  let activeRun: Promise<void> | undefined
  let disposed = false
  let scheduled = 0
  const refresh = () => {
    if (disposed || activeRun || !isVisible()) return activeRun || Promise.resolve()
    const current = run()
    const tracked = current.finally(() => {
      if (activeRun === tracked) activeRun = undefined
    })
    activeRun = tracked
    return activeRun
  }
  const schedule = () => {
    if (disposed || activeRun || scheduled || !isVisible()) return
    scheduled = window.setTimeout(() => {
      scheduled = 0
      void refresh().catch((error) => consoleError(error, 'Lightning observer refresh'))
    }, debounceMs)
  }
  const interval = window.setInterval(schedule, intervalMs)
  return {
    refresh,
    schedule,
    isDisposed: () => disposed,
    dispose: async () => {
      disposed = true
      window.clearInterval(interval)
      window.clearTimeout(scheduled)
      scheduled = 0
      await Promise.allSettled(activeRun ? [activeRun] : [])
    },
  }
}

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
  if (status.templateVersion === LIGHT_PROFILE) {
    const d = requireLightStatus(status).lightDescriptor!
    return ReadonlySingleKey.fromPublicKey(hex.decode(`02${d.ownerPub}`))
  }
  const advertised = status.vtxoBoardingDescriptor?.boardingPub || ''
  const descriptor = requireBoardingStatus(status, advertised)
  return ReadonlySingleKey.fromPublicKey(hex.decode(descriptor.boardingPub))
}

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
    vaultArkServer(status.network),
  ])
}

async function disposeRuntime(current: WalletRuntime | undefined) {
  if (!current) return
  await current.wallet.dispose()
  current.unsubscribeContract()
  current.unsubscribeSwap()
  navigator.serviceWorker.removeEventListener('message', current.onWorkerMessage)
  await current.lightningObserver.dispose()
  await current.swapManager.stop().catch(() => undefined)
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
  const pending = initialization
  if (pending) await pending.catch(() => undefined)
  const current = runtime?.vaultId === id ? runtime : undefined
  if (current) await disposeRuntime(current)
  if (runtime === current) runtime = undefined
  if (current) return
  const registration = await navigator.serviceWorker.getRegistration(vaultWalletWorkerScope(id))
  if (!registration) return
  const worker = registration.active || registration.waiting || registration.installing
  if (worker) await ServiceWorkerWallet.stop(worker, VAULT_WORKER_STOP_TIMEOUT_MS)
  await registration.unregister()
}

async function createRuntime(status: VaultStatus): Promise<WalletRuntime> {
  registerVaultPolicyV1ContractHandler()
  if (status.templateVersion === LIGHT_PROFILE) {
    registerLightContractHandler()
    await storeLightWorkerDescriptor(requireLightStatus(status).lightDescriptor!)
  }
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
      arkServerUrl: vaultArkServer(status.network),
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
    if (
      status.templateVersion !== LIGHT_PROFILE &&
      (await wallet.getBoardingAddress()) !== status.vtxoBoardingAddress
    ) {
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
    const activityIndexer = new RestIndexerProvider(vaultArkServer(status.network))
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
    const maintainLightning = () =>
      maintainVaultLightningObserver({
        manager: activeSwapManager,
        contracts: manager,
        indexer: activityIndexer,
        repository: swapRepository,
      })
    const logMaintenanceFailures = (result: Awaited<ReturnType<typeof maintainLightning>>) => {
      for (const failure of result.restoreFailures) {
        consoleError(failure.error, `Lightning swap ${failure.rfqId} restore failed`)
      }
      for (const failure of result.retirementFailures) {
        consoleError(failure.error, `Lightning swap ${failure.rfqId} contract retirement failed`)
      }
    }
    try {
      const initialMaintenance = await tryVaultLightningLifecycleLock(status.vaultId, maintainLightning)
      if (initialMaintenance.held) logMaintenanceFailures(initialMaintenance.value)
    } catch (error) {
      // Lightning observation is auxiliary to Spending state. A busy or
      // unavailable observer is retried by focus and the bounded
      // visible timer; it must not strand Home balance initialization.
      consoleError(error, 'Lightning observer initial refresh')
    }

    const listeners = new Set<() => void>()
    const notify = () => listeners.forEach((listener) => listener())
    let lightningObserver: VaultLightningObserverScheduler
    lightningObserver = createVaultLightningObserverScheduler(async () => {
      const attempt = await tryVaultLightningLifecycleLock(status.vaultId, maintainLightning)
      if (!attempt.held) return
      logMaintenanceFailures(attempt.value)
      if (!lightningObserver.isDisposed()) notify()
    })
    const unsubscribeContract = manager.onContractEvent(() => {
      notify()
      lightningObserver.schedule()
    })
    const unsubscribeSwap = subscribeVaultLightningObserver(activeSwapManager, () => {
      notify()
      lightningObserver.schedule()
    })
    const onWorkerMessage = (event: MessageEvent) => {
      if (!isVaultWalletStateUpdate(event.data, updaterTag)) return
      notify()
      lightningObserver.schedule()
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
      listeners,
      unsubscribeContract,
      unsubscribeSwap,
      onWorkerMessage,
      lightningObserver,
    }
  } catch (error) {
    let teardownError: unknown
    if (wallet) {
      try {
        await wallet.dispose()
      } catch (failure) {
        teardownError = failure
      }
    }
    await swapManager?.stop().catch(() => undefined)
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
  })
}

export async function withActiveVaultWalletState<T>(
  vaultId: string,
  run: (session: VaultWalletStateSession) => Promise<T>,
): Promise<T> {
  const id = String(vaultId || '').trim()
  if (!id || runtime?.vaultId !== id) throw new Error('Vault wallet state is not ready for this vault')
  return run({
    wallet: runtime.wallet,
    contracts: await runtime.wallet.getContractManager(),
    swapRepository: runtime.swapRepository,
    swapManager: runtime.swapManager,
  })
}

export async function ensureVaultWalletWorker(status: VaultStatus): Promise<WalletRuntime> {
  const key = vaultWalletRuntimeKey(status)
  if (runtime?.key === key) return runtime
  if (initialization) {
    const pending = await initialization
    if (pending.key === key) return pending
  }
  initialization = (async () => {
    if (runtime?.key === key) return runtime
    const previous = runtime
    await disposeRuntime(previous)
    if (runtime === previous) runtime = undefined
    const next = await createRuntime(status)
    runtime = next
    return next
  })()
  try {
    return await initialization
  } finally {
    initialization = undefined
  }
}

export function subscribeVaultWalletEvents(status: VaultStatus, listener: () => void): () => void {
  let active = true
  let current: WalletRuntime | undefined
  void ensureVaultWalletWorker(status)
    .then((next) => {
      if (!active) return
      current = next
      current.listeners.add(listener)
    })
    .catch(() => undefined)
  return () => {
    active = false
    current?.listeners.delete(listener)
  }
}

export async function reloadVaultWalletWorker(status: VaultStatus) {
  const current = await ensureVaultWalletWorker(status)
  if (current.boardingSettle) return
  await current.lightningObserver.refresh()
  await current.wallet.reload()
}

/** Tear down a wedged worker and create a new one so boarding can resume. */
export async function reviveVaultWalletWorker(status: VaultStatus): Promise<WalletRuntime> {
  if (runtime?.vaultId === status.vaultId && runtime.boardingSettle) return runtime
  await shutdownVaultWalletWorker(status.vaultId).catch((error) => {
    consoleError(error, 'Vault wallet worker shutdown before revive')
  })
  return ensureVaultWalletWorker(status)
}

export interface VaultBoardingSettlementRuntime {
  listeners: Set<() => void>
  boardingSettle?: Promise<void>
}

// Each confirmed input is enumerated over 0..cap. Size the budget so later
// deposits are not starved by earlier uneconomical outpoints.
const MAX_VAULT_BOARDING_FEE_INPUTS = 16
const MAX_VAULT_BOARDING_FEE_EVALUATIONS = MAX_VAULT_BOARDING_FEE_INPUTS * (ABSOLUTE_FEE_CEILING_SATS + 1)

export async function vaultBoardingSettleParams(
  boardingUtxos: ExtendedCoin[],
  spendingAddress: string,
  absoluteFeeCapSats: number,
  provider: Pick<RestArkProvider, 'getInfo'> = new RestArkProvider(vaultArkServer()),
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

export function scheduleVaultBoardingSettlement(
  current: VaultBoardingSettlementRuntime,
  settle: () => Promise<string>,
): Promise<void> {
  if (current.boardingSettle) return current.boardingSettle
  let tracked: Promise<void>
  tracked = settle()
    .then(() => {
      current.listeners.forEach((listener) => listener())
    })
    .catch((error) => {
      if (!(error instanceof Error) || !error.message.includes('No inputs found')) {
        consoleError(error, 'Vault boarding settlement')
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
  commitmentIds?: string[]
  history: VaultHistoryItem[]
}

export async function fetchVaultWalletVtxoSnapshot(status: VaultStatus): Promise<VaultWalletVtxoSnapshot> {
  const current = await ensureVaultWalletWorker(status)
  const manager = await current.wallet.getContractManager()
  const script = String(status.spendingArkScript || '').toLowerCase()
  const contracts = await manager.getContractsWithVtxos({ script })
  const vtxos = contracts.flatMap((contract) => contract.vtxos)
  const commitmentIds = new Set<string>()
  for (const vtxo of vtxos) {
    commitmentIds.add(vtxo.txid)
    if (vtxo.arkTxId) commitmentIds.add(vtxo.arkTxId)
    for (const txid of vtxo.commitmentTxIds || []) commitmentIds.add(txid)
  }
  const [activities, swapRecords, lightningRecords, boardingUtxos, balance] = await Promise.all([
    current.wallet.getActivityHistory(),
    current.swapRepository.getAllRfqSwaps(),
    listVaultLightningActivityRecords(current.swapRepository),
    current.wallet.getBoardingUtxos(),
    current.wallet.getBalance(),
  ])
  if (status.templateVersion !== LIGHT_PROFILE && balance.boarding.confirmed > 0) {
    void scheduleVaultBoardingSettlement(current, async () => {
      const params = await vaultBoardingSettleParams(
        boardingUtxos,
        String(status.spendingArkAddress || ''),
        status.absoluteFeeCap,
        new RestArkProvider(vaultArkServer(status.network)),
      )
      if (!params) throw new Error('No inputs found')
      return current.wallet.settle(params)
    })
  }
  const lightningRfqIds = new Set(
    swapRecords.filter((record) => record.kind === 'lightning_send').map((record) => record.rfqId),
  )
  const activityHistory = historyFromSdkActivities(
    activities,
    { vaultTxids: commitmentIds, lightningRfqIds },
    lightningRecords,
    { includeBoarding: true },
  )
  const knownTransactions = new Set(activityHistory.map((item) => item.txid))
  const detectedBoardingHistory = historyFromBoardingUtxos(boardingUtxos).filter(
    (item) => !knownTransactions.has(item.txid),
  )
  const position = vtxoBalanceWithPending(vtxos, listPersistedVtxoSpends(status.vaultId))
  return {
    balance: position.availableSats,
    pendingBalance: position.pendingSats,
    commitmentIds: [...commitmentIds],
    boardingBalance: status.templateVersion === LIGHT_PROFILE ? 0 : balance.boarding.total,
    boardingConfirmedBalance: status.templateVersion === LIGHT_PROFILE ? 0 : balance.boarding.confirmed,
    history: [...detectedBoardingHistory, ...activityHistory],
  }
}
