import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { loadBalanceSnapshot, saveBalanceSnapshot } from '../lib/vault/balanceStore'
import { consoleError } from '../lib/logs'
import {
  fetchAddressTxs,
  fetchAddressUtxos,
  fetchOlderAddressTxs,
  type EsploraTx,
  type EsploraUtxo,
} from '../lib/vault/esplora'
import {
  historyFromBoardingUtxos,
  historyFromTxs,
  mergeVaultHistory,
  olderRowKey,
  type VaultHistoryItem,
} from '../lib/vault/history'
import { loadAddressPin, requireStatusMatchesPin, type AddressPin } from '../lib/vault/pin'
import { fetchVaultStatus } from '../lib/vault/status'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import {
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
  reviveVaultWalletWorker,
  subscribeVaultWalletEvents,
  type VaultWalletVtxoSnapshot,
} from '../lib/vault/vtxo/walletWorker'
import { reconcilePersistedVtxoSpend } from '../lib/vault/vtxo/spend'
import {
  vaultAccountPositions,
  EMPTY_ACCOUNT_BALANCE_READS,
  type AccountBalanceReads,
  type AccountBalanceRead,
} from './balances'
import { fetchLedgerSavingsSnapshot } from '../lib/vault/ledgerSavingsWallet'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { ledgerEnrollmentFromStatus } from '../lib/vault/program/ledgerRecoveryDescriptor'

interface VaultBalancesOptions {
  watchedSavingsAddress?: string
  addressPin: AddressPin | null
  enrollment: EnrollmentSecrets | null
  initialStatusChecked: boolean
  locked: boolean
  setStatus: Dispatch<SetStateAction<VaultStatus | null>>
  status: VaultStatus | null
}

interface VaultBalanceSnapshot {
  loaded?: { spend: boolean; savings: boolean }
  boardingBalance: number
  boardingError?: string
  history: VaultHistoryItem[]
  savingsSats: number
  savingsSpendableSats: number
  vtxoSpendingSats: number
  vtxoPendingSats?: number
}

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

