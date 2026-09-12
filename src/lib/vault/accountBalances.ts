import { loadBalanceSnapshot, saveBalanceSnapshot, type StoredBalanceSnapshot } from './balanceStore'
import { consoleError } from '../logs'
import { fetchAddressTxs, fetchAddressUtxos, fetchOlderAddressTxs, type EsploraTx, type EsploraUtxo } from './esplora'
import {
  historyFromBoardingUtxos,
  historyFromTxs,
  mergeVaultHistory,
  olderRowKey,
  type VaultHistoryItem,
} from './history'
import { loadAddressPin, requireStatusMatchesPin, type AddressPin } from './pin'
import { fetchVaultStatus } from './status'
import {
  selectedVaultAccountRuntime,
  vaultAccountRuntime,
  vaultWalletRuntimeKey,
  type VaultAccountRuntime,
} from './accountRuntime'
import type { VaultMaintenanceTask } from './accountMaintenance'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import {
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
  reviveVaultWalletWorker,
  subscribeVaultWalletEvents,
  type VaultWalletVtxoSnapshot,
} from './vtxo/walletWorker'
import { reconcilePersistedVtxoSpend } from './vtxo/spend'
import {
  vaultAccountPositions,
  EMPTY_ACCOUNT_BALANCE_READS,
  type AccountBalanceReads,
  type AccountBalanceRead,
} from './balances'
import { fetchLedgerSavingsSnapshot } from './ledgerSavingsWallet'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { ledgerEnrollmentFromStatus } from './program/ledgerRecoveryDescriptor'

export interface VaultBalancesOptions {
  watchedSavingsAddress?: string
  addressPin: AddressPin | null
  enrollment: EnrollmentSecrets | null
  initialStatusChecked: boolean
  locked: boolean
  setStatus: (status: VaultStatus) => void
  status: VaultStatus | null
}

type VaultBalanceSnapshot = StoredBalanceSnapshot

const EMPTY_BALANCES: VaultBalanceSnapshot = {
  boardingBalance: 0,
  history: [],
  savingsSats: 0,
  savingsSpendableSats: 0,
  vtxoSpendingSats: 0,
}

function cachedAccountReads(snapshot: VaultBalanceSnapshot | null): AccountBalanceReads {
  const loaded = snapshot?.loaded ?? { spend: Boolean(snapshot), savings: Boolean(snapshot) }
  return {
    spend: { ...EMPTY_ACCOUNT_BALANCE_READS.spend, loaded: loaded.spend },
    savings: { ...EMPTY_ACCOUNT_BALANCE_READS.savings, loaded: loaded.savings },
  }
}

const FIRST_SNAPSHOT_RETRY_MS = 2_000
const FIRST_SNAPSHOT_RETRY_MAX_MS = 30_000
/** Loaded activity stays bounded: recent window plus explicitly loaded older pages. */
const MAX_ACTIVITY_ROWS = 300

export interface OlderActivityState {
  status: 'idle' | 'loading' | 'exhausted' | 'error'
  error: string
}

export interface OlderActivityResult {
  added: number
  exhausted: boolean
}

/**
 * Oldest Savings reference for the next Esplora page. Only confirmed
 * chain-ordered rows qualify: the Esplora chain cursor is meaningless for
 * mempool or synthetic rows, so without one there is nothing honest to page
 * from and the caller must stop.
 */
export function oldestSavingsTxid(history: readonly VaultHistoryItem[]): string {
  const confirmed = history.filter(
    (item) => item.account === 'savings' && item.confirmed && item.blockTime && !item.txid.startsWith('bitcoin:'),
  )
  if (confirmed.length === 0) return ''
  return confirmed.reduce((oldest, item) => ((item.blockTime || 0) < (oldest.blockTime || 0) ? item : oldest)).txid
}

/**
 * Older rows absent from a fresh fetch survive refresh; every overlap keeps
 * the fresh record, so a confirmation update or reorg is never shadowed by
 * the retained copy.
 */
export function retainOlderRows(
  older: readonly VaultHistoryItem[],
  fresh: readonly VaultHistoryItem[],
): VaultHistoryItem[] {
  if (older.length === 0) return []
  const freshKeys = new Set(fresh.map(olderRowKey))
  return older.filter((item) => !freshKeys.has(olderRowKey(item)))
}

