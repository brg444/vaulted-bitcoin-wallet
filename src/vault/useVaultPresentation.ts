import { useCallback, useEffect, useRef, useState } from 'react'
import { getPriceFeed } from '../lib/fiat'
import { Fiats } from '../lib/types'
import type { VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import type { VaultHistoryItem } from '../lib/vault/history'
import type { VaultStatus } from '../lib/vault/types'
import { loadWatchedSavings, saveWatchedSavings, type WatchedSavingsAddress } from '../lib/vault/watchSavings'
import { DUST_SATS, requireSupportedVaultNetwork } from '../lib/vault/constants'
import { useDisplayUnit } from '../lib/vault/useDisplayUnit'
import { isVaultArkAddress, isVaultBitcoinAddress, isVaultSpendAddress, bitcoinDustSats } from '../lib/vault/bitcoin'
import { isVaultLightningInput } from '../lib/vault/lightningConfig'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import type { SessionOutcome, VaultSession } from '../lib/vault/session'
import type { VaultAccount, VaultScreen, VaultSpend } from './context'
import { sessionScreen } from './useVaultSession'
import type { useSpendingPayments } from './useSpendingPayments'
import type { useBitcoinPayments } from './useBitcoinPayments'
import type { useLedgerPayments } from './useLedgerPayments'

const LIVE_FEE = 1500

export interface VaultDisplayBinding {
  balanceUnit: ReturnType<typeof useDisplayUnit>['unit']
  balanceRateStatus: ReturnType<typeof useDisplayUnit>['rateStatus']
  setBalanceUnit: ReturnType<typeof useDisplayUnit>['setUnit']
  fiatDisplayRate: VaultFiatDisplayRate | null
  fiatDisplayEnabled: boolean
  setFiatDisplay: (enabled: boolean) => Promise<VaultFiatDisplayRate | null>
}

/** Display unit, fiat rate and preference state. One writer for the rate. */
export function useVaultDisplayBinding(): VaultDisplayBinding {
  const [fiatDisplayRate, setFiatDisplayRate] = useState<VaultFiatDisplayRate | null>(null)
  const [fiatDisplayEnabled, setFiatDisplayEnabled] = useState(false)
  const setFiatDisplay = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setFiatDisplayEnabled(false)
      setFiatDisplayRate(null)
      return null
    }
    const prices = await getPriceFeed({ silent: true })
    if (Number.isFinite(prices?.usd) && Number(prices?.usd) > 0) {
      const rate = { currency: Fiats.USD, pricePerBtc: Number(prices!.usd) }
      setFiatDisplayRate(rate)
      setFiatDisplayEnabled(true)
      return rate
    }
    setFiatDisplayEnabled(false)
    setFiatDisplayRate(null)
    return null
  }, [])
  const { unit, rateStatus, setUnit } = useDisplayUnit({
    rate: fiatDisplayRate,
    ensureRate: () => setFiatDisplay(true),
    clearRate: () => {
      setFiatDisplayEnabled(false)
      setFiatDisplayRate(null)
    },
  })
  return {
    balanceUnit: unit,
    balanceRateStatus: rateStatus,
    setBalanceUnit: setUnit,
    fiatDisplayRate,
    fiatDisplayEnabled,
    setFiatDisplay,
  }
}

/** Watch-only Savings presentation state. */
export function useWatchedSavingsBinding(status: VaultStatus | null) {
  const [watchedSavings, setWatchedSavings] = useState<WatchedSavingsAddress | null>(null)
  useEffect(() => {
    if (status?.protectionTier !== 'light') {
      setWatchedSavings(null)
      return
    }
    try {
      setWatchedSavings(loadWatchedSavings(status.vaultId, requireSupportedVaultNetwork(status.network)))
    } catch {
      setWatchedSavings(null)
    }
  }, [status?.vaultId, status?.network, status?.protectionTier])
  const updateWatchedSavings = useCallback(
    (address: string, label: string) => {
      if (status?.protectionTier !== 'light') throw new Error('Watch-only Savings requires a Light wallet')
      setWatchedSavings(
        saveWatchedSavings(
          status.vaultId,
          { address: address.trim(), label, network: requireSupportedVaultNetwork(status.network) },
          requireSupportedVaultNetwork(status.network),
        ),
      )
    },
    [status],
  )
  return { watchedSavings, updateWatchedSavings }
}

