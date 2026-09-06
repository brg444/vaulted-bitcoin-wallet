import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NetworkName } from '@arkade-os/sdk'
import { DUST_SATS } from '../lib/vault/constants'
import { reconcileStagedEnrollment, type EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import {
  findStoredEnrollment,
  loadEnrollment,
  loadSelectedVaultId,
  loadSessionLocked,
  saveSelectedVaultId,
  setSessionLocked,
} from '../lib/vault/enrollmentStore'
import { loadAddressPin, type AddressPin } from '../lib/vault/pin'
import { zeroBytes } from '../lib/vault/ceremony/directauth'
import { broadcastTx, confirmedSpendables, fetchAddressUtxos } from '../lib/vault/esplora'
import { recentAccountHistory, type VaultHistoryItem } from '../lib/vault/history'
import {
  buildSavingsPsbt,
  finalizeSavingsPsbt,
  parseIncomingPsbt,
  requireSameSavingsIntent,
  signSavingsPsbt,
  unlockPhoneBip340,
} from '../lib/vault/savingsSpend'
import {
  clearPendingSavingsHandoff,
  createPendingSavingsHandoff,
  loadPendingSavingsHandoff,
  savePendingSavingsHandoff,
  type PendingSavingsHandoff,
} from '../lib/vault/savingsHandoff'
import { consoleError } from '../lib/logs'
import { requireSdkNetworkName } from '../lib/vault/networkPins'
import { humanizeVaultError } from '../lib/vault/humanize'
import { bitcoinDustSats, isVaultArkAddress, isVaultSpendAddress } from '../lib/vault/bitcoin'
import {
  discoverVaultLightningSolver,
  isVaultLightningInput,
  vaultLightningSendEnabled,
} from '../lib/vault/lightningConfig'
import { decodeVaultLightningInvoice } from '../lib/vault/lightningInvoice'
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
  vaultArkServer,
} from '../lib/vault/vtxo/spend'
import { deleteBoardingKey, requireBoardingStatus } from '../lib/vault/vtxo/board'
import { recoverMatureBoardingInputs } from '../lib/vault/vtxo/boardingRecovery'
import { ensureVaultWalletWorker, shutdownVaultWalletWorker } from '../lib/vault/vtxo/walletWorker'
import { fetchPublicStatus, fetchVaultStatus, type PublicAuthorizerStatus } from '../lib/vault/status'
import {
  clearSetupPlan,
  emptySetupPlan,
  loadSetupPlan,
  parseCompressedPub,
  planReady,
  saveSetupPlan,
  sameBip340Key,
  sameRole,
  type VaultSetupPlan,
} from '../lib/vault/setupPlan'
import {
  CURRENT_SPENDING_POLICY_CAPABILITIES,
  validateSpendingPolicy,
  type SpendingPolicy,
} from '../lib/vault/spendingPolicy'
import { requireProtectionTier, type ProtectionTier } from '../lib/vault/protectionTier'
import type { VaultFiatDisplayRate } from '../lib/vault/fiatDisplay'
import { getPriceFeed } from '../lib/fiat'
import { Fiats } from '../lib/types'
import { loadVaultPrivacyLock } from '../lib/vault/prefs'

import type { VaultStatus } from '../lib/vault/types'
import {
  DEFAULT_SPEND_FEE_SATS,
  VaultContext,
  type VaultAccount,
  type VaultContextProps,
  type VaultScreen,
  type VaultSpend,
} from '../vault/context'
import { useRecoveryKit } from '../vault/useRecoveryKit'
import { useVaultBalances } from '../vault/useVaultBalances'
import { useVaultSession } from '../vault/useVaultSession'

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

function storedEnrollment(): EnrollmentSecrets | null {
  const selected = loadSelectedVaultId()
  return selected ? loadEnrollment(localStorage, selected) : findStoredEnrollment()
}

function bootLocked(existing: EnrollmentSecrets | null = null): boolean {
  try {
    const enrollment = existing ?? storedEnrollment()
    return Boolean(enrollment && (loadSessionLocked() || loadVaultPrivacyLock()))
  } catch {
    return false
  }
}