export function confirmedUtxoBalance(utxos: EsploraUtxo[]): number {
  const unique = new Map<string, EsploraUtxo>()
  for (const utxo of utxos) unique.set(`${utxo.txid}:${utxo.vout}`, utxo)
  return [...unique.values()].reduce(
    (total, utxo) =>
      total + (utxo.status.confirmed && Number.isSafeInteger(utxo.value) && utxo.value > 0 ? utxo.value : 0),
    0,
  )
}

/** Boarding deposits sit on-chain until the SDK worker settles them into VTXOs. */
export function boardingUtxoBalance(utxos: EsploraUtxo[]): number {
  const unique = new Map<string, EsploraUtxo>()
  for (const utxo of utxos) unique.set(`${utxo.txid}:${utxo.vout}`, utxo)
  return [...unique.values()].reduce(
    (total, utxo) => total + (Number.isSafeInteger(utxo.value) && utxo.value > 0 ? utxo.value : 0),
    0,
  )
}

export interface SavingsBalance {
  total: number
  spendable: number
}

/**
 * Keeps change from a pending Savings send visible without treating an
 * unconfirmed external deposit as spendable or part of the displayed balance.
 */
export function savingsUtxoBalance(
  utxos: EsploraUtxo[],
  transactions: EsploraTx[],
  savingsAddress: string,
): SavingsBalance {
  const unique = new Map<string, EsploraUtxo>()
  for (const utxo of utxos) unique.set(`${utxo.txid}:${utxo.vout}`, utxo)
  const walletSpendTxids = new Set(
    transactions
      .filter(
        (transaction) =>
          !transaction.status.confirmed &&
          transaction.vin.some((input) => input.prevout?.scriptpubkey_address === savingsAddress),
      )
      .map((transaction) => transaction.txid),
  )
  let spendable = 0
  let pendingChange = 0
  for (const utxo of unique.values()) {
    if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) continue
    if (utxo.status.confirmed) spendable += utxo.value
    else if (walletSpendTxids.has(utxo.txid)) pendingChange += utxo.value
  }
  return { total: spendable + pendingChange, spendable }
}