/** Navigation, recover entry and return destinations. One writer for the screen. */
export function useVaultNavigationBinding(input: {
  transition: { id: number; outcome: SessionOutcome } | null
  observeDeployment: (enabled: boolean) => void
  cancelLedgerConnection: () => void
  clearError: () => void
  onLeaveSend: () => void
}) {
  const { transition, observeDeployment, cancelLedgerConnection, clearError, onLeaveSend } = input
  const [screen, setScreen] = useState<VaultScreen>('welcome')
  const [recoverEntry, setRecoverEntry] = useState<'kit' | 'lost'>('kit')
  const [recoverExit, setRecoverExit] = useState<VaultScreen>('keys')
  const navigate = useCallback(
    (next: VaultScreen) => {
      clearError()
      if (next === 'home') onLeaveSend()
      setScreen(next)
    },
    [clearError, onLeaveSend],
  )
  const openRecover = useCallback(
    (view: 'kit' | 'lost' = 'kit', exit: VaultScreen = 'keys') => {
      clearError()
      setRecoverEntry(view)
      setRecoverExit(exit)
      setScreen('recover')
    },
    [clearError],
  )
  useEffect(() => {
    if (!transition) return
    setScreen(sessionScreen(transition.outcome))
    clearError()
  }, [transition, clearError])
  useEffect(() => {
    observeDeployment(['welcome', 'design', 'passkey', 'problem'].includes(screen))
    if (screen !== 'hardware' && screen !== 'recovery') cancelLedgerConnection()
  }, [screen, observeDeployment, cancelLedgerConnection])
  return { screen, setScreen, navigate, openRecover, recoverEntry, recoverExit }
}