// UI components consume the persistent SDK worker's balance and activity
// snapshots; they never own settlement, Operator, or indexer lifecycle.
export function useVaultBalances({
  watchedSavingsAddress = '',
  addressPin,
  enrollment,
  initialStatusChecked,
  locked,
  setStatus,
  status,
}: VaultBalancesOptions) {
  const watchedAddressRef = useRef(watchedSavingsAddress)
  watchedAddressRef.current = watchedSavingsAddress
  const refreshVersion = useRef(0)
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const accountFlights = useRef<Partial<Record<keyof AccountBalanceReads, AccountFlight>>>({})
  const statusFlight = useRef<{ version: number; id: string; promise: Promise<VaultStatus> } | null>(null)
  const statusRef = useRef(status)
  const addressPinRef = useRef(addressPin)
  const enrollmentRef = useRef(enrollment)
  const retryTimerRef = useRef(0)
  const retryAttemptRef = useRef(0)
  const refreshBalanceRef = useRef<(vaultId?: string) => Promise<void>>(async () => undefined)
  statusRef.current = status
  addressPinRef.current = addressPin
  enrollmentRef.current = enrollment

  const refreshVaultId = status?.vaultId || enrollment?.vaultId || addressPin?.vaultId || ''
  const [hydratedVaultId, setHydratedVaultId] = useState(refreshVaultId)
  const [snapshot, setSnapshot] = useState<VaultBalanceSnapshot>(
    () => loadBalanceSnapshot(refreshVaultId) || EMPTY_BALANCES,
  )
  const [accountReads, setAccountReads] = useState<AccountBalanceReads>(() =>
    cachedAccountReads(loadBalanceSnapshot(refreshVaultId)),
  )
  const readsRef = useRef(accountReads)
  readsRef.current = accountReads
  const snapshotFresh = accountReads.spend.fresh && accountReads.savings.fresh
  const [olderActivity, setOlderActivity] = useState<OlderActivityState>({ status: 'idle', error: '' })
  // Browsing history loaded beyond the recent window. Refresh retention
  // keeps these rows while fresh evidence wins every overlap; arrival
  // observation excludes them so old receipts never banner as new.
  const [olderHistory, setOlderHistory] = useState<VaultHistoryItem[]>([])
  const olderHistoryRef = useRef<VaultHistoryItem[]>([])
  // Older-page request generation. Every vault, network, or lock transition
  // and unmount invalidates pending flights; stale callbacks mutate nothing.
  const generationRef = useRef(0)
  const olderFlightRef = useRef<{ token: number; generation: number; promise: Promise<OlderActivityResult> } | null>(
    null,
  )
  const flightTokenRef = useRef(0)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  if (hydratedVaultId !== refreshVaultId) {
    const cachedSnapshot = loadBalanceSnapshot(refreshVaultId)
    setHydratedVaultId(refreshVaultId)
    refreshVersion.current += 1
    generationRef.current += 1
    setSnapshot(cachedSnapshot || EMPTY_BALANCES)
    readsRef.current = cachedAccountReads(cachedSnapshot)
    setAccountReads(readsRef.current)
    setOlderActivity({ status: 'idle', error: '' })
    setOlderHistory([])
    olderHistoryRef.current = []
    retryAttemptRef.current = 0
    window.clearTimeout(retryTimerRef.current)
  }

  useEffect(() => {
    refreshVersion.current += 1
    generationRef.current += 1
    setOlderHistory([])
    olderHistoryRef.current = []
    setOlderActivity({ status: 'idle', error: '' })
    if (statusRef.current?.protectionTier === 'light') {
      readsRef.current = { ...readsRef.current, savings: { ...EMPTY_ACCOUNT_BALANCE_READS.savings } }
      setAccountReads(readsRef.current)
      setSnapshot((current) => ({
        ...current,
        loaded: { spend: readsRef.current.spend.loaded, savings: false },
        savingsSats: 0,
        savingsSpendableSats: 0,
        history: current.history.filter((tx) => tx.account !== 'savings'),
      }))
    }
  }, [watchedSavingsAddress])

  const { boardingBalance, history, savingsSats, savingsSpendableSats, vtxoSpendingSats, vtxoPendingSats } = snapshot
  const positions = useMemo(
    () =>
      vaultAccountPositions({
        boardingSats: boardingBalance,
        savingsAvailableSats: savingsSpendableSats,
        savingsTotalSats: savingsSats,
        spendingAvailableSats: vtxoSpendingSats,
        spendingPendingSats: vtxoPendingSats,
      }),
    [boardingBalance, savingsSats, savingsSpendableSats, vtxoSpendingSats, vtxoPendingSats],
  )

  const clearSnapshotRetry = useCallback(() => {
    retryAttemptRef.current = 0
    window.clearTimeout(retryTimerRef.current)
  }, [])

  const publishAccount = useCallback(
    (
      id: string,
      account: keyof AccountBalanceReads,
      read: Partial<AccountBalanceRead>,
      update?: (current: VaultBalanceSnapshot) => VaultBalanceSnapshot,
    ) => {
      const nextReads = { ...readsRef.current, [account]: { ...readsRef.current[account], ...read } }
      readsRef.current = nextReads
      setAccountReads(nextReads)
      if (update) {
        const next = {
          ...update(snapshotRef.current),
          loaded: { spend: nextReads.spend.loaded, savings: nextReads.savings.loaded },
        }
        snapshotRef.current = next
        setSnapshot(next)
        saveBalanceSnapshot(id, next)
      }
    },
    [],
  )

  const scheduleSnapshotRetry = useCallback((vaultId: string, revive = false) => {
    if (!vaultId || lockedRef.current) return
    window.clearTimeout(retryTimerRef.current)
    const delay =
      retryAttemptRef.current === 0
        ? revive || !readsRef.current.spend.loaded || !readsRef.current.savings.loaded
          ? 0
          : FIRST_SNAPSHOT_RETRY_MS
        : Math.min(FIRST_SNAPSHOT_RETRY_MS * 2 ** (retryAttemptRef.current - 1), FIRST_SNAPSHOT_RETRY_MAX_MS)
    retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 4)
    const version = refreshVersion.current
    retryTimerRef.current = window.setTimeout(() => {
      if (lockedRef.current || version !== refreshVersion.current) return
      const current = statusRef.current
      if (revive && current?.enrolled && current.vaultId === vaultId) {
        void reviveVaultWalletWorker(current)
          .catch((error) => consoleError(error, 'wallet VTXO worker revive'))
          .finally(() => {
            if (!lockedRef.current && version === refreshVersion.current) void refreshBalanceRef.current(vaultId)
          })
      } else void refreshBalanceRef.current(vaultId)
    }, delay)
  }, [])

  const refreshBalance = useCallback(
    async (vaultId?: string) => {
      if (lockedRef.current) return
      const version = refreshVersion.current
      const id = String(
        vaultId || statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '',
      ).trim()
      const active = () =>
        version === refreshVersion.current &&
        !lockedRef.current &&
        (statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '') === id
      if (!id || !active()) return
      try {
        let flight = statusFlight.current
        if (!flight || flight.version !== version || flight.id !== id) {
          const memoryPin = addressPinRef.current
          const pin = memoryPin?.vaultId === id ? memoryPin : loadAddressPin(localStorage, id)
          const promise = fetchVaultStatus(undefined, id).then((fetched) =>
            pin ? requireStatusMatchesPin(fetched, pin) : fetched,
          )
          flight = { version, id, promise }
          statusFlight.current = flight
        }
        let liveStatus: VaultStatus
        try {
          liveStatus = await flight.promise
        } finally {
          if (statusFlight.current === flight) statusFlight.current = null
        }
        if (!active()) return
        setStatus(liveStatus)
        const memoryPin = addressPinRef.current
        const pin = memoryPin?.vaultId === id ? memoryPin : loadAddressPin(localStorage, id)
        const savingsAddress =
          liveStatus.protectionTier === 'light' ? watchedAddressRef.current : pin?.savingsAddress || ''
        const spendingAddress = liveStatus.spendingArkAddress || ''
        const boardingAddress = liveStatus.vtxoBoardingAddress || ''
        const runAccount = (account: keyof AccountBalanceReads, run: () => Promise<void>) => {
          const current = accountFlights.current[account]
          if (current?.version === version) return current.promise
          publishAccount(id, account, { refreshing: true, fresh: false })
          const next: AccountFlight = { version, promise: Promise.resolve() }
          next.promise = Promise.resolve()
            .then(run)
            .finally(() => {
              if (accountFlights.current[account] === next) delete accountFlights.current[account]
              if (active()) publishAccount(id, account, { refreshing: false })
            })
          accountFlights.current[account] = next
          return next.promise
        }
        const savingsTask = runAccount('savings', async () => {
          try {
            let savings = { balance: 0, spendable: 0, history: [] as VaultHistoryItem[] }
            if (liveStatus.templateVersion === LEDGER_NATIVE_TEMPLATE) {
              const value = await fetchLedgerSavingsSnapshot(ledgerEnrollmentFromStatus(liveStatus).savings)
              savings = { balance: value.totalSats, spendable: value.availableSats, history: value.history }
            } else if (savingsAddress) {
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
                retainOlderRows(olderHistoryRef.current, savings.history),
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
            const needsRevive = !readsRef.current.spend.loaded
            // A cold-start boarding observation can show a deposit, but never
            // supplies available Spending funds or overrides an SDK snapshot.
            if (!readsRef.current.spend.loaded && boardingAddress) {
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
        if (active() && readsRef.current.spend.fresh && readsRef.current.savings.fresh) clearSnapshotRetry()
      } catch (error) {
        if (!active()) return
        consoleError(error, 'Vault status refresh')
        for (const account of ['spend', 'savings'] as const)
          publishAccount(id, account, { fresh: false, error: 'Could not verify this wallet. Try refreshing again.' })
        scheduleSnapshotRetry(id)
      }
    },
    [clearSnapshotRetry, publishAccount, scheduleSnapshotRetry, setStatus],
  )
  refreshBalanceRef.current = refreshBalance

  // Invalidate older-page flights on vault, network, or lock transitions and
  // on unmount. A-B-A returns carry a new generation, so an earlier scope
  // can never accept a response from before its own generation.
  const generationScope = `${refreshVaultId}:${status?.network || ''}:${locked}`
  useEffect(() => {
    generationRef.current += 1
    refreshVersion.current += 1
    window.clearTimeout(retryTimerRef.current)
    readsRef.current = {
      spend: { ...readsRef.current.spend, fresh: false, refreshing: false },
      savings: { ...readsRef.current.savings, fresh: false, refreshing: false },
    }
    setAccountReads(readsRef.current)
    // The new scope starts with a fresh older-load state; stale flights stay
    // mute and never write here themselves.
    setOlderActivity({ status: 'idle', error: '' })
  }, [generationScope])
  useEffect(
    () => () => {
      generationRef.current += 1
    },
    [],
  )

  /**
   * One more Esplora window of older Savings records. Only the Savings
   * address supports this: SDK activity, journals, and local records are
   * already complete, and boarding history is transient. Balances never
   * change here; this extends loaded history only, bounded overall.
   *
   * Each flight binds to the current request generation. Vault, network, or
   * lock transitions and unmount invalidate pending flights, whose stale
   * success, error, and finally callbacks leave current state untouched. A
   * new scope starts its own flight independently. Concurrent calls within
   * one generation share a single flight. The merged result is computed
   * before any state update, so state updaters stay pure.
   */
  const loadOlderActivity = useCallback((): Promise<OlderActivityResult> => {
    if (lockedRef.current) return Promise.resolve({ added: 0, exhausted: false })
    const generation = generationRef.current
    const liveFlight = olderFlightRef.current
    if (liveFlight?.generation === generation) return liveFlight.promise
    const token = (flightTokenRef.current += 1)
    const promise = (async (): Promise<OlderActivityResult> => {
      const requestId = String(
        statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '',
      ).trim()
      const requestNetwork = statusRef.current?.network || ''
      const memoryPin = addressPinRef.current
      const pin =
        memoryPin?.vaultId === requestId ? memoryPin : requestId ? loadAddressPin(localStorage, requestId) : null
      const savingsAddress =
        statusRef.current?.protectionTier === 'light' ? watchedAddressRef.current : pin?.savingsAddress || ''
      const cursor = oldestSavingsTxid(snapshotRef.current.history)
      if (!requestId || !savingsAddress || !cursor) {
        setOlderActivity({ status: 'exhausted', error: '' })
        return { added: 0, exhausted: true }
      }
      setOlderActivity({ status: 'loading', error: '' })
      // A stale flight resolves against its own generation: vault, network, or
      // lock changes and unmount invalidate it, and its success, error, and
      // finally callbacks leave current state untouched.
      const stale = () => generation !== generationRef.current
      try {
        const { transactions, exhausted } = await fetchOlderAddressTxs(savingsAddress, cursor)
        if (stale()) return { added: 0, exhausted: false }
        const currentId = String(
          statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '',
        ).trim()
        if (currentId !== requestId || (statusRef.current && statusRef.current.network !== requestNetwork)) {
          return { added: 0, exhausted: false }
        }
        const fresh = historyFromTxs(transactions, savingsAddress, 'savings')
        const base = snapshotRef.current
        const known = new Set(base.history.map(olderRowKey))
        const unseen = fresh.filter((item) => !known.has(olderRowKey(item)))
        const merged = mergeVaultHistory(base.history, unseen).slice(0, MAX_ACTIVITY_ROWS)
        // When the oldest reference cannot advance, the next request would
        // repeat the same page: stop instead of promising every loaded payment
        // the cap cannot hold.
        const converged = oldestSavingsTxid(merged) === cursor
        const done = exhausted || converged
        const nextOlder = [...olderHistoryRef.current, ...unseen].slice(-MAX_ACTIVITY_ROWS)
        olderHistoryRef.current = nextOlder
        setOlderHistory(nextOlder)
        // A concurrent refresh heals through retention: it refetches balances
        // and keeps these rows while fresh evidence wins every overlap.
        const mergedSnapshot = { ...base, history: merged }
        snapshotRef.current = mergedSnapshot
        setSnapshot(mergedSnapshot)
        saveBalanceSnapshot(requestId, mergedSnapshot)
        setOlderActivity({ status: done ? 'exhausted' : 'idle', error: '' })
        return { added: unseen.length, exhausted: done }
      } catch (error) {
        if (stale()) return { added: 0, exhausted: false }
        const currentId = String(
          statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '',
        ).trim()
        if (currentId !== requestId) {
          return { added: 0, exhausted: false }
        }
        consoleError(error, 'Vault older activity load')
        setOlderActivity({ status: 'error', error: 'Could not load older activity. Try again.' })
        return { added: 0, exhausted: false }
      }
    })().finally(() => {
      if (olderFlightRef.current?.token === token) olderFlightRef.current = null
    })
    olderFlightRef.current = { token, generation, promise }
    return promise
  }, [])

  const recoverVtxoSpend = useCallback(async () => {
    const current = statusRef.current
    if (lockedRef.current || !current?.enrolled || !current.vaultId) return
    const version = refreshVersion.current
    try {
      const result = await reconcilePersistedVtxoSpend(current)
      if (lockedRef.current || version !== refreshVersion.current) return
      if (result.kind === 'receipt-finalized') await refreshBalance(current.vaultId)
    } catch (error) {
      consoleError(error, 'VTXO spend recovery')
    }
  }, [refreshBalance])

  useEffect(() => {
    if (locked || !initialStatusChecked || !refreshVaultId) return
    void refreshBalance(refreshVaultId)
  }, [initialStatusChecked, locked, refreshBalance, refreshVaultId, watchedSavingsAddress])

  useEffect(() => {
    if (locked || !status?.enrolled || !status.spendingArkAddress) return
    let timer = 0
    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshBalance(status.vaultId), 200)
    }
    const unsubscribe = subscribeVaultWalletEvents(status, refresh)
    window.addEventListener('vaulted-savings-setup', refresh)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('vaulted-savings-setup', refresh)
    }
  }, [locked, refreshBalance, status])

  useEffect(() => {
    if (locked || !initialStatusChecked || !refreshVaultId) return
    if (status?.enrolled) void recoverVtxoSpend()
    const onFocus = () => {
      const version = refreshVersion.current
      if (status?.enrolled) {
        void reloadVaultWalletWorker(status)
          .catch((error) => consoleError(error, 'wallet VTXO worker reload'))
          .finally(() => {
            if (lockedRef.current || version !== refreshVersion.current) return
            void recoverVtxoSpend()
            void refreshBalance(refreshVaultId)
          })
      } else {
        void refreshBalance(refreshVaultId)
      }
    }
    const onOnline = () => onFocus()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [initialStatusChecked, locked, recoverVtxoSpend, refreshBalance, refreshVaultId, status?.enrolled])

  useEffect(
    () => () => {
      refreshVersion.current += 1
      window.clearTimeout(retryTimerRef.current)
    },
    [],
  )

  return {
    accountReads,
    boardingError: snapshot.boardingError || '',
    snapshotFresh,
    history,
    positions,
    refreshBalance,
    loadOlderActivity,
    olderActivity,
    olderHistory,
  }
}
