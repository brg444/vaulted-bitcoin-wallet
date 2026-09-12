import { requireSupportedVaultNetwork, DUST_SATS } from '../lib/vault/constants'
import { loadWatchedSavings, saveWatchedSavings, type WatchedSavingsAddress } from '../lib/vault/watchSavings'
import { useLedgerSavings } from '../vault/useLedgerSavings'
import { BitcoinPaymentError } from '../lib/vault/bitcoinPaymentError'
import { withBitcoinPaymentHistory } from '../lib/vault/bitcoinPaymentHistory'
import { useNativePaymentNotifications } from '../vault/useNativePaymentNotifications'

import { NOTIFY_WORKER_SCOPE } from '../lib/vault/nativeNotifications'
import { parsePushNavScreen } from '../lib/vault/notificationEnvelope'
import { isPushSubscribed, refreshBackgroundPush } from '../lib/vault/pushSubscription'
import type { BitcoinPaymentOutput } from '../lib/vault/spendingBitcoinStore'
import { sendSpendingToBitcoin } from '../lib/vault/spendingBitcoinFunding'
import { useSpendingBitcoin } from '../vault/useSpendingBitcoin'
import { useSpendingRenewals } from '../vault/useSpendingRenewals'
import { useRecoveryArchive } from '../vault/useRecoveryArchive'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NetworkName } from '@arkade-os/sdk'
import { zeroBytes } from '../lib/vault/ceremony/directauth'
import { olderRowKey, recentAccountHistory, type VaultHistoryItem } from '../lib/vault/history'
import { unlockPhoneBip340 } from '../lib/vault/savingsSpend'
import { consoleError } from '../lib/logs'
import { requireSdkNetworkName, vaultOperatorOrigin } from '../lib/vault/networkPins'
import { humanizeVaultError } from '../lib/vault/humanize'
import { bitcoinDustSats, isVaultArkAddress, isVaultSpendAddress, scriptHexFromAddress } from '../lib/vault/bitcoin'
import {
  discoverVaultLightningSolver,
  isVaultLightningInput,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
} from '../lib/vault/lightningConfig'
import { decodeVaultLightningInvoice } from '../lib/vault/lightningInvoice'
import { LightningPaymentError } from '../lib/vault/lightningError'
import type { VaultLightningQuote } from '../lib/vault/lightningLifecycle'
import {
  createVtxoSpendUnlocker,
  isVtxoAbortFailedError,
  isVtxoLivePendingError,
  isVtxoReceiptPendingError,
  isVtxoReservedReplaceError,
  isVtxoReviewedReservationError,
  isVtxoSameSendInProgressError,
  isSameVtxoPayment,
  isVtxoSpendInFlightError,
  loadPersistedVtxoSpend,
  listPersistedVtxoSpends,
  quoteFromPersistedVtxoSpend,
  loadPersistedVtxoSpendById,
  newVtxoSpendChallenge,
  previewVaultVtxoSend,
  reserveVaultVtxo,
  sendVaultVtxo,
  vtxoSpendIsLivePending,
  type VaultVtxoSpendQuote,
} from '../lib/vault/vtxo/spend'
import { recoverMatureBoardingInputs } from '../lib/vault/vtxo/boardingRecovery'
import { ensureVaultWalletWorker } from '../lib/vault/vtxo/walletWorker'
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
import { useRecoveryKit } from '../vault/useRecoveryKit'
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