function initialScreen(): VaultScreen {
  return bootLocked() ? 'unlock' : 'welcome'
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<VaultScreen>(initialScreen)
  const [recoverEntry, setRecoverEntry] = useState<'kit' | 'lost'>('kit')
  const [recoverExit, setRecoverExit] = useState<VaultScreen>('keys')
  const [setup, setSetup] = useState<VaultSetupPlan>(emptySetupPlan)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [deployment, setDeployment] = useState<PublicAuthorizerStatus | null>(null)
  const [enrollment, setEnrollment] = useState<EnrollmentSecrets | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [spend, setSpend] = useState<VaultSpend>({ address: '', amount: 0, fee: 0 })
  const spendRef = useRef(spend)
  spendRef.current = spend
  const [reviewedVtxoQuote, setReviewedVtxoQuote] = useState<VaultVtxoSpendQuote | null>(null)
  const [lightningQuote, setLightningQuote] = useState<VaultLightningQuote | null>(null)
  const [canReplaceInFlightSend, setCanReplaceInFlightSend] = useState(false)
  const replaceExistingVtxoRef = useRef(false)
  const [lastSend, setLastSend] = useState<VaultSpend | null>(null)
  const [lastTxid, setLastTxid] = useState('')
  const [lastTxKind, setLastTxKind] = useState<'onchain' | 'vtxo' | 'lightning' | ''>('')
  const [selectedTx, setSelectedTx] = useState<VaultHistoryItem | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [initialStatusChecked, setInitialStatusChecked] = useState(false)
  const [account, setAccount] = useState<VaultAccount>('spend')
  const [scanOnSend, setScanOnSend] = useState(false)
  const [handoffPsbt, setHandoffPsbt] = useState('')
  const [pendingSavingsHandoff, setPendingSavingsHandoff] = useState<PendingSavingsHandoff | null>(null)
  const [locked, setLocked] = useState(bootLocked)
  const [addressPin, setAddressPin] = useState<AddressPin | null>(null)
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

  useEffect(() => {
    let existing: EnrollmentSecrets | null = null
    let existingPin: AddressPin | null = null
    try {
      const plan = loadSetupPlan()
      if (plan) {
        setSetup(plan)
        if (plan.complete) {
          setScreen('passkey')
        }
      }
      const selected = loadSelectedVaultId()
      existing = selected ? loadEnrollment(localStorage, selected) : findStoredEnrollment()
      if (existing?.vaultId) saveSelectedVaultId(existing.vaultId)
      const pinId = existing?.vaultId || selected
      existingPin = pinId ? loadAddressPin(localStorage, pinId) : null
      setAddressPin(existingPin)
      const sessionLocked = bootLocked(existing)
      setLocked(sessionLocked)
      if (existing) setEnrollment(existing)
      if (existing && sessionLocked) {
        setScreen('unlock')
      } else if (existing && existingPin) {
        setScreen('home')
      } else if (existing) {
        setSessionLocked(true)
        setLocked(true)
        setScreen('signin')
      }
    } catch {
      clearSetupPlan()
    } finally {
      setLoaded(true)
    }
    const selectedId = existing?.vaultId || loadSelectedVaultId()
    const boot = async () => {
      try {
        const recovered = await reconcileStagedEnrollment()
        if (recovered && !loadSessionLocked()) {
          setEnrollment(recovered.enrollment)
          setStatus(recovered.status)
          setAddressPin(loadAddressPin(localStorage, recovered.status.vaultId))
          setScreen('home')
          return
        }
        if (selectedId) {
          const live = await fetchVaultStatus(undefined, selectedId)
          setStatus(live)
          setAddressPin(loadAddressPin(localStorage, live.vaultId))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('local pin') || msg.includes('not pinned locally')) {
          setError(humanizeVaultError(err))
        }
      } finally {
        setInitialStatusChecked(true)
      }
    }
    void boot()
  }, [])

  useEffect(() => {
    if (!['welcome', 'design', 'passkey', 'problem'].includes(screen)) return
    const controller = new AbortController()
    const refresh = () => {
      void fetchPublicStatus(controller.signal)
        .then(setDeployment)
        .catch(() => {
          if (!controller.signal.aborted) setDeployment(null)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    const interval = window.setInterval(refresh, 30_000)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }, [screen])

  useEffect(() => {
    const persistLock = () => {
      if (!loadVaultPrivacyLock()) return
      if (!(enrollment || storedEnrollment())) return
      setSessionLocked(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persistLock()
    }
    window.addEventListener('pagehide', persistLock)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', persistLock)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enrollment])

  useEffect(() => {
    const vaultId = status?.vaultId || enrollment?.vaultId || ''
    if (!vaultId) return
    const pending = loadPendingSavingsHandoff(localStorage, vaultId)
    setPendingSavingsHandoff(pending)
    if (pending) setHandoffPsbt(pending.psbtHex)
  }, [enrollment?.vaultId, status?.vaultId])

  useEffect(() => {
    if (!pendingSavingsHandoff) return
    const delay = Math.max(0, pendingSavingsHandoff.expiresAt - Date.now())
    const timeout = window.setTimeout(() => {
      try {
        clearPendingSavingsHandoff(localStorage, pendingSavingsHandoff.vaultId)
      } catch {
        // Expiry still clears the active session when browser storage is unavailable.
      }
      setPendingSavingsHandoff(null)
      setHandoffPsbt('')
      setScreen((current) => (current === 'handoff' ? 'home' : current))
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [pendingSavingsHandoff])

  useEffect(() => {
    if (!status || status.protectionTier === 'light') return
    const protectionTier = status.protectionTier
    if (status.network === 'mutinynet' && account === 'savings') {
      setSpend((prev) => (prev.fee === LIVE_FEE ? prev : { ...prev, fee: LIVE_FEE }))
    }
    setSetup((prev) => {
      const next = {
        ...prev,
        protectionTier,
        recoveryPub: status.recoveryPub || status.recoveryKeyPub || '',
        txCapSats: status.txCap || prev.txCapSats,
        dailyLimitSats: status.periodAllowance || prev.dailyLimitSats,
        absoluteFeeCapSats: status.absoluteFeeCap ?? prev.absoluteFeeCapSats,
        feerateCapSatPerV: status.feerateCapSatVb || prev.feerateCapSatPerV,
      }
      if (
        next.protectionTier === prev.protectionTier &&
        next.recoveryPub === prev.recoveryPub &&
        next.txCapSats === prev.txCapSats &&
        next.dailyLimitSats === prev.dailyLimitSats &&
        next.absoluteFeeCapSats === prev.absoluteFeeCapSats &&
        next.feerateCapSatPerV === prev.feerateCapSatPerV
      ) {
        return prev
      }
      saveSetupPlan(next)
      return next
    })
  }, [account, status])

  const persist = useCallback((next: VaultSetupPlan) => {
    setSetup(next)
    saveSetupPlan(next)
    return next
  }, [])

  const spendingArkAddress = status?.spendingArkAddress || ''
  const boardingAddress = status?.vtxoBoardingAddress || ''
  const savingsAddress = addressPin?.savingsAddress || ''
  const activeNetwork = status?.network || deployment?.network
  const liveNetwork = activeNetwork === 'mutinynet'
  const selectAccount = useCallback(
    (next: VaultAccount) => {
      setAccount(next)
      setReviewedVtxoQuote(null)
      setLightningQuote(null)
      setSpend((previous) => ({ ...previous, fee: vaultDraftFee(next, liveNetwork) }))
    },
    [liveNetwork],
  )
  const reportError = useCallback((message: string) => setError(message), [])
  const { balanceError, balancesLoaded, history, positions, refreshBalance, refreshingBalance } = useVaultBalances({
    addressPin,
    enrollment,
    initialStatusChecked,
    locked,
    setStatus,
    status,
  })
  const spendingAvailableSats = positions.spending.availableSats
  const savingsAvailableSats = positions.savings.availableSats
  const dailyLimit = status?.enrolled ? (status.periodAllowance ?? setup.dailyLimitSats) : setup.dailyLimitSats
  const dailyRemaining = status?.enrolled ? (status.periodRemaining ?? dailyLimit) : 0
  const enrolled = Boolean(status?.enrolled)
  const networkLabel = activeNetwork === 'mainnet' ? 'Bitcoin' : liveNetwork ? 'Mutinynet' : 'Unavailable'
  const clearError = useCallback(() => reportError(''), [reportError])

  useEffect(() => {
    setSelectedTx((current) => {
      if (!current) return current
      return history.find((item) => item.account === current.account && item.txid === current.txid) || current
    })
  }, [history])
  const visibleHistory = useMemo<VaultHistoryItem[]>(
    () =>
      pendingSavingsHandoff
        ? [
            {
              txid: `pending-savings:${pendingSavingsHandoff.createdAt}`,
              type: 'sent',
              amount: pendingSavingsHandoff.amountSats + pendingSavingsHandoff.feeSats,
              confirmed: false,
              blockTime: Math.floor(pendingSavingsHandoff.createdAt / 1000),
              account: 'savings',
              activity: 'savings-handoff',
            },
            ...history,
          ]
        : history,
    [history, pendingSavingsHandoff],
  )
  const {
    backupRecoveryKit,
    downloadRecoveryKit,
    hasRecoveryKit,
    initiateAlert,
    initiateAlerts,
    restoreRecoveryKit,
    signGuardianExitWithDevice,
  } = useRecoveryKit({
    enrollment,
    status,
    hardwarePub: setup.hardwarePub,
    recoveryPub: setup.recoveryPub,
    clearError,
  })

  const acceptDesign = useCallback(
    (tier?: 'standard' | 'advanced') => {
      const protectionTier = tier || setup.protectionTier
      persist({
        ...setup,
        acceptedDesign: true,
        protectionTier,
        ...(protectionTier === 'standard' ? { recoveryPub: '' } : {}),
      })
      setError('')
      setScreen('hardware')
    },
    [persist, setup],
  )

  const applyHardware = useCallback(
    (raw: string) => {
      setError('')
      try {
        const hardwarePub = parseCompressedPub(raw, 'hardware key')
        if (status?.externalOwnerWalletPub && !sameBip340Key(hardwarePub, status.externalOwnerWalletPub)) {
          throw new Error('This Mutinynet vault requires the hardware key already configured on the service')
        }
        persist({ ...setup, hardwarePub })
        setScreen('recovery')
      } catch (err) {
        setError(humanizeVaultError(err))
      }
    },
    [persist, setup, status?.externalOwnerWalletPub],
  )

  const applyRecovery = useCallback(
    (raw: string) => {
      setError('')
      try {
        const recoveryPub = parseCompressedPub(raw, 'recovery key')
        if (!setup.hardwarePub) throw new Error('Set hardware first')
        if (sameRole(recoveryPub, setup.hardwarePub)) throw new Error('Recovery must be a different key')
        persist({ ...setup, protectionTier: 'advanced', recoveryPub })
        setScreen('conditions')
      } catch (err) {
        setError(humanizeVaultError(err))
      }
    },
    [persist, setup],
  )

  const skipRecovery = useCallback(() => {
    setError('')
    persist({ ...setup, protectionTier: 'standard', recoveryPub: '' })
    setScreen('conditions')
  }, [persist, setup])

  const setProtectionTier = useCallback(
    (tier: ProtectionTier) => {
      setError('')
      const selected = requireProtectionTier(tier)
      persist({ ...setup, protectionTier: selected, ...(selected === 'standard' ? { recoveryPub: '' } : {}) })
    },
    [persist, setup],
  )

  const confirmConditions = useCallback(() => {
    setError('')
    setScreen('plan')
  }, [])

  const setSpendingPolicy = useCallback(
    (selected: SpendingPolicy) => {
      setError('')
      try {
        const policy = validateSpendingPolicy(selected)
        persist({
          ...setup,
          txCapSats: policy.txRecipientCapSats,
          dailyLimitSats: policy.periodAllowanceSats,
          absoluteFeeCapSats: policy.absoluteFeeCapSats,
          feerateCapSatPerV: policy.feerateCapSatPerV,
        })
      } catch (err) {
        setError(humanizeVaultError(err))
      }
    },
    [persist, setup],
  )

  const finishPlan = useCallback(() => {
    setError('')
    if (!planReady(setup)) {
      setError('Finish setup first.')
      return
    }
    setScreen('passkey')
  }, [setup])

  const sealPlan = useCallback(() => {
    const next = persist({ ...setup, complete: true })
    return next
  }, [persist, setup])

  const { enableOtherDevices, enroll, signIn } = useVaultSession({
    enrollment,
    reportError,
    sealPlan,
    setAddressPin,
    setBusy,
    setEnrollment,
    setLocked,
    setScreen,
    setStatus,
    setup,
    status,
  })

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
      setBusy(true)
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
        setBusy(false)
      }
    },
    [status],
  )

  const reviewLightningSpend = useCallback(async () => {
    if (!status?.enrolled || !enrollment) {
      setError('Sign in with the passkey that created this vault.')
      return
    }
    if (account !== 'spend') {
      setError('Lightning payments use Spending.')
      return
    }
    if (!vaultLightningSendEnabled(status.network as NetworkName)) {
      setError('Lightning send is not enabled in this release.')
      return
    }
    const profile = await discoverVaultLightningSolver(status.network as NetworkName)
    if (!profile) {
      setError('No Lightning solver is configured for this network.')
      return
    }

    let invoice
    try {
      invoice = decodeVaultLightningInvoice(spend.address, profile.network)
    } catch (err) {
      setError(humanizeVaultError(err))
      return
    }
    const active = listPersistedVtxoSpends(status.vaultId).find(vtxoSpendIsLivePending)
    if (active) {
      setError('A payment is still pending. Open Pending payment to resume it before starting another.')
      return
    }
    if (invoice.amountSats > setup.txCapSats) {
      setError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats. Use Savings.`)
      return
    }
    if (invoice.amountSats > spendingAvailableSats) {
      setError('Not enough confirmed spending funds.')
      return
    }

    setBusy(true)
    try {
      const lightning = await import('../lib/vault/lightning')
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
      const phoneSecret = await unlockPhoneBip340(enrollment, status)
      let quote: VaultLightningQuote
      let funding: VaultVtxoSpendQuote
      try {
        quote = await lightning.withVaultLightningSdkWallet(phoneSecret, status, (session) =>
          lightning.withVaultLightningTransport(profile, (transport) =>
            lightning.requestVaultLightningQuote({
              wallet: session.wallet,
              arkServerUrl: vaultArkServer(profile.network),
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
          throw new Error(`This payment exceeds the ${setup.txCapSats.toLocaleString()} sat send limit after fees.`)
        }
        // The SDK session has released its lock; reuse this approval for the reservation.
        funding = await reserveVaultVtxo(enrollment, status, quote.fundAddress, quote.fundAmountSats, { phoneSecret })
      } finally {
        zeroBytes(phoneSecret)
      }
      if (quote.fundAmountSats + funding.feeSats > spendingAvailableSats) {
        throw new Error('Not enough confirmed spending funds after fees.')
      }
      if (spendRef.current.address.trim().replace(/^lightning:/i, '') !== invoice.raw) {
        throw new Error('Send details changed. Review the send again.')
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
      setLightningQuote(null)
      setReviewedVtxoQuote(null)
      setError(humanizeVaultError(err))
    } finally {
      setBusy(false)
    }
  }, [account, enrollment, setup.txCapSats, spend.address, spendingAvailableSats, status])

  const reviewSpend = useCallback(async () => {
    setError('')
    setReviewedVtxoQuote(null)
    if (!status?.enrolled) {
      setError('Unlock this vault before sending.')
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
    if (!arkDestination && account === 'spend' && status?.enrolled) {
      setError('Spending currently sends VTXOs to Arkade addresses. Bitcoin withdrawal is not in this rollout yet.')
      return
    }
    const minimumAmount = account === 'savings' ? bitcoinDustSats(spend.address, destNetwork) : DUST_SATS
    if (!Number.isInteger(spend.amount) || spend.amount < minimumAmount) {
      setError(`At least ₿${minimumAmount}.`)
      return
    }
    const source = account === 'savings' ? savingsAvailableSats : spendingAvailableSats
    const persistedVtxo = account === 'spend' ? loadPersistedVtxoSpend(status.vaultId) : undefined
    const resumingVtxo = Boolean(persistedVtxo && isSameVtxoPayment(persistedVtxo, spend.address, spend.amount))
    if (account === 'spend' && !resumingVtxo && listPersistedVtxoSpends(status.vaultId).some(vtxoSpendIsLivePending)) {
      setError('A payment is still pending. Open Pending payment to resume it before starting another.')
      return
    }
    if (account !== 'savings' && !resumingVtxo) {
      if (spend.amount > setup.txCapSats) {
        setError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats. Use Savings.`)
        return
      }
    }
    const preliminaryTotal = account === 'savings' ? spend.amount + spend.fee : spend.amount
    if (preliminaryTotal > source && !resumingVtxo) {
      setError(account === 'savings' ? 'Not enough confirmed savings.' : 'Not enough confirmed spending funds.')
      return
    }
    if (account === 'savings' && spend.amount + spend.fee < source && source - (spend.amount + spend.fee) < DUST_SATS) {
      setError('Leave ₿330 of change, or send the rest.')
      return
    }
    if (account !== 'savings') {
      if (!enrollment) {
        setError('Sign in with the passkey that created this vault.')
        return
      }
      setBusy(true)
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
        setBusy(false)
      }
    }
    setScreen('review')
  }, [
    account,
    enrollment,
    reviewLightningSpend,
    savingsAvailableSats,
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
    if (!status?.enrolled || !enrollment || !savingsAddress) {
      throw new Error('Sign in with the passkey that created this vault.')
    }
    if (pendingSavingsHandoff) {
      throw new Error('Complete or cancel the Savings transfer waiting for hardware first.')
    }
    const need = spend.amount + spend.fee
    const utxos = await fetchAddressUtxos(savingsAddress)
    const coins = confirmedSpendables(utxos, need)
    if (coins.length === 0) throw new Error('Confirmed Savings funds do not cover this transfer.')
    const leaf = 'admin' as const
    if (spend.address === status.vtxoBoardingAddress) {
      requireBoardingStatus(status, String(status.vtxoBoardingDescriptor?.boardingPub || ''))
    }
    const unsigned = buildSavingsPsbt({
      status,
      phonePub: enrollment.phoneBip340Pub,
      destAddress: spend.address,
      amountSats: spend.amount,
      feeSats: spend.fee,
      coins: coins.map((coin) => ({
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        confirmedHeight: coin.status.block_height,
      })),
      leaf,
    })
    const secret = await unlockPhoneBip340(enrollment, status)
    try {
      const signed = signSavingsPsbt(unsigned, secret)
      const pending = createPendingSavingsHandoff({
        vaultId: status.vaultId,
        psbtHex: signed,
        destAddress: spend.address,
        amountSats: spend.amount,
        feeSats: spend.fee,
        network: status.network,
      })
      try {
        savePendingSavingsHandoff(localStorage, pending)
      } catch {
        throw new Error('This browser cannot save the pending Savings transfer. Use the installed wallet.')
      }
      setPendingSavingsHandoff(pending)
      setHandoffPsbt(signed)
      setScreen('handoff')
    } finally {
      zeroBytes(secret)
    }
  }, [enrollment, pendingSavingsHandoff, savingsAddress, spend, status])

  const discardPendingSavingsHandoff = useCallback(() => {
    const vaultId = pendingSavingsHandoff?.vaultId || status?.vaultId || ''
    if (vaultId) {
      try {
        clearPendingSavingsHandoff(localStorage, vaultId)
      } catch {
        // The active session can still discard its copy when storage is unavailable.
      }
    }
    setPendingSavingsHandoff(null)
    setHandoffPsbt('')
  }, [pendingSavingsHandoff?.vaultId, status?.vaultId])

  const cancelSavingsHandoff = useCallback(() => {
    discardPendingSavingsHandoff()
    setSpend({ address: '', amount: 0, fee: vaultDraftFee('savings', liveNetwork) })
    setError('')
    setAccount('savings')
    setScreen('home')
  }, [discardPendingSavingsHandoff, liveNetwork])

  const completeSavingsHandoff = useCallback(
    async (signedPsbt: string) => {
      setBusy(true)
      setError('')
      try {
        if (!pendingSavingsHandoff) throw new Error('the pending Savings transfer is missing')
        if (!handoffPsbt || handoffPsbt !== pendingSavingsHandoff.psbtHex) {
          throw new Error('the pending Savings transfer changed locally')
        }
        const incoming = parseIncomingPsbt(signedPsbt)
        requireSameSavingsIntent(
          pendingSavingsHandoff.psbtHex,
          incoming,
          pendingSavingsHandoff.destAddress,
          pendingSavingsHandoff.amountSats,
          pendingSavingsHandoff.network,
          enrollment?.phoneBip340Pub || '',
          status?.externalOwnerWalletPub || '',
        )
        const final = finalizeSavingsPsbt(incoming)
        const txid = await broadcastTx(final.txHex)
        discardPendingSavingsHandoff()
        await finishBroadcast(txid)
      } catch (err) {
        setError(humanizeVaultError(err))
      } finally {
        setBusy(false)
      }
    },
    [
      discardPendingSavingsHandoff,
      enrollment?.phoneBip340Pub,
      finishBroadcast,
      handoffPsbt,
      pendingSavingsHandoff,
      status?.externalOwnerWalletPub,
    ],
  )

  const approveSend = useCallback(async () => {
    setBusy(true)
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
      setBusy(false)
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

  const reset = useCallback(() => {
    if (status?.vaultId) {
      void shutdownVaultWalletWorker(status.vaultId)
        .then(() => deleteBoardingKey(status.vaultId))
        .catch(() => undefined)
    }
    setSessionLocked(true)
    setLocked(true)
    setError('')
    setSpend({ address: '', amount: 0, fee: 0 })
    setReviewedVtxoQuote(null)
    setLightningQuote(null)
    setLastSend(null)
    setLastTxid('')
    setLastTxKind('')
    setAccount('spend')
    setScanOnSend(false)
    setHandoffPsbt('')
    setScreen('welcome')
  }, [status])

  const retryLightningRefund = useCallback(
    async (rfqId: string) => {
      setBusy(true)
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
        setBusy(false)
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

  const value = useMemo<VaultContextProps>(
    () => ({
      acceptDesign,
      account,
      applyHardware,
      applyRecovery,
      setProtectionTier,
      skipRecovery,
      downloadRecoveryKit,
      backupRecoveryKit,
      balanceError,
      balancesLoaded,
      boardingAddress,
      restoreRecoveryKit,
      signGuardianExitWithDevice,
      hasRecoveryKit,
      initiateAlert,
      initiateAlerts,
      approveSend,
      busy,
      canSend: spendingAvailableSats >= DUST_SATS,
      cancelSavingsHandoff,
      completeSavingsHandoff,
      handoffPsbt,
      confirmConditions,
      setSpendingPolicy,
      spendingPolicyCapabilities: deployment?.spendingPolicyCapabilities || CURRENT_SPENDING_POLICY_CAPABILITIES,
      dailyLimit,
      dailyRemaining,
      dailySpent: status?.enrolled ? (status.periodSpent ?? 0) : Math.max(0, dailyLimit - dailyRemaining),
      enablePasskeyLogin: enableOtherDevices,
      lightAvailable: Boolean(deployment?.supportedSetups?.includes('light')),
      enrollmentMode: deployment?.enrollmentMode || 'loading',
      enroll,
      enrolled,
      error,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      finishPlan,
      hasLocalEnrollment: Boolean(enrollment),
      locked,
      lastTxid,
      lastTxKind,
      history: recentAccountHistory(visibleHistory, account),
      selectedTx,
      openTx: (tx) => {
        if (tx.activity === 'savings-handoff' && pendingSavingsHandoff) {
          setAccount('savings')
          setSpend({
            address: pendingSavingsHandoff.destAddress,
            amount: pendingSavingsHandoff.amountSats,
            fee: pendingSavingsHandoff.feeSats,
          })
          setHandoffPsbt(pendingSavingsHandoff.psbtHex)
          setError('')
          setScreen('handoff')
          return
        }
        setSelectedTx(tx)
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
      refreshingBalance,
      reset,
      reviewSpend,
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
      setup,
      signIn,
      spend,
      status,
      lastSend,
    }),
    [
      acceptDesign,
      account,
      applyHardware,
      applyRecovery,
      setProtectionTier,
      skipRecovery,
      downloadRecoveryKit,
      backupRecoveryKit,
      balanceError,
      balancesLoaded,
      boardingAddress,
      restoreRecoveryKit,
      signGuardianExitWithDevice,
      hasRecoveryKit,
      initiateAlert,
      initiateAlerts,
      approveSend,
      busy,
      cancelSavingsHandoff,
      completeSavingsHandoff,
      confirmConditions,
      setSpendingPolicy,
      deployment?.spendingPolicyCapabilities,
      deployment?.enrollmentMode,
      deployment?.supportedSetups,
      handoffPsbt,
      dailyLimit,
      dailyRemaining,
      enableOtherDevices,
      enrollment,
      enroll,
      signIn,
      enrolled,
      error,
      fiatDisplayRate,
      fiatDisplayEnabled,
      setFiatDisplay,
      finishPlan,
      lastTxid,
      lastTxKind,
      visibleHistory,
      pendingSavingsHandoff,
      selectedTx,
      liveNetwork,
      locked,
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
      refreshingBalance,
      reset,
      reviewSpend,
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
      setup,
      spend,
      spendingAvailableSats,
      status?.enrolled,
      status?.periodSpent,
    ],
  )

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}
