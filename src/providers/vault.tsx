import { DUST_SATS } from '../lib/vault/constants'
import { useLedgerPayments } from '../vault/useLedgerPayments'
import { ledgerPaymentView, LedgerPaymentContext } from '../vault/ledgerPaymentContext'
import { withBitcoinPaymentHistory } from '../lib/vault/bitcoinPaymentHistory'
import { useNativePaymentNotifications } from '../vault/useNativePaymentNotifications'
import { useNativeTapNavigation } from '../vault/useNativeTapNavigation'

import { NOTIFY_WORKER_SCOPE } from '../lib/vault/nativeNotifications'
import { isPushSubscribed, refreshBackgroundPush } from '../lib/vault/pushSubscription'
import { useSpendingPayments } from '../vault/useSpendingPayments'
import { spendingPaymentView, SpendingPaymentContext } from '../vault/spendingPaymentContext'
import { useBitcoinPayments } from '../vault/useBitcoinPayments'
import { bitcoinPaymentView, BitcoinPaymentContext } from '../vault/bitcoinPaymentContext'
import { useSpendingRenewals } from '../vault/useSpendingRenewals'
import { useRecoveryCommands } from '../vault/useRecoveryCommands'
import {
  useVaultActivityBinding,
  useVaultDisplayBinding,
  useVaultNavigationBinding,
  useVaultSendBinding,
  useWatchedSavingsBinding,
} from '../vault/useVaultPresentation'
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

import { DEFAULT_SPEND_FEE_SATS, type VaultAccount, type VaultScreen } from '../vault/context'
import { useRecoveryAlerts } from '../vault/useRecoveryAlerts'
import { useVaultBalances } from '../vault/useVaultBalances'
import { useVaultSession } from '../vault/useVaultSession'
import { sessionView, VaultSessionContext } from '../vault/sessionContext'

export type { VaultAccount, VaultScreen, VaultSpend } from '../vault/context'

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
  const clearError = useCallback(() => setError(''), [setError])
  const busy =
    spendingPayments.pending !== null ||
    (bitcoinPayments.pending !== null && !['approval', 'acknowledge'].includes(bitcoinPayments.pending)) ||
    ledgerSavings.pending !== null ||
    (pending !== null && pending !== 'boot')

  const activeNetwork = status?.network || deployment?.network
  const liveNetwork = activeNetwork === 'mutinynet'
  const [account, setAccount] = useState<VaultAccount>('spend')
  const { fiatDisplayRate, fiatDisplayEnabled, setFiatDisplay, balanceUnit, balanceRateStatus, setBalanceUnit } =
    useVaultDisplayBinding()
  const { watchedSavings, updateWatchedSavings } = useWatchedSavingsBinding(status)

  const sendRef = useRef<ReturnType<typeof useVaultSendBinding> | null>(null)
  const { screen, setScreen, navigate, openRecover, recoverEntry, recoverExit } = useVaultNavigationBinding({
    transition,
    observeDeployment: session.observeDeployment,
    cancelLedgerConnection: session.cancelLedgerConnection,
    clearError,
    onLeaveSend: () => sendRef.current?.clearSpendDraft(),
  })
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
  const send = useVaultSendBinding({
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
  })
  sendRef.current = send
  const {
    spend,
    setSpendDraft,
    clearSpendDraft,
    restoreDraft,
    applyDraftFee,
    lastSend,
    lastTxid,
    lastTxKind,
    scanOnSend,
    openSendScan,
    clearSendScan,
    reviewSpend,
    reviewReplace,
    approveSend,
  } = send
  const savingsAddress =
    status?.protectionTier === 'light' ? watchedSavings?.address || '' : addressPin?.savingsAddress || ''
  const spendingArkAddress = status?.spendingArkAddress || ''
  const boardingAddress = status?.vtxoBoardingAddress || ''
  const selectAccount = useCallback(
    (next: VaultAccount) => {
      bitcoinPayments.payments.cancelReview()
      spendingPayments.payments.cancelReview()
      setAccount(next)
      setScreen('home')
      applyDraftFee(vaultDraftFee(next, liveNetwork))
    },
    [liveNetwork, bitcoinPayments.payments, spendingPayments.payments, setScreen, applyDraftFee],
  )
  const activityRef = useRef<ReturnType<typeof useVaultActivityBinding> | null>(null)
  const interceptActivity = useCallback(
    (tx: VaultHistoryItem, returnTo: VaultScreen) => {
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
            restoreDraft({ address: payment.destAddress, amount: payment.amountSats, fee: payment.feeSats })
            if (['broadcast', 'confirmed', 'conflicted'].includes(opened.outcome)) {
              activityRef.current?.select(tx, returnTo)
              setScreen('tx')
            } else setScreen(opened.record.phonePsbt && !opened.record.txHex ? 'ledger-sign' : 'review')
          })
          .catch(() => undefined)
        return true
      }
      return false
    },
    [ledgerSavings.view, ledgerSavings.payments, restoreDraft, setScreen],
  )
  const activity = useVaultActivityBinding({ screen, setScreen, clearError, intercept: interceptActivity })
  activityRef.current = activity
  const { selectedTx, txReturn, openTx, syncSelection } = activity
  const spendingAvailableSats = positions.spending.availableSats
  const dailyLimit = status?.enrolled ? (status.periodAllowance ?? setup.dailyLimitSats) : setup.dailyLimitSats
  const dailyRemaining = status?.enrolled ? (status.periodRemaining ?? dailyLimit) : 0
  const networkLabel = activeNetwork === 'mainnet' ? 'Bitcoin' : liveNetwork ? 'Mutinynet' : 'Unavailable'

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
    syncSelection((current) => {
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
  // Native tap flow: a worker tap opens `/?notify=activity`. After unlock and
  // with a fresh snapshot, retain the Activity destination, strip the marker,
  // and request a refreshed verified snapshot.
  useNativeTapNavigation({
    blocked: locked || !activityReady,
    scopeKey: `${status?.network || ''}:${status?.vaultId || ''}`,
    navigate: setScreen,
    refresh: refreshBalance,
  })

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

  const openPendingPayment = useCallback(
    async (operationId: string) => {
      try {
        const opened = await spendingPayments.payments.openPending(operationId)
        if (spendingPayments.payments.getSnapshot().opened !== opened) return
        setAccount('spend')
        restoreDraft(opened.payment)
        setScreen(opened.review ? 'review' : 'send')
      } catch {
        // The owner keeps operation errors bound to the current session.
      }
    },
    [spendingPayments.payments],
  )

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
              replaceInFlightSend: reviewReplace,
              retryLightningRefund,
            })}
          >
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
          </SpendingPaymentContext.Provider>
        </BitcoinPaymentContext.Provider>
      </LedgerPaymentContext.Provider>
    </VaultSessionContext.Provider>
  )
}