/** Send draft, review, result and scanner presentation. One writer per field. */
export function useVaultSendBinding(input: {
  status: VaultStatus | null
  account: VaultAccount
  liveNetwork: boolean
  transition: { id: number; outcome: SessionOutcome } | null
  spendingPayments: ReturnType<typeof useSpendingPayments>
  bitcoinPayments: ReturnType<typeof useBitcoinPayments>
  ledgerSavings: ReturnType<typeof useLedgerPayments>
  session: Pick<VaultSession, 'getSnapshot'>
  clearError: () => void
  setError: (message: string) => void
  refreshBalance: () => Promise<void>
  setScreen: (screen: VaultScreen) => void
}) {
  const {
    status,
    account,
    liveNetwork,
    transition,
    spendingPayments,
    bitcoinPayments,
    ledgerSavings,
    session,
    clearError,
    setError,
    refreshBalance,
    setScreen,
  } = input
  const [spend, setSpend] = useState<VaultSpend>({ address: '', amount: 0, fee: 0 })
  const spendRef = useRef(spend)
  spendRef.current = spend
  const [lastSend, setLastSend] = useState<VaultSpend | null>(null)
  const [lastTxid, setLastTxid] = useState('')
  const [lastTxKind, setLastTxKind] = useState<'onchain' | 'vtxo' | 'lightning' | ''>('')
  // True while an explicitly approved payment is being prepared/submitted by the
  // account owner; the result screen shows a truthful starting state until the
  // owner acknowledges durable acceptance or submission.
  const [starting, setStarting] = useState(false)
  const [scanOnSend, setScanOnSend] = useState(false)

  useEffect(() => {
    if (transition?.outcome !== 'signed-out') return
    setSpend({ address: '', amount: 0, fee: 0 })
    setLastSend(null)
    setLastTxid('')
    setLastTxKind('')
    setStarting(false)
    setScanOnSend(false)
  }, [transition])

  const spendingEvent = spendingPayments.event
  useEffect(() => {
    if (!spendingEvent || spendingPayments.payments.getSnapshot().event !== spendingEvent) return
    if (!spendingPayments.payments.consumeEvent(spendingEvent.id)) return
    if (spendingEvent.outcome === 'authorized') {
      // The passkey ceremony succeeded. Show the existing Payment started page
      // now; submission and reconciliation continue under the account owner.
      setLastSend(spendingEvent.payment)
      setLastTxid('')
      setLastTxKind(spendingEvent.kind)
      setStarting(true)
      setScreen('success')
    } else if (spendingEvent.outcome === 'sent') {
      setLastTxid(spendingEvent.txid!)
      setLastTxKind(spendingEvent.kind)
      setLastSend(spendingEvent.payment)
      setStarting(false)
      setSpend({ address: '', amount: 0, fee: 0 })
      setScreen('success')
      void refreshBalance().catch(() => undefined)
    } else {
      setStarting(false)
      setSpend(spendingEvent.outcome === 'fee-changed' ? spendingEvent.payment : { ...spendingEvent.payment, fee: 0 })
      setScreen(spendingEvent.outcome === 'fee-changed' ? 'review' : 'send')
    }
  }, [spendingEvent, spendingPayments.payments, refreshBalance, setScreen])

  const ledgerCompletion = ledgerSavings.completion
  useEffect(() => {
    if (!ledgerCompletion || ledgerSavings.payments.getSnapshot().completion !== ledgerCompletion) return
    if (!ledgerSavings.payments.consumeCompletion(ledgerCompletion.id)) return
    setLastTxid(ledgerCompletion.txid)
    setLastTxKind('onchain')
    setLastSend(ledgerCompletion.payment)
    setSpend({ address: '', amount: 0, fee: 0 })
    setScreen('success')
    void refreshBalance().catch(() => undefined)
  }, [ledgerCompletion, ledgerSavings.payments, refreshBalance, setScreen])

  const bitcoinCompletion = bitcoinPayments.completion
  useEffect(() => {
    if (!bitcoinCompletion || bitcoinPayments.payments.getSnapshot().completion !== bitcoinCompletion) return
    if (!bitcoinPayments.payments.consumeCompletion(bitcoinCompletion.id)) return
    if (bitcoinCompletion.txid) {
      setLastTxid(bitcoinCompletion.txid)
      setLastTxKind('onchain')
      setLastSend(bitcoinCompletion.payment)
      setSpend({ address: '', amount: 0, fee: 0 })
      setScreen('success')
    } else setScreen('home')
    void refreshBalance().catch(() => undefined)
  }, [bitcoinCompletion, bitcoinPayments.payments, refreshBalance, setScreen])

  const clearSpendDraft = useCallback(
    (acct: VaultAccount = account) => {
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setSpend({ address: '', amount: 0, fee: acct === 'spend' ? 0 : liveNetwork ? LIVE_FEE : 500 })
    },
    [account, liveNetwork, bitcoinPayments.payments, spendingPayments.payments],
  )
  const setSpendDraft = useCallback(
    (draft: Partial<VaultSpend>) => {
      ledgerSavings.payments.cancelReview()
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setSpend((prev) => ({
        ...prev,
        ...draft,
        fee: account === 'spend' ? 0 : liveNetwork ? LIVE_FEE : 500,
      }))
      setError('')
    },
    [account, liveNetwork, ledgerSavings.payments, bitcoinPayments.payments, spendingPayments.payments, setError],
  )
  const restoreDraft = useCallback((payment: VaultSpend) => setSpend(payment), [])
  const applyDraftFee = useCallback(
    (fee: number) => setSpend((prev) => (prev.fee === fee ? prev : { ...prev, fee })),
    [],
  )
  const reviewSpending = useCallback(
    async (replace = false) => {
      try {
        const reviewed = await spendingPayments.payments.review(spend, replace)
        if (spendingPayments.payments.getSnapshot().review !== reviewed) return
        setSpend(reviewed.payment)
        setScreen('review')
      } catch {
        // The owner keeps operation errors bound to the current session.
      }
    },
    [spendingPayments.payments, spend, setScreen],
  )
  const reviewReplace = useCallback(() => reviewSpending(true), [reviewSpending])
  const reviewSpend = useCallback(async () => {
    setError('')
    if (!status?.enrolled) {
      setError('Unlock this vault before sending.')
      return
    }
    if (account === 'savings' && status.protectionTier === 'light') {
      setError('Savings is watch-only in this wallet.')
      return
    }
    if (isVaultLightningInput(spend.address)) {
      if (account !== 'spend') {
        setError('Lightning payments use Spending.')
        return
      }
      await reviewSpending()
      return
    }
    const destNetwork = status.network
    if (!isVaultSpendAddress(spend.address, destNetwork)) {
      setError('Enter an Arkade or Bitcoin address.')
      return
    }
    const arkDestination = isVaultArkAddress(spend.address, destNetwork)
    if (arkDestination && account === 'savings') {
      setError('Savings sends require a Bitcoin address.')
      return
    }
    if (!arkDestination && account === 'spend') {
      if (!Number.isSafeInteger(spend.amount) || spend.amount < bitcoinDustSats(spend.address, destNetwork)) {
        setError(`At least ₿${bitcoinDustSats(spend.address, destNetwork)}.`)
        return
      }
      try {
        const reviewed = await bitcoinPayments.payments.review(spend)
        if (!reviewed || bitcoinPayments.payments.getSnapshot().review !== reviewed) return
        setSpend(reviewed.payment)
        setScreen('review')
      } catch {
        // The owner keeps errors bound to the current payment session.
      }
      return
    }
    const minimumAmount = account === 'savings' ? bitcoinDustSats(spend.address, destNetwork) : DUST_SATS
    if (!Number.isInteger(spend.amount) || spend.amount < minimumAmount) {
      setError(`At least ₿${minimumAmount}.`)
      return
    }
    if (account === 'savings') {
      if (status.templateVersion !== LEDGER_NATIVE_TEMPLATE) {
        setError('This Savings program is no longer supported.')
        return
      }
      try {
        const reviewed = await ledgerSavings.payments.review(spend)
        if (ledgerSavings.payments.getSnapshot().view !== reviewed) return
        if (spendRef.current.address !== spend.address || spendRef.current.amount !== spend.amount) {
          setError('Send details changed. Review the payment again.')
          return
        }
        setSpend({ ...spend, fee: reviewed.record.payment.feeSats })
        setScreen('review')
      } catch {
        // The payment owner publishes errors only into the current session.
      }
      return
    }
    await reviewSpending()
  }, [account, status, spend, setError, reviewSpending, bitcoinPayments.payments, ledgerSavings.payments, setScreen])
  const approveSend = useCallback(async () => {
    if (account === 'savings') {
      clearError()
      try {
        const approved = await ledgerSavings.payments.approve(spend)
        if (approved && ledgerSavings.payments.getSnapshot().view === approved) setScreen('ledger-sign')
      } catch {
        // The payment owner publishes errors only into the current session.
      }
      return
    }
    if (isVaultBitcoinAddress(spend.address, status?.network)) {
      bitcoinPayments.payments.approve(spend)
      return
    }
    setError('')
    // Keep the user on Review while the passkey prompt is pending. The owner
    // publishes 'authorized' only after the ceremony succeeds, and the result
    // page appears then; cancellation or failure leaves the review/retry path.
    try {
      await spendingPayments.payments.approve(spend)
    } catch {
      if (!session.getSnapshot().locked && !spendingPayments.payments.getSnapshot().review) setScreen('send')
    }
  }, [
    account,
    ledgerSavings.payments,
    bitcoinPayments.payments,
    spendingPayments.payments,
    session,
    spend,
    status?.network,
    setError,
    setScreen,
  ])
  const openSendScan = useCallback(() => {
    clearSpendDraft(account)
    setScanOnSend(true)
    clearError()
    setScreen('send')
  }, [clearSpendDraft, account, clearError, setScreen])
  const clearSendScan = useCallback(() => setScanOnSend(false), [])
  return {
    spend,
    setSpendDraft,
    clearSpendDraft,
    restoreDraft,
    applyDraftFee,
    lastSend,
    lastTxid,
    lastTxKind,
    starting,
    scanOnSend,
    openSendScan,
    clearSendScan,
    reviewSpend,
    reviewReplace,
    approveSend,
  }
}

/** Selected activity and return destination. */
export function useVaultActivityBinding(input: {
  screen: VaultScreen
  setScreen: (screen: VaultScreen) => void
  clearError: () => void
  intercept: (tx: VaultHistoryItem, returnTo: VaultScreen) => boolean
}) {
  const { screen, setScreen, clearError, intercept } = input
  const [selectedTx, setSelectedTx] = useState<VaultHistoryItem | null>(null)
  const [txReturn, setTxReturn] = useState<VaultScreen>('home')
  const select = useCallback(
    (tx: VaultHistoryItem, returnTo: VaultScreen) => {
      setSelectedTx(tx)
      setTxReturn(returnTo)
      clearError()
    },
    [clearError],
  )
  const syncSelection = useCallback((resolve: (current: VaultHistoryItem) => VaultHistoryItem | null) => {
    setSelectedTx((current) => (current ? (resolve(current) ?? current) : current))
  }, [])
  const openTx = useCallback(
    (tx: VaultHistoryItem) => {
      const returnTo = screen
      if (intercept(tx, returnTo)) return
      select(tx, returnTo)
      setScreen('tx')
    },
    [screen, setScreen, select, intercept],
  )
  return { selectedTx, txReturn, openTx, select, syncSelection }
}
