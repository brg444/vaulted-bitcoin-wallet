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
import { vaultAccountPositions } from './balances'
import { fetchLedgerSavingsSnapshot } from '../lib/vault/ledgerSavingsWallet'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { ledgerEnrollmentFromStatus } from '../lib/vault/program/ledgerRecoveryDescriptor'

interface VaultBalancesOptions {
  addressPin: AddressPin | null
  enrollment: EnrollmentSecrets | null
  initialStatusChecked: boolean
  locked: boolean
  setStatus: Dispatch<SetStateAction<VaultStatus | null>>
  status: VaultStatus | null
}

interface VaultBalanceSnapshot {
  boardingBalance: number
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
  addressPin,
  enrollment,
  initialStatusChecked,
  locked,
  setStatus,
  status,
}: VaultBalancesOptions) {
  const refreshVersion = useRef(0)
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
  const [balanceError, setBalanceError] = useState('')
  const [balancesLoaded, setBalancesLoaded] = useState(() => Boolean(loadBalanceSnapshot(refreshVaultId)))
  const [refreshingBalance, setRefreshingBalance] = useState(false)
  // True only after a refresh fetched every source for the active vault
  // without error in this session. Cached snapshots set balancesLoaded but
  // never this: arrival detection must wait for fresh evidence.
  const [snapshotFresh, setSnapshotFresh] = useState(false)
  const [olderActivity, setOlderActivity] = useState<OlderActivityState>({ status: 'idle', error: '' })
  // Browsing history loaded beyond the recent window. Refresh retention
  // keeps these rows while fresh evidence wins every overlap; arrival
  // observation excludes them so old receipts never banner as new.
  const [olderHistory, setOlderHistory] = useState<VaultHistoryItem[]>([])
  const olderHistoryRef = useRef<VaultHistoryItem[]>([])
  // Older-page request generation. Every vault, network, or lock transition
  // and unmount invalidates pending flights; stale callbacks mutate nothing.
  const generationRef = useRef(0)
  const olderFlightRef = useRef<{ token: number; generation: number } | null>(null)
  const flightTokenRef = useRef(0)
  const hasSnapshotRef = useRef(balancesLoaded)
  const spendingReadyRef = useRef(balancesLoaded)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  if (hydratedVaultId !== refreshVaultId) {
    const cachedSnapshot = loadBalanceSnapshot(refreshVaultId)
    setHydratedVaultId(refreshVaultId)
    refreshVersion.current += 1
    generationRef.current += 1
    setSnapshot(cachedSnapshot || EMPTY_BALANCES)
    setBalancesLoaded(Boolean(cachedSnapshot))
    setSnapshotFresh(false)
    setOlderActivity({ status: 'idle', error: '' })
    setOlderHistory([])
    olderHistoryRef.current = []
    hasSnapshotRef.current = Boolean(cachedSnapshot)
    spendingReadyRef.current = Boolean(cachedSnapshot)
    setBalanceError('')
    setRefreshingBalance(false)
    retryAttemptRef.current = 0
    window.clearTimeout(retryTimerRef.current)
  }

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

  const scheduleSnapshotRetry = useCallback((vaultId: string) => {
    if (!vaultId || spendingReadyRef.current) return
    window.clearTimeout(retryTimerRef.current)
    const delay =
      retryAttemptRef.current === 0
        ? 0
        : Math.min(FIRST_SNAPSHOT_RETRY_MS * 2 ** (retryAttemptRef.current - 1), FIRST_SNAPSHOT_RETRY_MAX_MS)
    retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 4)
    retryTimerRef.current = window.setTimeout(() => {
      const current = statusRef.current
      if (current?.enrolled && current.vaultId === vaultId) {
        void reviveVaultWalletWorker(current)
          .catch((error) => consoleError(error, 'wallet VTXO worker revive'))
          .finally(() => {
            void refreshBalanceRef.current(vaultId)
          })
        return
      }
      void refreshBalanceRef.current(vaultId)
    }, delay)
  }, [])

  const refreshBalance = useCallback(
    async (vaultId?: string) => {
      const version = ++refreshVersion.current
      setRefreshingBalance(true)
      setSnapshotFresh(false)
      try {
        const id = String(
          vaultId ||
            statusRef.current?.vaultId ||
            enrollmentRef.current?.vaultId ||
            addressPinRef.current?.vaultId ||
            '',
        ).trim()
        if (!id) {
          if (version !== refreshVersion.current) return
          setSnapshot(EMPTY_BALANCES)
          setBalancesLoaded(true)
          hasSnapshotRef.current = false
          setBalanceError('')
          clearSnapshotRetry()
          return
        }
        const memoryPin = addressPinRef.current
        const pin = memoryPin?.vaultId === id ? memoryPin : loadAddressPin(localStorage, id)
        const savingsAddress = pin?.savingsAddress || ''
        const fetchedStatus = await fetchVaultStatus(undefined, id)
        const liveStatus = pin ? requireStatusMatchesPin(fetchedStatus, pin) : fetchedStatus
        const spendingAddress = liveStatus?.spendingArkAddress || ''
        const boardingAddress = liveStatus?.vtxoBoardingAddress || ''
        if (!savingsAddress && !spendingAddress && !boardingAddress) {
          if (version !== refreshVersion.current) return
          setStatus(liveStatus)
          setSnapshot(EMPTY_BALANCES)
          saveBalanceSnapshot(id, EMPTY_BALANCES)
          setBalancesLoaded(true)
          setSnapshotFresh(true)
          hasSnapshotRef.current = true
          setBalanceError('')
          clearSnapshotRetry()
          return
        }
        const emptySavings = { balance: 0, spendable: 0, history: [] as VaultHistoryItem[] }
        const emptySpending: VaultWalletVtxoSnapshot = {
          balance: 0,
          boardingBalance: undefined as number | undefined,
          history: [] as VaultHistoryItem[],
        }
        const emptyBoarding = { balance: 0, history: [] as VaultHistoryItem[] }
        let savings = emptySavings
        let spending = emptySpending
        let boarding = emptyBoarding
        let spendingError: unknown
        const savingsTask =
          liveStatus.templateVersion === LEDGER_NATIVE_TEMPLATE
            ? fetchLedgerSavingsSnapshot(ledgerEnrollmentFromStatus(liveStatus).savings).then((snapshot) => {
                savings = { balance: snapshot.totalSats, spendable: snapshot.availableSats, history: snapshot.history }
              })
            : savingsAddress
              ? Promise.all([fetchAddressUtxos(savingsAddress), fetchAddressTxs(savingsAddress)]).then(
                  ([utxos, transactions]) => {
                    const balance = savingsUtxoBalance(utxos, transactions, savingsAddress)
                    savings = {
                      balance: balance.total,
                      spendable: balance.spendable,
                      history: historyFromTxs(transactions, savingsAddress, 'savings'),
                    }
                  },
                )
              : Promise.resolve()
        const spendingTask =
          spendingAddress && liveStatus.enrolled
            ? fetchVaultWalletVtxoSnapshot(liveStatus)
                .then((snapshot) => {
                  spending = snapshot
                })
                .catch((error) => {
                  spendingError = error
                  consoleError(error, 'Vault spending balance refresh')
                })
            : Promise.resolve()
        await Promise.all([savingsTask, spendingTask])
        // Esplora is a cold-start fallback, never another layer over a worker
        // snapshot. It can still list a deposit that the SDK has settled.
        if (
          boardingAddress &&
          (!spendingAddress || !liveStatus.enrolled || (spendingError && !hasSnapshotRef.current))
        ) {
          try {
            const utxos = await fetchAddressUtxos(boardingAddress)
            boarding = { balance: boardingUtxoBalance(utxos), history: historyFromBoardingUtxos(utxos) }
          } catch (error) {
            consoleError(error, 'Vault boarding balance refresh')
          }
        }
        if (version !== refreshVersion.current) return
        setStatus(liveStatus)
        if (spendingError) {
          const preserveSpending = hasSnapshotRef.current
          setSnapshot((current) => ({
            boardingBalance: preserveSpending ? current.boardingBalance : boarding.balance,
            history: mergeVaultHistory(
              savings.history,
              preserveSpending ? current.history.filter((item) => item.account === 'spend') : boarding.history,
            ),
            savingsSats: savings.balance,
            savingsSpendableSats: savings.spendable,
            vtxoSpendingSats: preserveSpending ? current.vtxoSpendingSats : 0,
            vtxoPendingSats: preserveSpending ? current.vtxoPendingSats : 0,
          }))
          setBalancesLoaded(true)
          hasSnapshotRef.current = true
          setBalanceError('')
          scheduleSnapshotRetry(id)
          return
        }
        const nextSnapshot = {
          boardingBalance: spendingAddress && liveStatus.enrolled ? spending.boardingBalance || 0 : boarding.balance,
          history: mergeVaultHistory(
            savings.history,
            spendingAddress && liveStatus.enrolled ? spending.history : boarding.history,
            retainOlderRows(olderHistoryRef.current, savings.history),
          ).slice(0, MAX_ACTIVITY_ROWS),
          savingsSats: savings.balance,
          savingsSpendableSats: savings.spendable,
          vtxoSpendingSats: spending.balance,
          vtxoPendingSats: spending.pendingBalance || 0,
        }
        setSnapshot(nextSnapshot)
        saveBalanceSnapshot(id, nextSnapshot)
        setBalancesLoaded(true)
        setSnapshotFresh(true)
        hasSnapshotRef.current = true
        spendingReadyRef.current = true
        setBalanceError('')
        clearSnapshotRetry()
      } catch (error) {
        if (version === refreshVersion.current) {
          consoleError(error, 'Vault balance refresh')
          const id = String(
            vaultId ||
              statusRef.current?.vaultId ||
              enrollmentRef.current?.vaultId ||
              addressPinRef.current?.vaultId ||
              '',
          ).trim()
          scheduleSnapshotRetry(id)
        }
      } finally {
        if (version === refreshVersion.current) setRefreshingBalance(false)
      }
    },
    [clearSnapshotRetry, scheduleSnapshotRetry, setStatus],
  )
  refreshBalanceRef.current = refreshBalance

  // Invalidate older-page flights on vault, network, or lock transitions and
  // on unmount. A-B-A returns carry a new generation, so an earlier scope
  // can never accept a response from before its own generation.
  const generationScope = `${refreshVaultId}:${status?.network || ''}:${locked}`
  useEffect(() => {
    generationRef.current += 1
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
  const loadOlderActivity = useCallback(async (): Promise<OlderActivityResult> => {
    const generation = generationRef.current
    const liveFlight = olderFlightRef.current
    if (liveFlight && liveFlight.generation === generation) return { added: 0, exhausted: false }
    const requestId = String(
      statusRef.current?.vaultId || enrollmentRef.current?.vaultId || addressPinRef.current?.vaultId || '',
    ).trim()
    const requestNetwork = statusRef.current?.network || ''
    const memoryPin = addressPinRef.current
    const pin =
      memoryPin?.vaultId === requestId ? memoryPin : requestId ? loadAddressPin(localStorage, requestId) : null
    const savingsAddress = pin?.savingsAddress || ''
    const cursor = oldestSavingsTxid(snapshotRef.current.history)
    if (!requestId || !savingsAddress || !cursor) {
      setOlderActivity({ status: 'exhausted', error: '' })
      return { added: 0, exhausted: true }
    }
    const token = (flightTokenRef.current += 1)
    olderFlightRef.current = { token, generation }
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
    } finally {
      // Release only this flight: an older finally must never clear a newer
      // scope's in-flight request.
      if (olderFlightRef.current?.token === token) olderFlightRef.current = null
    }
  }, [])

  const recoverVtxoSpend = useCallback(async () => {
    const current = statusRef.current
    if (!current?.enrolled || !current.vaultId) return
    try {
      const result = await reconcilePersistedVtxoSpend(current)
      if (result.kind === 'receipt-finalized') await refreshBalance(current.vaultId)
    } catch (error) {
      consoleError(error, 'VTXO spend recovery')
    }
  }, [refreshBalance])

  useEffect(() => {
    if (locked || !initialStatusChecked || !refreshVaultId) return
    void refreshBalance(refreshVaultId)
  }, [initialStatusChecked, locked, refreshBalance, refreshVaultId])

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
      if (status?.enrolled) {
        void reloadVaultWalletWorker(status)
          .catch((error) => consoleError(error, 'wallet VTXO worker reload'))
          .finally(() => {
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
    balanceError,
    balancesLoaded,
    snapshotFresh,
    history,
    positions,
    refreshBalance,
    refreshingBalance,
    loadOlderActivity,
    olderActivity,
    olderHistory,
  }
}
