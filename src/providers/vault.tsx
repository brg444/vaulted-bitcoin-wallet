import { requireSupportedVaultNetwork, DUST_SATS } from '../lib/vault/constants'
import { loadWatchedSavings, saveWatchedSavings, type WatchedSavingsAddress } from '../lib/vault/watchSavings'
import { useLedgerPayments } from '../vault/useLedgerPayments'
import { ledgerPaymentView, LedgerPaymentContext } from '../vault/ledgerPaymentContext'
import { withBitcoinPaymentHistory } from '../lib/vault/bitcoinPaymentHistory'
import { useNativePaymentNotifications } from '../vault/useNativePaymentNotifications'

import { NOTIFY_WORKER_SCOPE } from '../lib/vault/nativeNotifications'
import { parsePushNavScreen } from '../lib/vault/notificationEnvelope'
import { isPushSubscribed, refreshBackgroundPush } from '../lib/vault/pushSubscription'
import { useSpendingPayments } from '../vault/useSpendingPayments'
import { spendingPaymentView, SpendingPaymentContext } from '../vault/spendingPaymentContext'
import { useBitcoinPayments } from '../vault/useBitcoinPayments'
import { bitcoinPaymentView, BitcoinPaymentContext } from '../vault/bitcoinPaymentContext'
import { useSpendingRenewals } from '../vault/useSpendingRenewals'
import { useRecoveryCommands } from '../vault/useRecoveryCommands'
import {
  VaultAccountContext,
  VaultActivityContext,
  VaultDisplayContext,
  VaultInteractionContext,
  VaultNavigationContext,
  VaultRecoveryContext,
  VaultRenewalContext,
  VaultSendContext,
  type VaultAccountContextProps,
  type VaultActivityContextProps,
  type VaultDisplayContextProps,
  type VaultInteractionContextProps,
  type VaultNavigationContextProps,
  type VaultRecoveryContextProps,
  type VaultRenewalContextProps,
  type VaultSendContextProps,
} from '../vault/appContexts'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { olderRowKey, recentAccountHistory, type VaultHistoryItem } from '../lib/vault/history'
import { bitcoinDustSats, isVaultArkAddress, isVaultSpendAddress, isVaultBitcoinAddress } from '../lib/vault/bitcoin'
import { isVaultLightningInput } from '../lib/vault/lightningConfig'

