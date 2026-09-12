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
import { vaultWalletRuntimeKey } from './accountRuntime'
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

type AccountFlight = { version: number; promise: Promise<void> }

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
export function createVaultBalanceController(initialOptions: VaultBalancesOptions) {
  let options = initialOptions
  let status = options.status
  let addressPin = options.addressPin
  let enrollment = options.enrollment
  let watchedAddress = options.watchedSavingsAddress || ''
  let locked = options.locked
  const accountId = () => status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || ''
  const network = () => status?.network || addressPin?.network || ''
  let scopeId = accountId()
  let scopeNetwork = network()
  let refreshVersion = 0
  let disposed = false
  let started = false
  let accountFlights: Partial<Record<keyof AccountBalanceReads, AccountFlight>> = {}
  let statusFlight: { version: number; id: string; promise: Promise<VaultStatus> } | null = null
  let retryTimer = 0
  let retryAttempt = 0
  let eventTimer = 0
  let workerKey = ''
  let unsubscribeWorker: (() => void) | undefined
  const hydrate = () => {
    const cached = loadBalanceSnapshot(scopeId, scopeNetwork)
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
  const clearSnapshotRetry = () => {
    retryAttempt = 0
    window.clearTimeout(retryTimer)
  }

  const publishAccount = (
    id: string,
    account: keyof AccountBalanceReads,
    read: Partial<AccountBalanceRead>,
    update?: (current: VaultBalanceSnapshot) => VaultBalanceSnapshot,
  ) => {
    const nextReads = { ...reads, [account]: { ...reads[account], ...read } }
    reads = nextReads
    if (update) {
      const next = {
        ...update(balances),
        loaded: { spend: nextReads.spend.loaded, savings: nextReads.savings.loaded },
        watchedSavingsAddress: watchedAddress,
      }
      balances = next
      saveBalanceSnapshot(id, network(), next)
    }
    publish()
  }

  const scheduleSnapshotRetry = (vaultId: string, revive = false) => {
    if (!vaultId || locked) return
    window.clearTimeout(retryTimer)
    const delay =
      retryAttempt === 0
        ? revive || !reads.spend.loaded || !reads.savings.loaded
          ? 0
          : FIRST_SNAPSHOT_RETRY_MS
        : Math.min(FIRST_SNAPSHOT_RETRY_MS * 2 ** (retryAttempt - 1), FIRST_SNAPSHOT_RETRY_MAX_MS)
    retryAttempt = Math.min(retryAttempt + 1, 4)
    const version = refreshVersion
    retryTimer = window.setTimeout(() => {
      if (locked || version !== refreshVersion) return
      const current = status
      if (revive && current?.enrolled && current.vaultId === vaultId) {
        void reviveVaultWalletWorker(current)
          .catch((error) => consoleError(error, 'wallet VTXO worker revive'))
          .finally(() => {
            if (!locked && !disposed && version === refreshVersion) void refreshBalance(vaultId)
          })
      } else void refreshBalance(vaultId)
    }, delay)
  }

  const refreshBalance = async (vaultId?: string) => {
    if (locked || disposed) return
    const version = refreshVersion
    const id = String(vaultId || status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || '').trim()
    const active = () =>
      version === refreshVersion &&
      !locked &&
      !disposed &&
      (status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || '') === id
    if (!id || !active()) return
    try {
      let flight = statusFlight
      if (!flight || flight.version !== version || flight.id !== id) {
        const memoryPin = addressPin
        const pin = memoryPin?.vaultId === id ? memoryPin : loadAddressPin(localStorage, id)
        const promise = fetchVaultStatus(undefined, id).then((fetched) =>
          pin ? requireStatusMatchesPin(fetched, pin) : fetched,
        )
        flight = { version, id, promise }
        statusFlight = flight
      }
      let liveStatus: VaultStatus
      try {
        liveStatus = await flight.promise
      } finally {
        if (statusFlight === flight) statusFlight = null
      }
      if (!active()) return
      if (liveStatus.vaultId !== id || (network() && liveStatus.network !== network()))
        throw new Error('Balance status does not match the selected account')
      status = liveStatus
      scopeNetwork = liveStatus.network
      options.setStatus(liveStatus)
      if (started) syncWorker()
      const memoryPin = addressPin
      const pin = memoryPin?.vaultId === id ? memoryPin : loadAddressPin(localStorage, id)
      const savingsAddress = liveStatus.protectionTier === 'light' ? watchedAddress : pin?.savingsAddress || ''
      const spendingAddress = liveStatus.spendingArkAddress || ''
      const boardingAddress = liveStatus.vtxoBoardingAddress || ''
      const runAccount = (account: keyof AccountBalanceReads, run: () => Promise<void>) => {
        const current = accountFlights[account]
        if (current?.version === version) return current.promise
        publishAccount(id, account, { refreshing: true, fresh: false })
        const next: AccountFlight = { version, promise: Promise.resolve() }
        next.promise = Promise.resolve()
          .then(run)
          .finally(() => {
            if (accountFlights[account] === next) delete accountFlights[account]
            if (active()) publishAccount(id, account, { refreshing: false })
          })
        accountFlights[account] = next
        return next.promise
      }
      const savingsTask = runAccount('savings', async () => {
        try {
          let savings = { balance: 0, spendable: 0, history: [] as VaultHistoryItem[] }
          if (liveStatus.templateVersion === LEDGER_NATIVE_TEMPLATE) {
            const value = await fetchLedgerSavingsSnapshot(ledgerEnrollmentFromStatus(liveStatus).savings)
            savings = { balance: value.totalSats, spendable: value.availableSats, history: value.history }
          } else if (liveStatus.protectionTier === 'light' && savingsAddress) {
            const [utxos, transactions] = await Promise.all([
              fetchAddressUtxos(savingsAddress),
              fetchAddressTxs(savingsAddress),
            ])
            const balance = savingsUtxoBalance(utxos, transactions, savingsAddress)
            savings = {
              balance: balance.total,
              spendable: balance.spendable,
              history: historyFromTxs(transactions, savingsAddress, 'savings'),
            }
          }
          if (!active()) return
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
          scheduleSnapshotRetry(id)
        }
      })
      const spendingTask = runAccount('spend', async () => {
        try {
          const spending: VaultWalletVtxoSnapshot =
            spendingAddress && liveStatus.enrolled
              ? await fetchVaultWalletVtxoSnapshot(liveStatus)
              : { balance: 0, boardingBalance: 0, history: [] }
          if (!active()) return
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
              const utxos = await fetchAddressUtxos(boardingAddress)
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
          scheduleSnapshotRetry(id, needsRevive)
        }
      })
      await Promise.all([savingsTask, spendingTask])
      if (active() && reads.spend.fresh && reads.savings.fresh) clearSnapshotRetry()
    } catch (error) {
      if (!active()) return
      consoleError(error, 'Vault status refresh')
      for (const account of ['spend', 'savings'] as const)
        publishAccount(id, account, { fresh: false, error: 'Could not verify this wallet. Try refreshing again.' })
      scheduleSnapshotRetry(id)
    }
  }

  const loadOlderActivity = (): Promise<OlderActivityResult> => {
    if (locked || disposed) return Promise.resolve({ added: 0, exhausted: false })
    const version = refreshVersion
    const liveFlight = olderFlight
    if (liveFlight?.version === version) return liveFlight.promise
    const promise = (async (): Promise<OlderActivityResult> => {
      const requestId = String(status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || '').trim()
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
        const currentId = String(status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || '').trim()
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
        const currentId = String(status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || '').trim()
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
      if (result.kind === 'receipt-finalized') await refreshBalance(current.vaultId)
    } catch (error) {
      consoleError(error, 'VTXO spend recovery')
    }
  }

  const refreshFromEvent = () => {
    window.clearTimeout(eventTimer)
    eventTimer = window.setTimeout(() => void refreshBalance(), 200)
  }
  const syncWorker = () => {
    const key = !locked && status?.enrolled && status.spendingArkAddress ? vaultWalletRuntimeKey(status) : ''
    if (key === workerKey) return
    unsubscribeWorker?.()
    unsubscribeWorker = undefined
    workerKey = key
    if (key && status) unsubscribeWorker = subscribeVaultWalletEvents(status, refreshFromEvent)
  }
  const onFocus = () => {
    if (locked || disposed || !options.initialStatusChecked || !accountId()) return
    const version = refreshVersion
    if (status?.enrolled) {
      void reloadVaultWalletWorker(status)
        .catch((error) => consoleError(error, 'wallet VTXO worker reload'))
        .finally(() => {
          if (locked || disposed || version !== refreshVersion) return
          void recoverVtxoSpend()
          void refreshBalance()
        })
    } else void refreshBalance()
  }
  const initialRead = () => {
    if (!locked && options.initialStatusChecked && accountId()) {
      void refreshBalance()
      void recoverVtxoSpend()
    }
  }
  return {
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
      const oldLocked = locked
      const oldWatched = watchedAddress
      const oldChecked = options.initialStatusChecked
      const previousIdentity = status?.enrolled ? vaultWalletRuntimeKey(status) : ''
      const nextId = next.status?.vaultId || next.enrollment?.vaultId || next.addressPin?.vaultId || ''
      options = next
      status = next.status || (status?.vaultId === nextId ? status : null)
      addressPin = next.addressPin
      enrollment = next.enrollment
      locked = next.locked
      watchedAddress = next.watchedSavingsAddress || ''
      const currentIdentity = status?.enrolled ? vaultWalletRuntimeKey(status) : ''
      const changedIdentity = Boolean(
        scopeId === accountId() &&
          scopeNetwork === network() &&
          previousIdentity &&
          currentIdentity &&
          previousIdentity !== currentIdentity,
      )
      const changedAccount = scopeId !== accountId() || scopeNetwork !== network() || changedIdentity
      const changedWatch = oldWatched !== watchedAddress
      const changedScope = changedAccount || changedWatch || oldLocked !== locked
      if (changedScope) {
        refreshVersion++
        window.clearTimeout(retryTimer)
        window.clearTimeout(eventTimer)
        retryAttempt = 0
        accountFlights = {}
        statusFlight = null
        if (changedAccount) {
          scopeId = accountId()
          scopeNetwork = network()
          const cached = changedIdentity ? null : hydrate()
          balances = cached || EMPTY_BALANCES
          reads = cachedAccountReads(cached)
        }
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
        if (changedAccount || changedWatch) olderHistory = []
        olderActivity = { status: 'idle', error: '' }
        reads = {
          spend: { ...reads.spend, fresh: false, refreshing: false },
          savings: { ...reads.savings, fresh: false, refreshing: false },
        }
        publish()
      }
      if (started) {
        syncWorker()
        if (changedScope || (!oldChecked && next.initialStatusChecked)) initialRead()
      }
    },
    start() {
      if (started) return
      disposed = false
      started = true
      syncWorker()
      window.addEventListener('focus', onFocus)
      window.addEventListener('online', onFocus)
      window.addEventListener('vaulted-savings-setup', refreshFromEvent)
      initialRead()
    },
    dispose() {
      disposed = true
      started = false
      refreshVersion++
      window.clearTimeout(retryTimer)
      window.clearTimeout(eventTimer)
      unsubscribeWorker?.()
      unsubscribeWorker = undefined
      workerKey = ''
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      window.removeEventListener('vaulted-savings-setup', refreshFromEvent)
    },
  }
}