/** Owns balance readiness, cached observations and bounded activity paging. */
function createVaultBalanceController(initialOptions: VaultBalancesOptions, account: VaultAccountRuntime) {
  let options = initialOptions
  let status = options.status
  let addressPin = options.addressPin
  let watchedAddress = options.watchedSavingsAddress || ''
  let locked = options.locked
  const accountId = () => account.vaultId
  const network = () => account.network
  let refreshVersion = 0
  let disposed = false
  let started = false
  let statusFlight: { version: number; id: string; promise: Promise<VaultStatus>; controller: AbortController } | null =
    null
  let users = 0
  let tasks:
    | {
        spend: VaultMaintenanceTask<void>
        savings: VaultMaintenanceTask<void>
        sync: VaultMaintenanceTask<void>
        reconnect: VaultMaintenanceTask<void>
      }
    | undefined
  const retryAttempts = { spend: 0, savings: 0 }
  const retryDelays = { spend: Infinity, savings: Infinity }
  let reconnectNeeded = false
  let workerKey = ''
  let unsubscribeWorker: (() => void) | undefined
  const hydrate = () => {
    const cached = loadBalanceSnapshot(accountId(), network())
    if (cached?.walletIdentity && account.enrolled && cached.walletIdentity !== account.key) return null
    if (
      !cached ||
      (status?.protectionTier || addressPin?.protectionTier) !== 'light' ||
      cached.watchedSavingsAddress === watchedAddress
    )
      return cached
    return {
      ...cached,
      savingsSats: 0,
      savingsSpendableSats: 0,
      loaded: { spend: cached.loaded?.spend ?? true, savings: false },
      history: cached.history.filter((item) => item.account !== 'savings'),
    }
  }
  const cached = hydrate()
  let balances = cached || EMPTY_BALANCES
  let reads = cachedAccountReads(cached)
  let olderHistory: VaultHistoryItem[] = []
  let olderActivity: OlderActivityState = { status: 'idle', error: '' }
  let olderFlight: { version: number; promise: Promise<OlderActivityResult> } | null = null
  const listeners = new Set<() => void>()
  const view = () => ({
    accountReads: reads,
    boardingError: balances.boardingError || '',
    snapshotFresh: reads.spend.fresh && reads.savings.fresh,
    history: balances.history,
    positions: vaultAccountPositions({
      boardingSats: balances.boardingBalance,
      savingsAvailableSats: balances.savingsSpendableSats,
      savingsTotalSats: balances.savingsSats,
      spendingAvailableSats: balances.vtxoSpendingSats,
      spendingPendingSats: balances.vtxoPendingSats,
    }),
    olderActivity,
    olderHistory,
  })
  let snapshot = view()
  const publish = () => {
    snapshot = view()
    for (const listener of listeners) listener()
  }
  const setOlderActivity = (next: OlderActivityState) => {
    olderActivity = next
    publish()
  }
  const publishAccount = (
    id: string,
    name: keyof AccountBalanceReads,
    read: Partial<AccountBalanceRead>,
    update?: (current: VaultBalanceSnapshot) => VaultBalanceSnapshot,
  ) => {
    const nextReads = { ...reads, [name]: { ...reads[name], ...read } }
    reads = nextReads
    if (update) {
      const next = {
        ...update(balances),
        loaded: { spend: nextReads.spend.loaded, savings: nextReads.savings.loaded },
        watchedSavingsAddress: watchedAddress,
        walletIdentity: account.key,
      }
      balances = next
      saveBalanceSnapshot(id, network(), next)
    }
    publish()
  }

  const clearRetry = (name: keyof AccountBalanceReads) => {
    retryAttempts[name] = 0
    retryDelays[name] = Infinity
  }
  const retry = (name: keyof AccountBalanceReads) => {
    const attempt = retryAttempts[name]++
    retryDelays[name] =
      attempt === 0 && !reads[name].loaded
        ? 0
        : Math.min(FIRST_SNAPSHOT_RETRY_MS * 2 ** Math.min(Math.max(0, attempt - 1), 4), FIRST_SNAPSHOT_RETRY_MAX_MS)
  }
  const readStatus = (): Promise<VaultStatus> => {
    const version = refreshVersion
    const id = accountId()
    if (statusFlight?.version === version) return statusFlight.promise
    const pin = addressPin?.vaultId === id ? addressPin : loadAddressPin(localStorage, id)
    const controller = new AbortController()
    const promise = fetchVaultStatus(controller.signal, id)
      .then((fetched) => {
        const live = pin ? requireStatusMatchesPin(fetched, pin) : fetched
        if (live.vaultId !== id || (network() && live.network !== network()))
          throw new Error('Balance status does not match the selected account')
        if (disposed || account.disposed || version !== refreshVersion)
          throw new DOMException('Account observation ended', 'AbortError')
        if (vaultAccountRuntime(live) !== account) throw new DOMException('Account identity changed', 'AbortError')
        if (balances.walletIdentity && balances.walletIdentity !== account.key) {
          balances = EMPTY_BALANCES
          reads = cachedAccountReads(null)
          olderHistory = []
          olderActivity = { status: 'idle', error: '' }
          publish()
        }
        status = live
        options.setStatus(live)
        if (started) syncWorker()
        return live
      })
      .finally(() => {
        if (statusFlight?.promise === promise) statusFlight = null
      })
    statusFlight = { version, id, promise, controller }
    return promise
  }
  const readAccount = async (name: keyof AccountBalanceReads, signal: AbortSignal) => {
    if (locked || disposed || account.disposed) return
    const version = refreshVersion
    const id = accountId()
    const active = () => !signal.aborted && !disposed && !account.disposed && !locked && version === refreshVersion
    publishAccount(id, name, { refreshing: true, fresh: false })
    try {
      const liveStatus = await readStatus()
      if (!active()) return
      const pin = addressPin?.vaultId === id ? addressPin : loadAddressPin(localStorage, id)
      const savingsAddress = liveStatus.protectionTier === 'light' ? watchedAddress : pin?.savingsAddress || ''
      const spendingAddress = liveStatus.spendingArkAddress || ''
      const boardingAddress = liveStatus.vtxoBoardingAddress || ''
      if (name === 'savings') {
        try {
          let savings = { balance: 0, spendable: 0, history: [] as VaultHistoryItem[] }
          if (liveStatus.templateVersion === LEDGER_NATIVE_TEMPLATE) {
            const value = await fetchLedgerSavingsSnapshot(ledgerEnrollmentFromStatus(liveStatus).savings)
            savings = { balance: value.totalSats, spendable: value.availableSats, history: value.history }
          } else if (liveStatus.protectionTier === 'light' && savingsAddress) {
            const [utxos, transactions] = await Promise.all([
              fetchAddressUtxos(savingsAddress, signal),
              fetchAddressTxs(savingsAddress, signal),
            ])
            const balance = savingsUtxoBalance(utxos, transactions, savingsAddress)
            savings = {
              balance: balance.total,
              spendable: balance.spendable,
              history: historyFromTxs(transactions, savingsAddress, 'savings'),
            }
          }
          if (!active()) return
          clearRetry('savings')
          publishAccount(id, 'savings', { loaded: true, fresh: true, error: '' }, (current) => ({
            ...current,
            savingsSats: savings.balance,
            savingsSpendableSats: savings.spendable,
            history: mergeVaultHistory(
              current.history.filter((item) => item.account === 'spend'),
              savings.history,
              retainOlderRows(olderHistory, savings.history),
            ).slice(0, MAX_ACTIVITY_ROWS),
          }))
        } catch (error) {
          if (!active()) return
          consoleError(error, 'Vault Savings balance refresh')
          publishAccount(id, 'savings', { fresh: false, error: 'Could not refresh Savings. Try again.' })
          retry('savings')
        }
      } else {
        try {
          const spending: VaultWalletVtxoSnapshot =
            spendingAddress && liveStatus.enrolled
              ? await fetchVaultWalletVtxoSnapshot(liveStatus)
              : { balance: 0, boardingBalance: 0, history: [] }
          if (!active()) return
          clearRetry('spend')
          publishAccount(id, 'spend', { loaded: true, fresh: true, error: '' }, (current) => ({
            ...current,
            boardingBalance: spending.boardingBalance || 0,
            boardingError: spending.boardingError,
            vtxoSpendingSats: spending.balance,
            vtxoPendingSats: spending.pendingBalance || 0,
            history: mergeVaultHistory(
              current.history.filter((item) => item.account === 'savings'),
              spending.history,
            ).slice(0, MAX_ACTIVITY_ROWS),
          }))
        } catch (error) {
          if (!active()) return
          consoleError(error, 'Vault Spending balance refresh')
          const needsRevive = !reads.spend.loaded
          // A cold-start boarding observation can show a deposit, but never
          // supplies available Spending funds or overrides an SDK snapshot.
          if (!reads.spend.loaded && boardingAddress) {
            try {
              const utxos = await fetchAddressUtxos(boardingAddress, signal)
              if (!active()) return
              publishAccount(id, 'spend', { loaded: false }, (current) => ({
                ...current,
                boardingBalance: boardingUtxoBalance(utxos),
                history: mergeVaultHistory(
                  current.history.filter((item) => item.account === 'savings'),
                  historyFromBoardingUtxos(utxos),
                ),
              }))
            } catch (failure) {
              consoleError(failure, 'Vault boarding balance refresh')
            }
          }
          if (!active()) return
          publishAccount(id, 'spend', { fresh: false, error: 'Could not refresh Spending. Try again.' })
          retry('spend')
          if (needsRevive) {
            reconnectNeeded = true
            tasks?.reconnect.request(retryDelays.spend)
            retryDelays.spend = Infinity
          }
        }
      }
    } catch (error) {
      if (!active()) return
      consoleError(error, 'Vault status refresh')
      publishAccount(id, name, { fresh: false, error: 'Could not verify this wallet. Try refreshing again.' })
      retry(name)
    } finally {
      if (active()) publishAccount(id, name, { refreshing: false })
    }
  }
  const refreshBalance = async (vaultId?: string) => {
    if (locked || disposed || account.disposed || !accountId() || (vaultId && vaultId !== accountId())) return
    const current = ensureTasks()
    try {
      await Promise.all([current.spend.refresh(), current.savings.refresh()])
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
    }
  }

  const loadOlderActivity = (): Promise<OlderActivityResult> => {
    if (locked || disposed || account.disposed) return Promise.resolve({ added: 0, exhausted: false })
    const version = refreshVersion
    const liveFlight = olderFlight
    if (liveFlight?.version === version) return liveFlight.promise
    const promise = (async (): Promise<OlderActivityResult> => {
      const requestId = accountId()
      const requestNetwork = status?.network || ''
      const memoryPin = addressPin
      const pin =
        memoryPin?.vaultId === requestId ? memoryPin : requestId ? loadAddressPin(localStorage, requestId) : null
      const savingsAddress = status?.protectionTier === 'light' ? watchedAddress : pin?.savingsAddress || ''
      const cursor = oldestSavingsTxid(balances.history)
      if (!requestId || !savingsAddress || !cursor) {
        setOlderActivity({ status: 'exhausted', error: '' })
        return { added: 0, exhausted: true }
      }
      setOlderActivity({ status: 'loading', error: '' })
      // A stale flight resolves against its own generation: vault, network, or
      // lock changes and unmount invalidate it, and its success, error, and
      // finally callbacks leave current state untouched.
      const stale = () => version !== refreshVersion
      try {
        const { transactions, exhausted } = await fetchOlderAddressTxs(savingsAddress, cursor)
        if (stale()) return { added: 0, exhausted: false }
        const currentId = accountId()
        if (currentId !== requestId || (status && status.network !== requestNetwork)) {
          return { added: 0, exhausted: false }
        }
        const fresh = historyFromTxs(transactions, savingsAddress, 'savings')
        const base = balances
        const known = new Set(base.history.map(olderRowKey))
        const unseen = fresh.filter((item) => !known.has(olderRowKey(item)))
        const merged = mergeVaultHistory(base.history, unseen).slice(0, MAX_ACTIVITY_ROWS)
        // When the oldest reference cannot advance, the next request would
        // repeat the same page: stop instead of promising every loaded payment
        // the cap cannot hold.
        const converged = oldestSavingsTxid(merged) === cursor
        const done = exhausted || converged
        const nextOlder = [...olderHistory, ...unseen].slice(-MAX_ACTIVITY_ROWS)
        olderHistory = nextOlder
        // A concurrent refresh heals through retention: it refetches balances
        // and keeps these rows while fresh evidence wins every overlap.
        const mergedSnapshot = { ...base, history: merged }
        balances = mergedSnapshot
        saveBalanceSnapshot(requestId, network(), mergedSnapshot)
        setOlderActivity({ status: done ? 'exhausted' : 'idle', error: '' })
        return { added: unseen.length, exhausted: done }
      } catch (error) {
        if (stale()) return { added: 0, exhausted: false }
        const currentId = accountId()
        if (currentId !== requestId) {
          return { added: 0, exhausted: false }
        }
        consoleError(error, 'Vault older activity load')
        setOlderActivity({ status: 'error', error: 'Could not load older activity. Try again.' })
        return { added: 0, exhausted: false }
      }
    })().finally(() => {
      if (olderFlight?.promise === promise) olderFlight = null
    })
    olderFlight = { version, promise }
    return promise
  }

  const recoverVtxoSpend = async () => {
    const current = status
    if (locked || disposed || !current?.enrolled || !current.vaultId) return
    const version = refreshVersion
    try {
      const result = await reconcilePersistedVtxoSpend(current)
      if (locked || version !== refreshVersion) return
      if (result.kind === 'receipt-finalized') {
        tasks?.spend.request()
        tasks?.savings.request()
      }
    } catch (error) {
      consoleError(error, 'VTXO spend recovery')
    }
  }

  const refreshFromEvent = () => {
    tasks?.spend.request()
    tasks?.savings.request()
  }
  const syncWorker = () => {
    const key = !locked && status?.enrolled && status.spendingArkAddress ? vaultWalletRuntimeKey(status) : ''
    if (key === workerKey) return
    unsubscribeWorker?.()
    unsubscribeWorker = undefined
    workerKey = key
    if (key && status) unsubscribeWorker = subscribeVaultWalletEvents(status, refreshFromEvent)
  }
  const ensureTasks = () => {
    if (tasks) return tasks
    const observe = account.maintenance.observe
    tasks = {
      spend: observe('spending-balance', (signal) => readAccount('spend', signal), {
        intervalMs: () => retryDelays.spend,
        events: ['wallet', 'vaulted-savings-setup'],
      }),
      savings: observe('savings-balance', (signal) => readAccount('savings', signal), {
        intervalMs: () => retryDelays.savings,
        events: ['wallet', 'vaulted-savings-setup'],
      }),
      sync: observe(
        'wallet-sync',
        async (signal) => {
          if (locked || !options.initialStatusChecked) return
          const version = refreshVersion
          try {
            const live = status || (await readStatus())
            await reloadVaultWalletWorker(live)
            if (signal.aborted || version !== refreshVersion) return
            await recoverVtxoSpend()
          } catch (error) {
            consoleError(error, 'wallet VTXO worker reload')
          } finally {
            if (!signal.aborted && version === refreshVersion) refreshFromEvent()
          }
        },
        { intervalMs: Infinity },
      ),
      reconnect: observe(
        'wallet-reconnect',
        async (signal) => {
          if (!reconnectNeeded || locked || !status?.enrolled) return
          const version = refreshVersion
          reconnectNeeded = false
          try {
            await reviveVaultWalletWorker(status)
          } catch (error) {
            consoleError(error, 'wallet VTXO worker revive')
          } finally {
            if (!signal.aborted && version === refreshVersion) refreshFromEvent()
          }
        },
        { intervalMs: Infinity, events: [] },
      ),
    }
    return tasks
  }
  const stop = () => {
    started = false
    refreshVersion++
    statusFlight?.controller.abort()
    for (const task of Object.values(tasks || {})) void task.dispose()
    tasks = undefined
    unsubscribeWorker?.()
    unsubscribeWorker = undefined
    workerKey = ''
  }
  const start = () => {
    if (started || disposed || account.disposed || locked) return
    started = true
    ensureTasks()
    syncWorker()
    if (options.initialStatusChecked) {
      void refreshBalance()
      tasks?.sync.request()
    }
  }
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refreshBalance,
    loadOlderActivity,
    update(next: VaultBalancesOptions) {
      if (disposed || account.disposed) return
      const nextId = next.status?.vaultId || next.enrollment?.vaultId || next.addressPin?.vaultId || ''
      const nextNetwork = next.status?.network || next.addressPin?.network || ''
      if (
        nextId !== account.vaultId ||
        (nextNetwork && account.network && nextNetwork !== account.network) ||
        (next.status?.enrolled && account.enrolled && vaultWalletRuntimeKey(next.status) !== account.key)
      )
        throw new Error('Balance inputs must belong to their account runtime')
      const oldLocked = locked
      const oldWatched = watchedAddress
      const oldChecked = options.initialStatusChecked
      options = next
      status = next.status || status
      addressPin = next.addressPin
      locked = next.locked
      watchedAddress = next.watchedSavingsAddress || ''
      const changedWatch = oldWatched !== watchedAddress
      if (changedWatch || oldLocked !== locked) {
        stop()
        clearRetry('spend')
        clearRetry('savings')
        reconnectNeeded = false
        statusFlight = null
        if (changedWatch && status?.protectionTier === 'light') {
          reads = { ...reads, savings: { ...EMPTY_ACCOUNT_BALANCE_READS.savings } }
          balances = {
            ...balances,
            savingsSats: 0,
            savingsSpendableSats: 0,
            loaded: { spend: reads.spend.loaded, savings: false },
            history: balances.history.filter((item) => item.account !== 'savings'),
          }
        }
        if (changedWatch) olderHistory = []
        olderActivity = { status: 'idle', error: '' }
        reads = {
          spend: { ...reads.spend, fresh: false, refreshing: false },
          savings: { ...reads.savings, fresh: false, refreshing: false },
        }
        publish()
      }
      if (users) start()
      if (started) {
        syncWorker()
        if (!oldChecked && next.initialStatusChecked) {
          void refreshBalance()
          tasks?.sync.request()
        }
      }
    },
    retain() {
      users++
      start()
      let released = false
      return () => {
        if (released) return
        released = true
        if (--users === 0) stop()
      }
    },
    dispose() {
      disposed = true
      stop()
    },
  }
  return controller
}

export type VaultBalanceController = ReturnType<typeof createVaultBalanceController>

export function vaultBalanceController(options: VaultBalancesOptions): VaultBalanceController | undefined {
  const id = options.status?.vaultId || options.enrollment?.vaultId || options.addressPin?.vaultId || ''
  if (!id) return undefined
  const account = options.status?.enrolled
    ? vaultAccountRuntime(options.status)
    : selectedVaultAccountRuntime(id, options.addressPin?.network)
  if (!account.balances) account.balances = createVaultBalanceController(options, account)
  return account.balances
}

export const EMPTY_BALANCE_VIEW = {
  accountReads: EMPTY_ACCOUNT_BALANCE_READS,
  boardingError: '',
  snapshotFresh: false,
  history: [] as VaultHistoryItem[],
  olderHistory: [] as VaultHistoryItem[],
  olderActivity: { status: 'idle', error: '' } as OlderActivityState,
  positions: vaultAccountPositions({
    boardingSats: 0,
    savingsAvailableSats: 0,
    savingsTotalSats: 0,
    spendingAvailableSats: 0,
  }),
}