export function reviewedVtxoQuoteMatchesDraft(quote: VaultVtxoSpendQuote | null, spend: VaultSpend): boolean {
  return Boolean(
    quote &&
      quote.destAddress.trim() === spend.address.trim() &&
      quote.amountSats === spend.amount &&
      quote.feeSats === spend.fee,
  )
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const {
    session,
    setup,
    status,
    deployment,
    enrollment,
    loaded,
    initialStatusChecked,
    locked,
    addressPin,
    pending,
    transition,
    error: sessionError,
  } = useVaultSession()
  const [screen, setScreen] = useState<VaultScreen>('welcome')
  const [recoverEntry, setRecoverEntry] = useState<'kit' | 'lost'>('kit')
  const [recoverExit, setRecoverExit] = useState<VaultScreen>('keys')
  const [operationError, setOperationError] = useState('')
  const error = operationError || sessionError
  const setError = useCallback(
    (message: string) => {
      session.clearError()
      setOperationError(message)
    },
    [session],
  )
  const [paymentError, setPaymentError] = useState<BitcoinPaymentError | undefined>()
  const [paymentBusy, setPaymentBusy] = useState(false)
  const busy = paymentBusy || (pending !== null && pending !== 'boot')
  const [spend, setSpend] = useState<VaultSpend>({ address: '', amount: 0, fee: 0 })
  const spendRef = useRef(spend)
  spendRef.current = spend
  const [reviewedVtxoQuote, setReviewedVtxoQuote] = useState<VaultVtxoSpendQuote | null>(null)
  const [lightningQuote, setLightningQuote] = useState<VaultLightningQuote | null>(null)
  const [canReplaceInFlightSend, setCanReplaceInFlightSend] = useState(false)
  const bitcoinApproval = useRef<{
    resolve: (approved: boolean) => void
    address: string
    amount: number
    fee: number
  } | null>(null)
  const replaceExistingVtxoRef = useRef(false)
  const [lastSend, setLastSend] = useState<VaultSpend | null>(null)
  const [lastTxid, setLastTxid] = useState('')
  const [lastTxKind, setLastTxKind] = useState<'onchain' | 'vtxo' | 'lightning' | ''>('')
  const [selectedTx, setSelectedTx] = useState<VaultHistoryItem | null>(null)
  const [txReturn, setTxReturn] = useState<VaultScreen>('home')
  const [account, setAccount] = useState<VaultAccount>('spend')
  const [scanOnSend, setScanOnSend] = useState(false)
  useEffect(() => {
    if (bitcoinApproval.current && screen !== 'review') {
      bitcoinApproval.current.resolve(false)
      bitcoinApproval.current = null
    }
  }, [screen])
  useEffect(
    () => () => {
      bitcoinApproval.current?.resolve(false)
    },
    [],
  )

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
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
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
      setAccount(next)
      setScreen('home')
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
      setSpend((previous) => ({ ...previous, fee: vaultDraftFee(next, liveNetwork) }))
    },
    [liveNetwork],
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
    enrollment,
    initialStatusChecked,
    locked,
    setStatus: session.acceptStatus,
    status,
  })
  const spendingAvailableSats = positions.spending.availableSats
  const dailyLimit = status?.enrolled ? (status.periodAllowance ?? setup.dailyLimitSats) : setup.dailyLimitSats
  const dailyRemaining = status?.enrolled ? (status.periodRemaining ?? dailyLimit) : 0
  const networkLabel = activeNetwork === 'mainnet' ? 'Bitcoin' : liveNetwork ? 'Mutinynet' : 'Unavailable'
  const clearError = useCallback(() => reportError(''), [reportError])

  const ledgerSavings = useLedgerSavings(status, enrollment, locked)
  const { snapshot: spendingBitcoin, acknowledgeRecovery: acknowledgeBitcoinRecovery } = useSpendingBitcoin(
    status,
    locked,
  )
  const historyWithBitcoin = useMemo(
    () => withBitcoinPaymentHistory(history, spendingBitcoin.operation),
    [history, spendingBitcoin.operation],
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
  const { backupRecoveryKit, downloadRecoveryKit, hasRecoveryKit, restoreRecoveryKit } = useRecoveryKit({
    enrollment,
    status,
    hardwarePub: setup.hardwarePub,
    recoveryPub: setup.recoveryPub,
    clearError,
  })

  const { backupRecoveryArchive, downloadRecoveryArchive, recoveryArchiveStatus, recoveryArchiveError } =
    useRecoveryArchive(enrollment, status, locked, acknowledgeBitcoinRecovery)

  const confirmConditions = useCallback(() => {
    setError('')
    setScreen('plan')
  }, [setError])

  const clearSpendDraft = useCallback(
    (acct: VaultAccount = account) => {
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
      setSpend({ address: '', amount: 0, fee: vaultDraftFee(acct, liveNetwork) })
    },
    [account, liveNetwork],
  )

  const setSpendDraft = useCallback(
    (draft: Partial<VaultSpend>) => {
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
      setCanReplaceInFlightSend(false)
      setSpend((prev) => {
        const next = { ...prev, ...draft }
        next.fee = vaultDraftFee(account, liveNetwork)
        return next
      })
      setError('')
    },
    [account, liveNetwork],
  )

  const reviewedPendingPayment =
    reviewedVtxoQuote && status?.vaultId
      ? loadPersistedVtxoSpendById(status.vaultId, reviewedVtxoQuote.operationId)
      : undefined
  const resumingPayment = Boolean(reviewedPendingPayment && vtxoSpendIsLivePending(reviewedPendingPayment))

  const pendingPayments = status?.enrolled
    ? listPersistedVtxoSpends(status.vaultId).map((operation) => ({
        operationId: operation.operationId,
        amountSats: operation.amountSats,
        authorized: vtxoSpendIsLivePending(operation),
      }))
    : []

  const openPendingPayment = useCallback(
    async (operationId: string) => {
      if (!status?.enrolled) return
      setPaymentBusy(true)
      setError('')
      try {
        const pending = loadPersistedVtxoSpendById(status.vaultId, operationId)
        if (!pending) throw new Error('This pending payment has already finished. Refresh the wallet.')
        await ensureVaultWalletWorker(status)
        const lightning = await import('../lib/vault/lightning')
        const quote = await lightning.withVaultLightningRepository(status.vaultId, (repository) =>
          lightning.loadVaultLightningFundingQuote(repository, requireSdkNetworkName(status.network), {
            operationId: pending.operationId,
            bundleDigest: pending.bundleDigest,
            address: pending.destAddress,
            amountSats: pending.amountSats,
            fundingFeeSats: pending.feeSats,
          }),
        )
        setAccount('spend')
        setCanReplaceInFlightSend(false)
        setLightningQuote(quote || null)
        setSpend({
          address: quote?.invoice || pending.destAddress,
          amount: quote?.invoiceAmountSats || pending.amountSats,
          fee: (quote?.corridorFeeSats || 0) + (pending.feeSats || 0),
        })
        if (pending.stage === 'pre-reserve') {
          setReviewedVtxoQuote(null)
          setScreen('send')
        } else {
          setReviewedVtxoQuote(quoteFromPersistedVtxoSpend(pending))
          setScreen('review')
        }
      } catch (err) {
        consoleError(err, 'Open pending payment')
        setError(humanizeVaultError(err))
      } finally {
        setPaymentBusy(false)
      }
    },
    [status],
  )

  const lightningReviewInFlight = useRef(false)
  const reviewLightningSpend = useCallback(async () => {
    if (lightningReviewInFlight.current) return
    lightningReviewInFlight.current = true
    setPaymentBusy(true)
    let phase = 'validation'
    try {
      if (!status?.enrolled || !enrollment)
        throw new LightningPaymentError('Sign in with the passkey that created this vault.')
      if (account !== 'spend') throw new LightningPaymentError('Lightning payments use Spending.')
      if (!vaultLightningSendEnabled(status.network as NetworkName)) {
        throw new LightningPaymentError('Lightning send is not enabled in this release.')
      }
      const pinned = vaultLightningSolverProfile(status.network)
      if (!pinned) throw new LightningPaymentError('No Lightning solver is configured for this network.')
      const invoice = decodeVaultLightningInvoice(spend.address, pinned.network)
      if (listPersistedVtxoSpends(status.vaultId).some(vtxoSpendIsLivePending)) {
        throw new LightningPaymentError(
          'A payment is still pending. Open Pending payment to resume it before starting another.',
        )
      }
      if (invoice.amountSats > setup.txCapSats) {
        throw new LightningPaymentError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats.`)
      }
      if (invoice.amountSats > spendingAvailableSats)
        throw new LightningPaymentError('Not enough confirmed spending funds.')
      const persistedVtxo = loadPersistedVtxoSpend(status.vaultId)
      const resumeVtxo =
        persistedVtxo?.bundleDigest && persistedVtxo.destAddress && Number.isSafeInteger(persistedVtxo.amountSats)
          ? {
              operationId: persistedVtxo.operationId,
              bundleDigest: persistedVtxo.bundleDigest,
              address: persistedVtxo.destAddress,
              amountSats: persistedVtxo.amountSats,
              fundingFeeSats: persistedVtxo.feeSats,
            }
          : undefined
      // Reach WebAuthn directly from the click. Card discovery and module loading
      // must not consume the browser's user gesture before its passkey request.
      phase = 'passkey approval'
      const phoneSecret = await unlockPhoneBip340(enrollment, status)
      let quote: VaultLightningQuote
      let funding: VaultVtxoSpendQuote
      try {
        phase = 'solver verification'
        const profile = await discoverVaultLightningSolver(status.network)
        if (!profile) throw new LightningPaymentError('No verified Lightning solver is configured for this network.')
        const lightning = await import('../lib/vault/lightning')
        phase = 'quote'
        quote = await lightning.withVaultLightningSdkWallet(phoneSecret, status, (session) =>
          lightning.withVaultLightningTransport(profile, (transport) =>
            lightning.requestVaultLightningQuote({
              wallet: session.wallet,
              arkServerUrl: vaultOperatorOrigin(profile.network),
              invoice: invoice.raw,
              network: profile.network,
              transport,
              repository: session.repository,
              contracts: session.contracts,
              manager: session.manager,
              profile,
              resumeVtxo,
            }),
          ),
        )
        if (quote.fundAmountSats > setup.txCapSats) {
          throw new LightningPaymentError(
            `This payment exceeds the ${setup.txCapSats.toLocaleString()} sat send limit after fees.`,
          )
        }
        // The SDK session has released its lock; reuse this approval for the reservation.
        phase = 'reservation'
        funding = await reserveVaultVtxo(enrollment, status, quote.fundAddress, quote.fundAmountSats, { phoneSecret })
      } finally {
        zeroBytes(phoneSecret)
      }
      phase = 'review'
      if (quote.fundAmountSats + funding.feeSats > spendingAvailableSats) {
        throw new LightningPaymentError('Not enough confirmed spending funds after fees.')
      }
      if (spendRef.current.address.trim().replace(/^lightning:/i, '') !== invoice.raw) {
        throw new LightningPaymentError('Send details changed. Review the send again.')
      }
      setLightningQuote(quote)
      setReviewedVtxoQuote(funding)
      setSpend((current) =>
        current.address.trim().replace(/^lightning:/i, '') === invoice.raw
          ? { ...current, amount: quote.invoiceAmountSats, fee: quote.corridorFeeSats + funding.feeSats }
          : current,
      )
      setScreen('review')
    } catch (err) {
      consoleError(err, `Lightning payment ${phase}`)
      setLightningQuote(null)
      setReviewedVtxoQuote(null)
      setError(humanizeVaultError(err))
    } finally {
      lightningReviewInFlight.current = false
      setPaymentBusy(false)
    }
  }, [account, enrollment, setup.txCapSats, spend.address, spendingAvailableSats, status])

  const [bitcoinOutputs, setBitcoinOutputs] = useState<BitcoinPaymentOutput[] | undefined>()
  const reviewBitcoinPayment = useCallback(
    async (outputs: BitcoinPaymentOutput[], draft: VaultSpend) => {
      if (!status?.enrolled || !enrollment) {
        setError('Sign in with the passkey that created this vault.')
        return
      }
      setPaymentError(undefined)
      setError('')
      setBitcoinOutputs(outputs)
      setPaymentBusy(true)
      setLightningQuote(null)
      let approvedFee = 0
      let approvalAccepted = false
      try {
        const result = await sendSpendingToBitcoin(
          enrollment,
          status,
          outputs,
          (plan) =>
            new Promise<boolean>((resolve) => {
              if (spendRef.current.address !== draft.address || spendRef.current.amount !== draft.amount) {
                resolve(false)
                return
              }
              approvedFee = plan.feeSats
              bitcoinApproval.current = { resolve, address: draft.address, amount: draft.amount, fee: plan.feeSats }
              setSpend({ ...draft, fee: plan.feeSats })
              setScreen('review')
              setPaymentBusy(false)
            }).then((accepted) => {
              approvalAccepted = accepted
              return accepted
            }),
          () => {},
        )
        if (['submitted', 'confirmed'].includes(result.state) && result.commitmentTxid) {
          setLastTxid(result.commitmentTxid)
          setLastTxKind('onchain')
          setLastSend({ ...draft, fee: approvedFee })
          setSpend({ address: '', amount: 0, fee: 0 })
          setScreen('success')
        } else if (approvalAccepted) {
          setScreen('home')
        }
        try {
          await refreshBalance(status.vaultId)
        } catch {
          /* Payment outcome is independent of balance refresh. */
        }
      } catch (err) {
        setPaymentError(err instanceof BitcoinPaymentError ? err : undefined)
        setError(humanizeVaultError(err))
        if (approvalAccepted) setScreen('home')
      } finally {
        bitcoinApproval.current = null
        setPaymentBusy(false)
      }
    },
    [enrollment, status, refreshBalance],
  )
  const reviewSpend = useCallback(async () => {
    setError('')
    setReviewedVtxoQuote(null)
    if (!status?.enrolled) {
      setError('Unlock this vault before sending.')
      return
    }
    if (account === 'savings' && status.protectionTier === 'light') {
      setError('Savings is watch-only in this wallet.')
      return
    }
    if (isVaultLightningInput(spend.address)) {
      await reviewLightningSpend()
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
      await reviewBitcoinPayment(
        [{ script: scriptHexFromAddress(spend.address, destNetwork), amountSats: spend.amount }],
        spend,
      )
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
      setPaymentBusy(true)
      try {
        const fee = await ledgerSavings.review(spend)
        if (spendRef.current.address !== spend.address || spendRef.current.amount !== spend.amount) {
          setError('Send details changed. Review the payment again.')
          return
        }
        setSpend({ ...spend, fee })
        setScreen('review')
      } catch (err) {
        setError(humanizeVaultError(err))
      } finally {
        setPaymentBusy(false)
      }
      return
    }
    const persistedVtxo = loadPersistedVtxoSpend(status.vaultId)
    const resumingVtxo = Boolean(persistedVtxo && isSameVtxoPayment(persistedVtxo, spend.address, spend.amount))
    if (!resumingVtxo && listPersistedVtxoSpends(status.vaultId).some(vtxoSpendIsLivePending)) {
      setError('A payment is still pending. Open Pending payment to resume it before starting another.')
      return
    }
    if (!resumingVtxo && spend.amount > setup.txCapSats) {
      setError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats.`)
      return
    }
    if (spend.amount > spendingAvailableSats && !resumingVtxo) {
      setError('Not enough confirmed spending funds.')
      return
    }
    if (!enrollment) {
      setError('Sign in with the passkey that created this vault.')
      return
    }
    setPaymentBusy(true)
    try {
      const preview = await previewVaultVtxoSend(status, spend.address, spend.amount, {
        replaceExisting: replaceExistingVtxoRef.current,
      })
      if (
        spendRef.current.address.trim() !== preview.destAddress.trim() ||
        spendRef.current.amount !== preview.amountSats
      ) {
        setError('Send details changed. Review the send again.')
        return
      }
      setCanReplaceInFlightSend(false)
      setReviewedVtxoQuote(preview)
      setSpend((current) =>
        current.address === spend.address && current.amount === spend.amount
          ? { ...current, fee: preview.feeSats }
          : current,
      )
    } catch (err) {
      setCanReplaceInFlightSend(isVtxoReservedReplaceError(err))
      setError(humanizeVaultError(err))
      return
    } finally {
      setPaymentBusy(false)
    }
    setScreen('review')
  }, [
    account,
    enrollment,
    reviewLightningSpend,
    reviewBitcoinPayment,
    ledgerSavings.review,
    setup.txCapSats,
    spend,
    status,
    spendingAvailableSats,
  ])

  const replaceInFlightSend = useCallback(async () => {
    replaceExistingVtxoRef.current = true
    setCanReplaceInFlightSend(false)
    setError('')
    await reviewSpend()
  }, [reviewSpend])

  const finishBroadcast = useCallback(
    async (txid: string, kind: 'onchain' | 'vtxo' | 'lightning' = 'onchain', authoritativeFee?: number) => {
      setLastTxid(txid)
      setLastTxKind(kind)
      setLastSend(authoritativeFee === undefined ? spend : { ...spend, fee: authoritativeFee })
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
      setSpend({ address: '', amount: 0, fee: vaultDraftFee(account, liveNetwork) })
      // Leave Review in the same update that clears its draft.
      setScreen('success')
      if (status?.vaultId) {
        try {
          await refreshBalance(status.vaultId)
        } catch {
          // A submitted transaction stays successful when the follow-up balance
          // refresh is temporarily unavailable. The normal refresher will retry.
        }
      }
    },
    [account, liveNetwork, refreshBalance, spend, status],
  )

  const approveSavingsSend = useCallback(async () => {
    if (status?.protectionTier === 'light') throw new Error('Savings is watch-only in this wallet.')
    if (!status?.enrolled || !enrollment || !savingsAddress) {
      throw new Error('Sign in with the passkey that created this vault.')
    }
    if (status.templateVersion !== LEDGER_NATIVE_TEMPLATE) {
      throw new Error('This Savings program is no longer supported.')
    }
    const txid = await ledgerSavings.approve(spend)
    if (txid) await finishBroadcast(txid)
    else setScreen('ledger-sign')
  }, [enrollment, savingsAddress, spend, status, finishBroadcast, ledgerSavings.approve])

  const completeLedgerPayment = useCallback(
    async (candidateId: string, signedPsbt: string) => {
      setPaymentBusy(true)
      setError('')
      try {
        const txid = await ledgerSavings.complete(candidateId, signedPsbt)
        await finishBroadcast(txid)
      } catch (err) {
        setError(humanizeVaultError(err))
        throw err
      } finally {
        await ledgerSavings.refresh().catch(() => {})
        setPaymentBusy(false)
      }
    },
    [ledgerSavings.complete, ledgerSavings.refresh, finishBroadcast],
  )

  const approveSend = useCallback(async () => {
    if (bitcoinApproval.current) {
      const approval = bitcoinApproval.current
      bitcoinApproval.current = null
      const matches =
        account === 'spend' &&
        spend.address === approval.address &&
        spend.amount === approval.amount &&
        spend.fee === approval.fee
      setPaymentBusy(matches)
      if (!matches) setError('Payment details changed. Review the payment again.')
      approval.resolve(matches)
      return
    }
    setPaymentBusy(true)
    setError('')
    try {
      if (account === 'savings') {
        await approveSavingsSend()
        return
      }
      if (!status?.enrolled || !enrollment) {
        setError('Sign in with the passkey that created this vault.')
        return
      }
      if (!spendingArkAddress) {
        setError('No spending address yet.')
        return
      }
      if (lightningQuote) {
        const lightning = await import('../lib/vault/lightning')
        const reviewed = reviewedVtxoQuote
        const pending = reviewed && loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId)
        const alreadyAuthorized = Boolean(
          pending &&
            vtxoSpendIsLivePending(pending) &&
            pending.bundleDigest === reviewed?.bundleDigest &&
            isSameVtxoPayment(pending, lightningQuote.fundAddress, lightningQuote.fundAmountSats),
        )
        if (!alreadyAuthorized) lightning.assertVaultLightningQuoteCurrent(lightningQuote)
        const expectedFee = lightningQuote.corridorFeeSats + (reviewed?.feeSats ?? 0)
        if (
          !reviewed ||
          reviewed.destAddress !== lightningQuote.fundAddress ||
          reviewed.amountSats !== lightningQuote.fundAmountSats ||
          spend.address.trim().replace(/^lightning:/i, '') !== lightningQuote.invoice ||
          spend.amount !== lightningQuote.invoiceAmountSats ||
          spend.fee !== expectedFee
        ) {
          setReviewedVtxoQuote(null)
          setLightningQuote(null)
          setError('This Lightning quote expired or changed. Review the payment again.')
          setScreen('send')
          return
        }
        try {
          const sent = await lightning.withVaultLightningLifecycleLock(status.vaultId, async () => {
            const proof = {
              rfqId: lightningQuote.rfqId,
              address: reviewed.destAddress,
              amountSats: reviewed.amountSats,
              operationId: reviewed.operationId,
              bundleDigest: reviewed.bundleDigest,
              fundingFeeSats: reviewed.feeSats,
            }
            const target = await lightning.withVaultLightningRepository(status.vaultId, async (repository) => {
              try {
                return await lightning.resumeVaultLightningFunding(repository, proof, undefined, alreadyAuthorized)
              } catch (err) {
                if (!(err instanceof lightning.VaultLightningFundingNotStartedError)) throw err
                return lightning.beginVaultLightningFunding(repository, lightningQuote.rfqId, proof)
              }
            })
            if (target.address !== reviewed.destAddress || target.amountSats !== reviewed.amountSats)
              throw new Error('Lightning funding target changed after Review.')
            let sent: { txid: string; feeSats: number }
            try {
              sent = await sendVaultVtxo(enrollment, status, reviewed)
            } catch (err) {
              if (isVtxoReceiptPendingError(err)) {
                sent = { txid: err.txid, feeSats: err.feeSats }
              } else {
                throw err
              }
            }
            await lightning.withVaultLightningRepository(status.vaultId, (repository) =>
              lightning.recordVaultLightningFundingTxid(repository, lightningQuote.rfqId, sent.txid),
            )
            return sent
          })
          await finishBroadcast(sent.txid, 'lightning', expectedFee)
          return
        } catch (err) {
          if (isVtxoReviewedReservationError(err)) {
            setReviewedVtxoQuote(null)
            setLightningQuote(null)
            setSpend((current) => ({ ...current, fee: vaultDraftFee('spend', liveNetwork) }))
            setError(humanizeVaultError(err))
            setScreen('send')
            return
          }
          if (status.vaultId) await refreshBalance(status.vaultId)
          if (
            isVtxoSpendInFlightError(err) ||
            isVtxoSameSendInProgressError(err) ||
            isVtxoLivePendingError(err) ||
            isVtxoAbortFailedError(err)
          ) {
            setCanReplaceInFlightSend(isVtxoReservedReplaceError(err))
            setError(humanizeVaultError(err))
            setScreen('send')
            return
          }
          throw err
        }
      }
      if (spendingArkAddress && isVaultArkAddress(spend.address, status.network)) {
        const reviewed = reviewedVtxoQuote
        if (!reviewed || !reviewedVtxoQuoteMatchesDraft(reviewed, spend)) {
          setReviewedVtxoQuote(null)
          setSpend((current) => ({ ...current, fee: vaultDraftFee('spend', liveNetwork) }))
          setError('This fee quote expired or changed. Review the send again.')
          setScreen('send')
          return
        }
        try {
          const replaceExisting = replaceExistingVtxoRef.current
          replaceExistingVtxoRef.current = false
          const existing = loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId)
          const resumePending = Boolean(
            reviewed.operationId &&
              existing &&
              vtxoSpendIsLivePending(existing) &&
              reviewedVtxoQuoteMatchesDraft(reviewed, spend),
          )
          const unlocker = createVtxoSpendUnlocker(
            enrollment,
            status,
            resumePending ? reviewed.bundleDigest : newVtxoSpendChallenge(),
          )
          try {
            const auth = await unlocker.unlock()
            const quote = resumePending
              ? reviewed
              : await reserveVaultVtxo(enrollment, status, reviewed.destAddress, reviewed.amountSats, {
                  replaceExisting,
                  phoneSecret: auth.phoneSecret,
                })
            if (!resumePending && quote.feeSats !== reviewed.feeSats) {
              setReviewedVtxoQuote(quote)
              setSpend((current) => ({ ...current, fee: quote.feeSats }))
              setError('The network fee changed. Review the updated total before approving.')
              return
            }
            const result = await sendVaultVtxo(enrollment, status, quote, () => unlocker)
            await finishBroadcast(result.txid, 'vtxo', result.feeSats)
          } finally {
            unlocker.dispose()
          }
          return
        } catch (err) {
          if (isVtxoReceiptPendingError(err)) {
            await finishBroadcast(err.txid, 'vtxo', err.feeSats)
            return
          }
          if (isVtxoReviewedReservationError(err)) {
            setReviewedVtxoQuote(null)
            setSpend((current) => ({ ...current, fee: vaultDraftFee('spend', liveNetwork) }))
            setError(humanizeVaultError(err))
            setScreen('send')
            return
          }
          if (status.vaultId) await refreshBalance(status.vaultId)
          if (
            isVtxoSpendInFlightError(err) ||
            isVtxoSameSendInProgressError(err) ||
            isVtxoLivePendingError(err) ||
            isVtxoAbortFailedError(err) ||
            isVtxoReservedReplaceError(err)
          ) {
            setCanReplaceInFlightSend(isVtxoReservedReplaceError(err))
            setError(humanizeVaultError(err))
            setScreen('send')
            return
          }
          throw err
        }
      }
      setError('Vault isn’t ready to send.')
    } catch (err) {
      consoleError(err, 'Payment authorization or finalization')
      const pending = status?.vaultId && listPersistedVtxoSpends(status.vaultId).find(vtxoSpendIsLivePending)
      setError(
        pending
          ? 'Payment is pending; it has not been confirmed as paid. Open Pending payment to resume it.'
          : humanizeVaultError(err),
      )
      if (status?.vaultId) await refreshBalance(status.vaultId)
    } finally {
      setPaymentBusy(false)
    }
  }, [
    account,
    approveSavingsSend,
    enrollment,
    finishBroadcast,
    lightningQuote,
    liveNetwork,
    refreshBalance,
    reviewedVtxoQuote,
    spend,
    spendingArkAddress,
    status,
    spendingAvailableSats,
  ])

  const retryLightningRefund = useCallback(
    async (rfqId: string) => {
      setPaymentBusy(true)
      setError('')
      let phoneSecret: Uint8Array | undefined
      try {
        if (!status?.enrolled || !enrollment) throw new Error('Sign in before returning this payment.')
        const lightning = await import('../lib/vault/lightning')
        phoneSecret = await unlockPhoneBip340(enrollment, status)
        await lightning.withVaultLightningSdkWallet(
          phoneSecret,
          status,
          async (session) => {
            const record = await lightning.getVaultLightningStatus(session.repository, rfqId)
            if (!record) throw new Error('This Lightning payment is no longer available.')
            if (record.state === 'refunded' || record.state === 'settled') return
            if (record.state === 'needs_counterparty') {
              throw new Error('The Lightning payment could not be returned yet. Try again shortly.')
            }
            if (record.state === 'failed') {
              throw new Error('The Lightning payment needs recovery before it can be returned.')
            }
            throw new Error('This Lightning payment is still processing.')
          },
          { refundRfqId: rfqId },
        )
        await refreshBalance(status.vaultId)
      } catch (err) {
        setError(humanizeVaultError(err))
      } finally {
        if (phoneSecret) zeroBytes(phoneSecret)
        setPaymentBusy(false)
      }
    },
    [enrollment, refreshBalance, status],
  )

  const recoverMatureBoarding = useCallback(async () => {
    if (!status?.enrolled || !enrollment) throw new Error('Sign in before recovering received Bitcoin.')
    const txid = await recoverMatureBoardingInputs(enrollment, status)
    await refreshBalance(status.vaultId)
    return txid
  }, [enrollment, refreshBalance, status])

  const spendingRenewals = useSpendingRenewals(status, enrollment, locked)

  const value = useMemo<VaultContextProps>(
    () => ({
      watchedSavings,
      updateWatchedSavings,
      watchedSavingsTotalSats: status?.protectionTier === 'light' ? positions.savings.totalSats : undefined,
      account,
      spendingRenewals,
      spendingBitcoin,
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
      ledgerPayment: ledgerSavings.view,
      completeLedgerPayment,
      confirmConditions,
      dailyLimit,
      dailyRemaining,
      dailySpent: status?.enrolled ? (status.periodSpent ?? 0) : Math.max(0, dailyLimit - dailyRemaining),
      error,
      paymentError: paymentError?.message === error ? paymentError : undefined,
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
      openTx: (tx) => {
        const ledger = ledgerSavings.view
        if (
          tx.activity === 'savings-ledger' &&
          ledger &&
          tx.txid === ledger.record.candidateId &&
          !['broadcast', 'confirmed', 'conflicted'].includes(ledger.outcome)
        ) {
          const payment = ledger.record.payment
          setAccount('savings')
          setSpend({ address: payment.destAddress, amount: payment.amountSats, fee: payment.feeSats })
          setError('')
          setScreen(ledger.record.phonePsbt && !ledger.record.txHex ? 'ledger-sign' : 'review')
          return
        }
        setSelectedTx(tx)
        setTxReturn(screen)
        setError('')
        setScreen('tx')
      },
      liveNetwork,
      navigate: (next) => {
        setError('')
        if (next === 'home') {
          setScanOnSend(false)
          clearSpendDraft()
        }
        setScreen(next)
      },
      openRecover: (view = 'kit', exit = 'keys') => {
        setError('')
        setRecoverEntry(view)
        setRecoverExit(exit)
        setScreen('recover')
      },
      recoverEntry,
      recoverExit,
      recoverMatureBoarding,
      networkLabel,
      spendingArkAddress,
      refreshBalance,
      retryLightningRefund,
      reviewSpend,
      bitcoinOutputs,
      resumingPayment,
      pendingPayments,
      openPendingPayment,
      canReplaceInFlightSend,
      replaceInFlightSend,
      openSendScan: () => {
        clearSpendDraft(account)
        setScanOnSend(true)
        setError('')
        setScreen('send')
      },
      scanOnSend,
      clearSendScan: () => setScanOnSend(false),
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
      spendingBitcoin,
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
      completeLedgerPayment,
      dailyLimit,
      dailyRemaining,
      enrollment,
      error,
      paymentError,
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
      retryLightningRefund,
      reviewSpend,
      bitcoinOutputs,
      resumingPayment,
      pendingPayments,
      openPendingPayment,
      canReplaceInFlightSend,
      replaceInFlightSend,
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
    ],
  )

  const sessionValue = useMemo(
    () => sessionView(session.getSnapshot(), session),
    [session, setup, status, deployment, enrollment, locked],
  )
  return (
    <VaultSessionContext.Provider value={sessionValue}>
      <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
    </VaultSessionContext.Provider>
  )
}
