import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { loadBalanceSnapshot, saveBalanceSnapshot } from '../lib/vault/balanceStore'
import { consoleError } from '../lib/logs'
import { fetchAddressTxs, fetchAddressUtxos, type EsploraTx, type EsploraUtxo } from '../lib/vault/esplora'
import {
  historyFromBoardingUtxos,
  historyFromTxs,
  mergeVaultHistory,
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
  const hasSnapshotRef = useRef(balancesLoaded)
  const spendingReadyRef = useRef(balancesLoaded)

  if (hydratedVaultId !== refreshVaultId) {
    const cachedSnapshot = loadBalanceSnapshot(refreshVaultId)
    setHydratedVaultId(refreshVaultId)
    refreshVersion.current += 1
    setSnapshot(cachedSnapshot || EMPTY_BALANCES)
    setBalancesLoaded(Boolean(cachedSnapshot))
    setSnapshotFresh(false)
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
          ),
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
  }
}