import type { VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import { useDisplayUnit } from '../lib/vault/useDisplayUnit'
import { getPriceFeed } from '../lib/fiat'
import { Fiats } from '../lib/types'

import {
  DEFAULT_SPEND_FEE_SATS,
  VaultContext,
  type VaultAccount,
  type VaultContextProps,
  type VaultScreen,
  type VaultSpend,
} from '../vault/context'
import { useRecoveryAlerts } from '../vault/useRecoveryAlerts'
import { useVaultBalances } from '../vault/useVaultBalances'
import { useVaultSession, sessionScreen } from '../vault/useVaultSession'
import { sessionView, VaultSessionContext } from '../vault/sessionContext'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'

export { VaultContext } from '../vault/context'
export type { VaultAccount, VaultContextProps, VaultScreen, VaultSpend } from '../vault/context'

const DEFAULT_FEE = DEFAULT_SPEND_FEE_SATS
const LIVE_FEE = 1500

export function vaultDraftFee(account: VaultAccount, liveNetwork: boolean): number {
  return account === 'spend' ? 0 : liveNetwork ? LIVE_FEE : DEFAULT_FEE
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const sessionState = useVaultSession()
  const {
    session,
    setup,
    status,
    deployment,
    account: admitted,
    loaded,
    initialStatusChecked,
    locked,
    addressPin,
    pending,
    transition,
    error: sessionError,
  } = sessionState
  const ledgerSavings = useLedgerPayments(session)
  const bitcoinPayments = useBitcoinPayments(session)
  const spendingPayments = useSpendingPayments(session)
  const [screen, setScreen] = useState<VaultScreen>('welcome')
  const [recoverEntry, setRecoverEntry] = useState<'kit' | 'lost'>('kit')
  const [recoverExit, setRecoverExit] = useState<VaultScreen>('keys')
  const [operationError, setOperationError] = useState('')
  const error = operationError || sessionError || ledgerSavings.error || bitcoinPayments.error || spendingPayments.error
  const setError = useCallback(
    (message: string) => {
      session.clearError()
      ledgerSavings.payments.clearError()
      bitcoinPayments.payments.clearError()
      spendingPayments.payments.clearError()
      setOperationError(message)
    },
    [session, ledgerSavings.payments, bitcoinPayments.payments, spendingPayments.payments],
  )
  const busy =
    spendingPayments.pending !== null ||
    (bitcoinPayments.pending !== null && !['approval', 'acknowledge'].includes(bitcoinPayments.pending)) ||
    ledgerSavings.pending !== null ||
    (pending !== null && pending !== 'boot')
  const [spend, setSpend] = useState<VaultSpend>({ address: '', amount: 0, fee: 0 })
  const spendRef = useRef(spend)
  spendRef.current = spend
  const [lastSend, setLastSend] = useState<VaultSpend | null>(null)
  const [lastTxid, setLastTxid] = useState('')
  const [lastTxKind, setLastTxKind] = useState<'onchain' | 'vtxo' | 'lightning' | ''>('')
  const [selectedTx, setSelectedTx] = useState<VaultHistoryItem | null>(null)
  const [txReturn, setTxReturn] = useState<VaultScreen>('home')
  const [account, setAccount] = useState<VaultAccount>('spend')
  const [scanOnSend, setScanOnSend] = useState(false)
  useEffect(() => {
    if (screen !== 'review') {
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
    }
  }, [screen, bitcoinPayments.payments, spendingPayments.payments])

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

  const {
    unit: balanceUnit,
    rateStatus: balanceRateStatus,
    setUnit: setBalanceUnit,
  } = useDisplayUnit({
    rate: fiatDisplayRate,
    ensureRate: () => setFiatDisplay(true),
    clearRate: () => {
      setFiatDisplayEnabled(false)
      setFiatDisplayRate(null)
    },
  })

  useEffect(() => {
    if (!transition) return
    setScreen(sessionScreen(transition.outcome))
    setOperationError('')
    if (transition.outcome === 'signed-out') {
      setSpend({ address: '', amount: 0, fee: 0 })
      setLastSend(null)
      setLastTxid('')
      setLastTxKind('')
      setAccount('spend')
      setScanOnSend(false)
    }
  }, [transition])
  useEffect(() => {
    session.observeDeployment(['welcome', 'design', 'passkey', 'problem'].includes(screen))
    if (screen !== 'hardware' && screen !== 'recovery') session.cancelLedgerConnection()
  }, [screen, session])
  useEffect(() => {
    if (status?.network === 'mutinynet' && account === 'savings')
      setSpend((prev) => (prev.fee === LIVE_FEE ? prev : { ...prev, fee: LIVE_FEE }))
  }, [account, status?.network])

  const spendingArkAddress = status?.spendingArkAddress || ''
  const boardingAddress = status?.vtxoBoardingAddress || ''
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
  const savingsAddress =
    status?.protectionTier === 'light' ? watchedSavings?.address || '' : addressPin?.savingsAddress || ''
  const activeNetwork = status?.network || deployment?.network
  const liveNetwork = activeNetwork === 'mutinynet'
  const selectAccount = useCallback(
    (next: VaultAccount) => {
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setAccount(next)
      setScreen('home')
      setSpend((previous) => ({ ...previous, fee: vaultDraftFee(next, liveNetwork) }))
    },
    [liveNetwork, bitcoinPayments.payments, spendingPayments.payments],
  )
  const reportError = setError
  const {
    accountReads,
    boardingError,
    snapshotFresh,
    history,
    positions,
    refreshBalance,
    loadOlderActivity,
    olderActivity,
    olderHistory,
  } = useVaultBalances({
    watchedSavingsAddress: watchedSavings?.address,
    addressPin,
    enrollment: admitted?.enrollment ?? null,
    initialStatusChecked,
    locked,
    setStatus: session.acceptStatus,
    status: admitted?.status ?? status,
  })
  const spendingAvailableSats = positions.spending.availableSats
  const dailyLimit = status?.enrolled ? (status.periodAllowance ?? setup.dailyLimitSats) : setup.dailyLimitSats
  const dailyRemaining = status?.enrolled ? (status.periodRemaining ?? dailyLimit) : 0
  const networkLabel = activeNetwork === 'mainnet' ? 'Bitcoin' : liveNetwork ? 'Mutinynet' : 'Unavailable'
  const clearError = useCallback(() => reportError(''), [reportError])

  const historyWithBitcoin = useMemo(
    () => withBitcoinPaymentHistory(history, bitcoinPayments.operation),
    [history, bitcoinPayments.operation],
  )
  const visibleHistory = useMemo<VaultHistoryItem[]>(() => {
    const pending = ledgerSavings.view
    if (!pending || pending.outcome === 'prepared' || pending.outcome === 'conflicted') return historyWithBitcoin
    const existing = historyWithBitcoin.find(
      (row) => row.txid === pending.record.candidateId && row.account === 'savings',
    )
    const payment = pending.record.payment
    return [
      {
        txid: pending.record.candidateId,
        type: 'sent',
        amount: payment.amountSats + payment.feeSats,
        displayAmount: payment.amountSats,
        fee: payment.feeSats,
        confirmed: existing?.confirmed || pending.outcome === 'confirmed',
        blockTime: existing?.blockTime,
        account: 'savings',
        activity: 'savings-ledger',
        ledgerStage:
          pending.outcome === 'broadcast'
            ? 'broadcast'
            : pending.record.txHex
              ? 'unknown'
              : pending.record.phonePsbt
                ? 'signer'
                : 'approval',
      },
      ...historyWithBitcoin.filter((row) => row.txid !== pending.record.candidateId || row.account !== 'savings'),
    ]
  }, [ledgerSavings.view, historyWithBitcoin])
  useEffect(() => {
    setSelectedTx((current) => {
      if (!current) return current
      return (
        visibleHistory.find(
          (item) =>
            item.account === current.account &&
            (item.txid === current.txid ||
              (current.bitcoinOperationId && item.bitcoinOperationId === current.bitcoinOperationId) ||
              // A Lightning funding transaction can change across claim,
              // refund, or replacement while the RFQ id stays the logical
              // payment. Details follow the RFQ, not the displayed txid.
              (current.activity === 'lightning' &&
                current.lightningRfqId &&
                item.activity === 'lightning' &&
                item.lightningRfqId === current.lightningRfqId)),
        ) || current
      )
    })
  }, [visibleHistory])
  // Native receipt detection reads the unfiltered history so a Savings deposit still
  // surfaces while Spending is selected. Detection starts only after a
  // fresh successful snapshot for the active scope; cached hydration alone
  // never qualifies. Delivery pauses while locked, scopeless, or while an
  // approval is in flight, resuming after unlock or completion.
  const arrivalScope = useMemo(
    () => ({ network: status?.network || '', vaultId: status?.vaultId || '' }),
    [status?.network, status?.vaultId],
  )
  const activityReady = snapshotFresh && Boolean(status?.vaultId) && Boolean(status?.network)
  // Browsing history loaded beyond the recent window never feeds arrival
  // observation; those receipts stay visible without announcing as new.
  const excludedArrivalKeys = useMemo(() => new Set((olderHistory || []).map(olderRowKey)), [olderHistory])
  // Foreground OS notices for verified receipts the server cannot see
  // (confirmed Savings deposits). Server-owned Spending receipts stay silent
  // here under every subscription state; push owns them, even app-open.
  const nativeArrivalReady =
    accountReads.savings.loaded && accountReads.savings.fresh && Boolean(status?.vaultId) && Boolean(status?.network)
  const notifyRegistration = useCallback(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(undefined)
    return navigator.serviceWorker.getRegistration(NOTIFY_WORKER_SCOPE).catch(() => undefined)
  }, [])
  useNativePaymentNotifications(visibleHistory, arrivalScope, busy || locked, nativeArrivalReady, excludedArrivalKeys, {
    getRegistration: notifyRegistration,
    enabled: status !== null && isPushSubscribed(status),
  })
  useEffect(() => {
    if (!locked && status) void refreshBackgroundPush(status).catch(() => undefined)
    // Refresh only on unlock or wallet change; receipt refreshes do not renew leases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, status?.vaultId, status?.network])
  // Native tap flow: a worker tap opens `/?notify=activity`. After unlock,
  // with a fresh snapshot, land on verified Activity and strip the param.
  useEffect(() => {
    if (locked || !activityReady) return
    let screen: string | null = null
    try {
      screen = new URLSearchParams(window.location.search).get('notify')
    } catch {
      return
    }
    if (parsePushNavScreen(screen) !== 'activity') return
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('notify')
      window.history.replaceState(null, '', url.toString())
    } catch {
      // Navigation still proceeds; the param is inert afterwards.
    }
    setScreen('activity')
    void refreshBalance().catch(() => undefined)
    // Runs once per unlock-ready transition; navigation consumes the param.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, activityReady])

  const initiateAlert = useRecoveryAlerts(status, locked)
  const {
    commands: recoveryCommands,
    archiveStatus: recoveryArchiveStatus,
    archiveError: recoveryArchiveError,
    hasKit: hasRecoveryKit,
  } = useRecoveryCommands(session)
  const backupRecoveryKit = useCallback(() => {
    clearError()
    return recoveryCommands.backupRecoveryKit()
  }, [clearError, recoveryCommands])
  const restoreRecoveryKit = useCallback(() => {
    clearError()
    return recoveryCommands.restoreRecoveryKit()
  }, [clearError, recoveryCommands])
  const { backupRecoveryArchive, downloadRecoveryArchive, downloadRecoveryKit, recoverMatureBoarding } =
    recoveryCommands

  const confirmConditions = useCallback(() => {
    setError('')
    setScreen('plan')
  }, [setError])

  const clearSpendDraft = useCallback(
    (acct: VaultAccount = account) => {
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setSpend({ address: '', amount: 0, fee: vaultDraftFee(acct, liveNetwork) })
    },
    [account, liveNetwork, bitcoinPayments.payments, spendingPayments.payments],
  )

  const setSpendDraft = useCallback(
    (draft: Partial<VaultSpend>) => {
      ledgerSavings.payments.cancelReview()
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setSpend((prev) => {
        const next = { ...prev, ...draft }
        next.fee = vaultDraftFee(account, liveNetwork)
        return next
      })
      setError('')
    },
    [account, liveNetwork, ledgerSavings.payments, bitcoinPayments.payments, spendingPayments.payments, setError],
  )

  const openPendingPayment = useCallback(
    async (operationId: string) => {
      try {
        const opened = await spendingPayments.payments.openPending(operationId)
        if (spendingPayments.payments.getSnapshot().opened !== opened) return
        setAccount('spend')
        setSpend(opened.payment)
        setScreen(opened.review ? 'review' : 'send')
      } catch {
        // The owner keeps operation errors bound to the current session.
      }
    },
    [spendingPayments.payments],
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
    [spendingPayments.payments, spend],
  )

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
  }, [account, status, spend, reviewSpending, bitcoinPayments.payments, ledgerSavings.payments, setError])

  const replaceInFlightSend = useCallback(() => reviewSpending(true), [reviewSpending])

  const spendingEvent = spendingPayments.event
  useEffect(() => {
    if (!spendingEvent || spendingPayments.payments.getSnapshot().event !== spendingEvent) return
    if (!spendingPayments.payments.consumeEvent(spendingEvent.id)) return
    setAccount('spend')
    if (spendingEvent.outcome === 'sent') {
      setLastTxid(spendingEvent.txid!)
      setLastTxKind(spendingEvent.kind)
      setLastSend(spendingEvent.payment)
      setSpend({ address: '', amount: 0, fee: 0 })
      setScreen('success')
      void refreshBalance().catch(() => undefined)
    } else {
      setSpend(spendingEvent.outcome === 'fee-changed' ? spendingEvent.payment : { ...spendingEvent.payment, fee: 0 })
      setScreen(spendingEvent.outcome === 'fee-changed' ? 'review' : 'send')
    }
  }, [spendingEvent, spendingPayments.payments, refreshBalance])

  const ledgerCompletion = ledgerSavings.completion
  useEffect(() => {
    if (!ledgerCompletion || ledgerSavings.payments.getSnapshot().completion !== ledgerCompletion) return
    if (!ledgerSavings.payments.consumeCompletion(ledgerCompletion.id)) return
    setAccount('savings')
    setLastTxid(ledgerCompletion.txid)
    setLastTxKind('onchain')
    setLastSend(ledgerCompletion.payment)
    setSpend({ address: '', amount: 0, fee: vaultDraftFee('savings', liveNetwork) })
    setScreen('success')
    void refreshBalance().catch(() => undefined)
  }, [ledgerCompletion, ledgerSavings.payments, liveNetwork, refreshBalance])

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
  }, [bitcoinCompletion, bitcoinPayments.payments, refreshBalance])

  const approveSend = useCallback(async () => {
    if (account === 'savings') {
      setError('')
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
  ])

  const retryLightningRefund = useCallback(
    async (rfqId: string) => {
      try {
        await spendingPayments.payments.retryRefund(rfqId)
        await refreshBalance().catch(() => undefined)
      } catch {
        // The owner keeps refund errors bound to the current session.
      }
    },
    [spendingPayments.payments, refreshBalance],
  )

  const spendingRenewals = useSpendingRenewals(admitted?.status ?? status, admitted?.enrollment ?? null, locked)

  const navigate = useCallback(
    (next: VaultScreen) => {
      setError('')
      if (next === 'home') {
        setScanOnSend(false)
        clearSpendDraft()
      }
      setScreen(next)
    },
    [setError, clearSpendDraft],
  )
  const openRecover = useCallback(
    (view: 'kit' | 'lost' = 'kit', exit: VaultScreen = 'keys') => {
      setError('')
      setRecoverEntry(view)
      setRecoverExit(exit)
      setScreen('recover')
    },
    [setError],
  )
  const openTx = useCallback(
    (tx: VaultHistoryItem) => {
      const ledger = ledgerSavings.view
      if (
        tx.activity === 'savings-ledger' &&
        ledger &&
        tx.txid === ledger.record.candidateId &&
        !['broadcast', 'confirmed', 'conflicted'].includes(ledger.outcome)
      ) {
        void ledgerSavings.payments
          .reopen(ledger.record.candidateId)
          .then((opened) => {
            if (ledgerSavings.payments.getSnapshot().view !== opened) return
            const payment = opened.record.payment
            setAccount('savings')
            setSpend({ address: payment.destAddress, amount: payment.amountSats, fee: payment.feeSats })
            setError('')
            if (['broadcast', 'confirmed', 'conflicted'].includes(opened.outcome)) {
              setSelectedTx(tx)
              setTxReturn(screen)
              setScreen('tx')
            } else setScreen(opened.record.phonePsbt && !opened.record.txHex ? 'ledger-sign' : 'review')
          })
          .catch(() => undefined)
        return
      }
      setSelectedTx(tx)
      setTxReturn(screen)
      setError('')
      setScreen('tx')
    },
    [ledgerSavings.view, ledgerSavings.payments, screen, setError],
  )
  const openSendScan = useCallback(() => {
    clearSpendDraft(account)
    setScanOnSend(true)
    setError('')
    setScreen('send')
  }, [clearSpendDraft, account, setError])
  const clearSendScan = useCallback(() => setScanOnSend(false), [])

  const value = useMemo<VaultContextProps>(
    () => ({
      watchedSavings,
      updateWatchedSavings,
      watchedSavingsTotalSats: status?.protectionTier === 'light' ? positions.savings.totalSats : undefined,
      account,
      spendingRenewals,
      downloadRecoveryKit,
      backupRecoveryKit,
      backupRecoveryArchive,
      downloadRecoveryArchive,
      recoveryArchiveStatus,
      recoveryArchiveError,
      accountReads,
      boardingError,
      boardingAddress,
      restoreRecoveryKit,
      hasRecoveryKit,
      initiateAlert,
      approveSend,
      busy,
      canSend: spendingAvailableSats >= DUST_SATS,
      confirmConditions,
      dailyLimit,
      dailyRemaining,
      dailySpent: status?.enrolled ? (status.periodSpent ?? 0) : Math.max(0, dailyLimit - dailyRemaining),
      error,
      dismissError: clearError,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      balanceUnit,
      balanceRateStatus,
      setBalanceUnit,
      lastTxid,
      lastTxKind,
      history: recentAccountHistory(visibleHistory, account),
      selectedTx,
      txReturn,
      allHistory: visibleHistory,
      loadOlderActivity,
      olderActivity,
      openTx,
      liveNetwork,
      navigate,
      openRecover,
      recoverEntry,
      recoverExit,
      recoverMatureBoarding,
      networkLabel,
      spendingArkAddress,
      refreshBalance,
      reviewSpend,
      openSendScan,
      scanOnSend,
      clearSendScan,
      savingsAddress,
      positions,
      screen: loaded || screen === 'unlock' ? screen : 'welcome',
      setAccount: selectAccount,
      clearSpendDraft,
      setSpendDraft,
      spend,
      lastSend,
    }),
    [
      watchedSavings,
      updateWatchedSavings,
      account,
      spendingRenewals,
      downloadRecoveryKit,
      backupRecoveryKit,
      backupRecoveryArchive,
      downloadRecoveryArchive,
      recoveryArchiveStatus,
      recoveryArchiveError,
      accountReads,
      boardingError,
      boardingAddress,
      restoreRecoveryKit,
      hasRecoveryKit,
      initiateAlert,
      approveSend,
      busy,
      confirmConditions,
      ledgerSavings.view,
      dailyLimit,
      dailyRemaining,
      error,
      clearError,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      balanceUnit,
      balanceRateStatus,
      setBalanceUnit,
      lastTxid,
      lastTxKind,
      visibleHistory,
      txReturn,
      loadOlderActivity,
      olderActivity,
      selectedTx,
      liveNetwork,
      lastSend,
      recoverEntry,
      recoverExit,
      recoverMatureBoarding,
      loaded,
      networkLabel,
      spendingArkAddress,
      recoverEntry,
      recoverExit,
      refreshBalance,
      reviewSpend,
      scanOnSend,
      savingsAddress,
      positions,
      screen,
      selectAccount,
      clearSpendDraft,
      setSpendDraft,
      spend,
      spendingAvailableSats,
      status?.enrolled,
      status?.periodSpent,
      openTx,
      navigate,
      openRecover,
      openSendScan,
      clearSendScan,
    ],
  )

  const navigationValue = useMemo<VaultNavigationContextProps>(
    () => ({
      screen: loaded || screen === 'unlock' ? screen : 'welcome',
      navigate,
      confirmConditions,
      openRecover,
      recoverEntry,
      recoverExit,
    }),
    [loaded, screen, navigate, confirmConditions, openRecover, recoverEntry, recoverExit],
  )
  const accountValue = useMemo<VaultAccountContextProps>(
    () => ({
      account,
      setAccount: selectAccount,
      positions,
      accountReads,
      watchedSavings,
      updateWatchedSavings,
      watchedSavingsTotalSats: status?.protectionTier === 'light' ? positions.savings.totalSats : undefined,
      savingsAddress,
      spendingArkAddress,
      refreshBalance,
      boardingAddress,
      boardingError,
      dailyLimit,
      dailyRemaining,
      dailySpent: status?.enrolled ? (status.periodSpent ?? 0) : Math.max(0, dailyLimit - dailyRemaining),
    }),
    [
      account,
      selectAccount,
      positions,
      accountReads,
      watchedSavings,
      updateWatchedSavings,
      status?.protectionTier,
      status?.enrolled,
      status?.periodSpent,
      savingsAddress,
      spendingArkAddress,
      refreshBalance,
      boardingAddress,
      boardingError,
      dailyLimit,
      dailyRemaining,
    ],
  )
  const sendValue = useMemo<VaultSendContextProps>(
    () => ({
      spend,
      setSpendDraft,
      clearSpendDraft,
      lastSend,
      canSend: spendingAvailableSats >= DUST_SATS,
      reviewSpend,
      approveSend,
      lastTxid,
      lastTxKind,
      openSendScan,
      scanOnSend,
      clearSendScan,
    }),
    [
      spend,
      setSpendDraft,
      clearSpendDraft,
      lastSend,
      spendingAvailableSats,
      reviewSpend,
      approveSend,
      lastTxid,
      lastTxKind,
      openSendScan,
      scanOnSend,
      clearSendScan,
    ],
  )
  const activityValue = useMemo<VaultActivityContextProps>(
    () => ({
      history: recentAccountHistory(visibleHistory, account),
      allHistory: visibleHistory,
      selectedTx,
      openTx,
      txReturn,
      loadOlderActivity,
      olderActivity,
    }),
    [visibleHistory, account, selectedTx, openTx, txReturn, loadOlderActivity, olderActivity],
  )
  const recoveryValue = useMemo<VaultRecoveryContextProps>(
    () => ({
      downloadRecoveryKit,
      backupRecoveryKit,
      restoreRecoveryKit,
      hasRecoveryKit,
      backupRecoveryArchive,
      downloadRecoveryArchive,
      recoveryArchiveStatus,
      recoveryArchiveError,
      initiateAlert,
      recoverMatureBoarding,
    }),
    [
      downloadRecoveryKit,
      backupRecoveryKit,
      restoreRecoveryKit,
      hasRecoveryKit,
      backupRecoveryArchive,
      downloadRecoveryArchive,
      recoveryArchiveStatus,
      recoveryArchiveError,
      initiateAlert,
      recoverMatureBoarding,
    ],
  )
  const interactionValue = useMemo<VaultInteractionContextProps>(
    () => ({ busy, error, dismissError: clearError }),
    [busy, error, clearError],
  )
  const displayValue = useMemo<VaultDisplayContextProps>(
    () => ({
      balanceUnit,
      balanceRateStatus,
      setBalanceUnit,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      networkLabel,
      liveNetwork,
    }),
    [
      balanceUnit,
      balanceRateStatus,
      setBalanceUnit,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      networkLabel,
      liveNetwork,
    ],
  )
  const renewalValue = useMemo<VaultRenewalContextProps>(() => ({ spendingRenewals }), [spendingRenewals])

  const sessionValue = useMemo(() => sessionView(sessionState, sessionState.session), [sessionState])
  return (
    <VaultSessionContext.Provider value={sessionValue}>
      <LedgerPaymentContext.Provider value={ledgerPaymentView(ledgerSavings, ledgerSavings.payments)}>
        <BitcoinPaymentContext.Provider value={bitcoinPaymentView(bitcoinPayments, bitcoinPayments.payments)}>
          <SpendingPaymentContext.Provider
            value={spendingPaymentView(spendingPayments, {
              openPendingPayment,
              replaceInFlightSend,
              retryLightningRefund,
            })}
          >
            <VaultContext.Provider value={value}>
              <VaultNavigationContext.Provider value={navigationValue}>
                <VaultAccountContext.Provider value={accountValue}>
                  <VaultSendContext.Provider value={sendValue}>
                    <VaultActivityContext.Provider value={activityValue}>
                      <VaultRecoveryContext.Provider value={recoveryValue}>
                        <VaultInteractionContext.Provider value={interactionValue}>
                          <VaultDisplayContext.Provider value={displayValue}>
                            <VaultRenewalContext.Provider value={renewalValue}>{children}</VaultRenewalContext.Provider>
                          </VaultDisplayContext.Provider>
                        </VaultInteractionContext.Provider>
                      </VaultRecoveryContext.Provider>
                    </VaultActivityContext.Provider>
                  </VaultSendContext.Provider>
                </VaultAccountContext.Provider>
              </VaultNavigationContext.Provider>
            </VaultContext.Provider>
          </SpendingPaymentContext.Provider>
        </BitcoinPaymentContext.Provider>
      </LedgerPaymentContext.Provider>
    </VaultSessionContext.Provider>
  )
}
