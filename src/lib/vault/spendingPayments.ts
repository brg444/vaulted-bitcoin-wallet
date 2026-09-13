import type { NetworkName } from '@arkade-os/sdk'
import { vaultAccountRuntime, vaultWalletRuntimeKey } from './accountRuntime'
import type { VaultSession } from './session'
import { isVaultArkAddress } from './bitcoin'
import { DUST_SATS } from './constants'
import { zeroBytes } from './ceremony/directauth'
import { unlockPhoneBip340 } from './savingsSpend'
import { humanizeVaultError } from './humanize'
import { consoleError } from '../logs'
import { requireSdkNetworkName, vaultOperatorOrigin } from './networkPins'
import {
  discoverVaultLightningSolver,
  isVaultLightningInput,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
} from './lightningConfig'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import type { VaultLightningQuote } from './lightningLifecycle'
import { ensureVaultWalletWorker } from './vtxo/walletWorker'
import {
  SPENDING_PAYMENT_EVENT,
  createVtxoSpendUnlocker,
  isSameVtxoPayment,
  isVtxoAbortFailedError,
  isVtxoLivePendingError,
  isVtxoReceiptPendingError,
  isVtxoReservedReplaceError,
  isVtxoReviewedReservationError,
  isVtxoSameSendInProgressError,
  isVtxoSpendInFlightError,
  listPersistedVtxoSpends,
  loadPersistedVtxoSpend,
  loadPersistedVtxoSpendById,
  newVtxoSpendChallenge,
  previewVaultVtxoSend,
  quoteFromPersistedVtxoSpend,
  reserveVaultVtxo,
  sendVaultVtxo,
  vtxoSpendIsAbortable,
  vtxoSpendIsLivePending,
  type VaultVtxoSpendQuote,
} from './vtxo/spend'

export interface SpendingPaymentDraft {
  address: string
  amount: number
  fee: number
}
export interface SpendingPaymentReview {
  payment: SpendingPaymentDraft
  funding: VaultVtxoSpendQuote
  lightning: VaultLightningQuote | null
  resuming: boolean
}
interface OpenedSpendingPayment {
  payment: SpendingPaymentDraft
  review: SpendingPaymentReview | null
}
interface SpendingPaymentsSnapshot {
  review: SpendingPaymentReview | null
  opened: OpenedSpendingPayment | null
  pendingPayments: {
    operationId: string
    amountSats: number
    destination: string
    authorized: boolean
    reservedSats?: number
  }[]
  pending: 'review' | 'open' | 'approve' | 'refund' | null
  canReplace: boolean
  error: string
  event: {
    id: number
    outcome: 'sent' | 'fee-changed' | 'review-required'
    kind: 'vtxo' | 'lightning'
    payment: SpendingPaymentDraft
    txid?: string
  } | null
}
type SessionSource = Pick<VaultSession, 'getSnapshot' | 'subscribe'>
const owners = new WeakMap<SessionSource, SpendingPayments>()
class ReviewError extends Error {}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function samePayment(left: SpendingPaymentDraft, right: SpendingPaymentDraft) {
  return left.address.trim() === right.address.trim() && left.amount === right.amount && left.fee === right.fee
}
const fundingProof = (quote: VaultVtxoSpendQuote) => ({
  operationId: quote.operationId,
  bundleDigest: quote.bundleDigest,
  address: quote.destAddress,
  amountSats: quote.amountSats,
  fundingFeeSats: quote.feeSats,
})

export function spendingPaymentsForSession(session: SessionSource) {
  let owner = owners.get(session)
  if (!owner) {
    owner = createSpendingPayments(session)
    owners.set(session, owner)
  }
  return owner
}
function createSpendingPayments(session: SessionSource) {
  let snapshot: SpendingPaymentsSnapshot = freeze({
    review: null,
    opened: null,
    pendingPayments: [],
    pending: null,
    canReplace: false,
    error: '',
    event: null,
  })
  let consumers = 0
  let identity = ''
  let generation = 0
  let eventId = 0
  let replacementIds: string[] | undefined
  let offeredReplacementIds: string[] | undefined
  let unsubscribe: (() => void) | undefined
  let flight: { key: string; abort: AbortController; promise: Promise<unknown> } | undefined
  const listeners = new Set<() => void>()
  const publish = (change: Partial<SpendingPaymentsSnapshot>) => {
    if (
      Object.entries(change).every(([key, value]) => Object.is(snapshot[key as keyof SpendingPaymentsSnapshot], value))
    )
      return
    snapshot = freeze({ ...snapshot, ...change })
    for (const listener of listeners) listener()
  }
  const sessionIdentity = () => {
    const { status, enrollment, locked } = session.getSnapshot()
    return !locked && status?.enrolled && enrollment?.vaultId === status.vaultId
      ? JSON.stringify([vaultWalletRuntimeKey(status), enrollment])
      : ''
  }
  const access = () => {
    const { status, enrollment, setup } = session.getSnapshot()
    if (!consumers || !identity || identity !== sessionIdentity() || !status?.enrolled || !enrollment)
      throw new ReviewError('Sign in with the passkey that created this vault.')
    return structuredClone({ status, enrollment, setup })
  }
  const load = () => {
    if (!consumers || !identity || identity !== sessionIdentity()) return
    const { status } = access()
    const pendingPayments = listPersistedVtxoSpends(status.vaultId).map((operation) => ({
      operationId: operation.operationId,
      amountSats: operation.amountSats,
      destination: operation.destAddress,
      authorized: vtxoSpendIsLivePending(operation),
      reservedSats: operation.reservedInputs?.reduce((total, input) => total + input.valueSats, 0),
    }))
    if (JSON.stringify(pendingPayments) !== JSON.stringify(snapshot.pendingPayments)) publish({ pendingPayments })
  }
  const cancel = () => {
    generation++
    flight?.abort.abort(new DOMException('Spending payment session ended', 'AbortError'))
    replacementIds = undefined
    offeredReplacementIds = undefined
    publish({ review: null, opened: null, canReplace: false })
  }
  const bind = () => {
    const next = sessionIdentity()
    if (next !== identity) {
      cancel()
      identity = next
      publish({ pendingPayments: [], error: '', event: null })
    }
    if (consumers && identity) {
      vaultAccountRuntime(session.getSnapshot().status!).spendingPayments = owner
      load()
    }
  }
  const available = () => {
    const { status } = access()
    return vaultAccountRuntime(status).balances?.getSnapshot().positions.spending.availableSats ?? 0
  }
  const event = (
    outcome: NonNullable<SpendingPaymentsSnapshot['event']>['outcome'],
    review: SpendingPaymentReview,
    txid?: string,
    fee = review.payment.fee,
  ) => {
    publish({
      event: {
        id: ++eventId,
        outcome,
        kind: review.lightning ? 'lightning' : 'vtxo',
        payment: { ...review.payment, fee },
        ...(txid ? { txid } : {}),
      },
    })
  }
  const run = <T>(
    kind: NonNullable<SpendingPaymentsSnapshot['pending']>,
    key: string,
    work: (check: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (flight) {
      if (!flight.abort.signal.aborted && flight.key === key) return flight.promise as Promise<T>
      return Promise.reject(new ReviewError('Finish the current payment action before continuing.'))
    }
    const epoch = generation
    const abort = new AbortController()
    const current = { key, abort, promise: Promise.resolve() as Promise<unknown> }
    flight = current
    const check = () => {
      abort.signal.throwIfAborted()
      if (epoch !== generation || identity !== sessionIdentity())
        throw new DOMException('Payment session ended', 'AbortError')
    }
    publish({ pending: kind, error: '', event: null, opened: null })
    current.promise = (async () => {
      check()
      return work(check, abort.signal)
    })()
      .catch((error) => {
        if (epoch === generation && !abort.signal.aborted) {
          if (isVtxoReservedReplaceError(error)) {
            offeredReplacementIds = listPersistedVtxoSpends(access().status.vaultId)
              .filter(vtxoSpendIsAbortable)
              .map((record) => record.operationId)
            publish({ canReplace: true })
          }
          publish({ error: error instanceof ReviewError ? error.message : humanizeVaultError(error) })
        }
        throw error
      })
      .finally(() => {
        if (flight === current) {
          flight = undefined
          publish({ pending: null })
          load()
        }
      })
    return current.promise as Promise<T>
  }
  const owner = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    clearError: () => publish({ error: '' }),
    consumeEvent(id: number) {
      const current = snapshot.event
      if (current?.id !== id) return null
      publish({ event: null })
      return current
    },
    retain() {
      consumers++
      if (consumers === 1) {
        unsubscribe = session.subscribe(bind)
        window.addEventListener(SPENDING_PAYMENT_EVENT, load)
        window.addEventListener('storage', load)
        bind()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--consumers) return
        unsubscribe?.()
        unsubscribe = undefined
        window.removeEventListener(SPENDING_PAYMENT_EVENT, load)
        window.removeEventListener('storage', load)
        void owner.suspend()
      }
    },
    async suspend() {
      cancel()
      identity = ''
      publish({ pendingPayments: [], error: '', event: null })
      await flight?.promise.catch(() => undefined)
    },
    cancelReview() {
      if (snapshot.pending === 'approve' || snapshot.pending === 'refund') return
      cancel()
    },
    review(draft: SpendingPaymentDraft, replace = false): Promise<SpendingPaymentReview> {
      const payment = { ...draft, address: draft.address.trim() }
      return run('review', JSON.stringify(['review', payment, replace]), async (check, signal) => {
        const { status, enrollment, setup } = access()
        const operations = listPersistedVtxoSpends(status.vaultId)
        const pending = loadPersistedVtxoSpend(status.vaultId)
        let funding: VaultVtxoSpendQuote
        let lightning: VaultLightningQuote | null = null
        if (isVaultLightningInput(payment.address)) {
          let phase = 'validation'
          try {
            if (!vaultLightningSendEnabled(status.network as NetworkName))
              throw new ReviewError('Lightning send is not enabled in this release.')
            const pinned = vaultLightningSolverProfile(status.network)
            if (!pinned) throw new ReviewError('No Lightning solver is configured for this network.')
            const invoice = decodeVaultLightningInvoice(payment.address, pinned.network)
            if (operations.some(vtxoSpendIsLivePending))
              throw new ReviewError(
                'A payment is still pending. Open Pending payment to resume it before starting another.',
              )
            if (invoice.amountSats > setup.txCapSats)
              throw new ReviewError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats.`)
            if (invoice.amountSats > available()) throw new ReviewError('Not enough confirmed spending funds.')
            const resumeVtxo =
              pending?.bundleDigest && pending.destAddress && Number.isSafeInteger(pending.amountSats)
                ? {
                    operationId: pending.operationId,
                    bundleDigest: pending.bundleDigest,
                    address: pending.destAddress,
                    amountSats: pending.amountSats,
                    fundingFeeSats: pending.feeSats,
                  }
                : undefined
            // Start WebAuthn in the click gesture, before solver discovery or dynamic imports.
            phase = 'passkey approval'
            const phoneSecret = await unlockPhoneBip340(enrollment, status, signal)
            try {
              check()
              phase = 'solver verification'
              const profile = await discoverVaultLightningSolver(status.network)
              check()
              if (!profile) throw new ReviewError('No verified Lightning solver is configured for this network.')
              const api = await import('./lightning')
              check()
              phase = 'quote'
              lightning = await api.withVaultLightningSdkWallet(
                phoneSecret,
                status,
                (session) => {
                  check()
                  return api.withVaultLightningTransport(profile, (transport) => {
                    check()
                    return api.requestVaultLightningQuote({
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
                    })
                  })
                },
                { signal },
              )
              check()
              if (lightning.fundAmountSats > setup.txCapSats)
                throw new ReviewError(
                  `This payment exceeds the ${setup.txCapSats.toLocaleString()} sat send limit after fees.`,
                )
              phase = 'reservation'
              funding = await reserveVaultVtxo(enrollment, status, lightning.fundAddress, lightning.fundAmountSats, {
                phoneSecret,
                signal,
              })
              check()
            } finally {
              zeroBytes(phoneSecret)
            }
            if (lightning.fundAmountSats + funding.feeSats > available())
              throw new ReviewError('Not enough confirmed spending funds after fees.')
            payment.amount = lightning.invoiceAmountSats
            payment.fee = lightning.corridorFeeSats + funding.feeSats
          } catch (error) {
            if (!signal.aborted) consoleError(error, `Lightning payment ${phase}`)
            throw error
          }
        } else {
          if (!isVaultArkAddress(payment.address, status.network)) throw new ReviewError('Enter an Arkade address.')
          if (!Number.isSafeInteger(payment.amount) || payment.amount < DUST_SATS)
            throw new ReviewError(`At least ₿${DUST_SATS}.`)
          const resuming = !!pending && isSameVtxoPayment(pending, payment.address, payment.amount)
          if (!resuming && operations.some(vtxoSpendIsLivePending))
            throw new ReviewError(
              'A payment is still pending. Open Pending payment to resume it before starting another.',
            )
          if (!resuming && payment.amount > setup.txCapSats)
            throw new ReviewError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats.`)
          if (!resuming && payment.amount > available()) throw new ReviewError('Not enough confirmed spending funds.')
          if (replace && !offeredReplacementIds?.length)
            throw new ReviewError('The pending payment changed. Review the send again.')
          replacementIds = replace ? [...offeredReplacementIds!] : undefined
          funding = await previewVaultVtxoSend(status, payment.address, payment.amount, { replaceExisting: replace })
          check()
          payment.fee = funding.feeSats
        }
        const saved = loadPersistedVtxoSpendById(status.vaultId, funding.operationId)
        const review = freeze({
          payment,
          funding: structuredClone(funding),
          lightning: structuredClone(lightning),
          resuming: !!saved && vtxoSpendIsLivePending(saved),
        })
        publish({ review, canReplace: false })
        return review
      })
    },
    openPending(operationId: string): Promise<OpenedSpendingPayment> {
      return run('open', 'open:' + operationId, async (check) => {
        const { status } = access()
        const pending = loadPersistedVtxoSpendById(status.vaultId, operationId)
        if (!pending) throw new ReviewError('This pending payment has already finished. Refresh the wallet.')
        await ensureVaultWalletWorker(status)
        check()
        const api = await import('./lightning')
        check()
        const lightning = await api.withVaultLightningRepository(status.vaultId, (repository) =>
          api.loadVaultLightningFundingQuote(repository, requireSdkNetworkName(status.network), {
            operationId: pending.operationId,
            bundleDigest: pending.bundleDigest,
            address: pending.destAddress,
            amountSats: pending.amountSats,
            fundingFeeSats: pending.feeSats,
          }),
        )
        check()
        const current = loadPersistedVtxoSpendById(status.vaultId, operationId)
        if (
          !current ||
          current.bundleDigest !== pending.bundleDigest ||
          !isSameVtxoPayment(current, pending.destAddress, pending.amountSats)
        )
          throw new ReviewError('The pending payment changed. Open it again.')
        const payment = {
          address: lightning?.invoice || current.destAddress,
          amount: lightning?.invoiceAmountSats || current.amountSats,
          fee: (lightning?.corridorFeeSats || 0) + (current.feeSats || 0),
        }
        const review =
          current.stage === 'pre-reserve'
            ? null
            : freeze({
                payment,
                funding: quoteFromPersistedVtxoSpend(current),
                lightning: lightning || null,
                resuming: vtxoSpendIsLivePending(current),
              })
        replacementIds = undefined
        const opened = freeze({ payment, review })
        publish({ review, opened, canReplace: false })
        return opened
      })
    },
    approve(draft: SpendingPaymentDraft): Promise<void> {
      const payment = { ...draft }
      return run('approve', JSON.stringify(['approve', snapshot.review, payment]), async (check, signal) => {
        const { status, enrollment } = access()
        const review = snapshot.review
        if (!review || !samePayment(review.payment, payment)) {
          publish({ review: null })
          throw new ReviewError('This fee quote expired or changed. Review the send again.')
        }
        const { funding: reviewed, lightning } = review
        try {
          let sent: { txid: string; feeSats: number }
          if (lightning) {
            const api = await import('./lightning')
            check()
            const pending = loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId)
            const alreadyAuthorized =
              !!pending &&
              vtxoSpendIsLivePending(pending) &&
              pending.bundleDigest === reviewed.bundleDigest &&
              isSameVtxoPayment(pending, lightning.fundAddress, lightning.fundAmountSats)
            if (!alreadyAuthorized) api.assertVaultLightningQuoteCurrent(lightning)
            sent = await api.withVaultLightningLifecycleLock(status.vaultId, async () => {
              check()
              const proof = { rfqId: lightning.rfqId, ...fundingProof(reviewed) }
              const target = await api.withVaultLightningRepository(status.vaultId, async (repository) => {
                check()
                try {
                  return await api.resumeVaultLightningFunding(repository, proof, undefined, alreadyAuthorized)
                } catch (error) {
                  check()
                  if (!(error instanceof api.VaultLightningFundingNotStartedError)) throw error
                  return api.beginVaultLightningFunding(repository, lightning.rfqId, proof)
                }
              })
              check()
              if (target.address !== reviewed.destAddress || target.amountSats !== reviewed.amountSats)
                throw new Error('Lightning funding target changed after Review.')
              let result: { txid: string; feeSats: number }
              try {
                result = await sendVaultVtxo(enrollment, status, reviewed, undefined, signal)
              } catch (error) {
                if (!isVtxoReceiptPendingError(error)) throw error
                result = { txid: error.txid, feeSats: error.feeSats }
              }
              // A returned transaction remains bound to the RFQ even if the UI session ends.
              await api.withVaultLightningRepository(status.vaultId, (repository) =>
                api.recordVaultLightningFundingTxid(repository, lightning.rfqId, result.txid),
              )
              return result
            })
          } else {
            const existing = loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId)
            const resume = !!existing && !!reviewed.operationId && vtxoSpendIsLivePending(existing)
            const unlocker = createVtxoSpendUnlocker(
              enrollment,
              status,
              resume ? reviewed.bundleDigest : newVtxoSpendChallenge(),
              undefined,
              signal,
            )
            try {
              const auth = await unlocker.unlock()
              check()
              const quote = resume
                ? reviewed
                : await reserveVaultVtxo(enrollment, status, reviewed.destAddress, reviewed.amountSats, {
                    replaceExisting: !!replacementIds,
                    replacementIds,
                    phoneSecret: auth.phoneSecret,
                    signal,
                  })
              check()
              replacementIds = undefined
              if (!resume && quote.feeSats !== reviewed.feeSats) {
                const updated = freeze({
                  ...review,
                  payment: { ...payment, fee: quote.feeSats },
                  funding: structuredClone(quote),
                })
                publish({
                  review: updated,
                  error: 'The network fee changed. Review the updated total before approving.',
                })
                event('fee-changed', updated)
                return
              }
              sent = await sendVaultVtxo(enrollment, status, quote, () => unlocker, signal)
            } finally {
              unlocker.dispose()
            }
          }
          check()
          publish({ review: null })
          event('sent', review, sent.txid, lightning ? lightning.corridorFeeSats + sent.feeSats : sent.feeSats)
        } catch (error) {
          check()
          if (isVtxoReceiptPendingError(error)) {
            publish({ review: null })
            event('sent', review, error.txid, (lightning?.corridorFeeSats || 0) + error.feeSats)
            return
          }
          if (
            isVtxoReviewedReservationError(error) ||
            isVtxoSpendInFlightError(error) ||
            isVtxoSameSendInProgressError(error) ||
            isVtxoLivePendingError(error) ||
            isVtxoAbortFailedError(error)
          ) {
            publish({ review: null })
            event('review-required', review)
          }
          if (
            !isVtxoReviewedReservationError(error) &&
            listPersistedVtxoSpends(status.vaultId).some(vtxoSpendIsLivePending)
          ) {
            throw new ReviewError(
              'Payment is pending; it has not been confirmed as paid. Open Pending payment to resume it.',
            )
          }
          throw error
        }
      })
    },
    retryRefund(rfqId: string): Promise<void> {
      return run('refund', 'refund:' + rfqId, async (check, signal) => {
        const { status, enrollment } = access()
        const phoneSecret = await unlockPhoneBip340(enrollment, status, signal)
        try {
          check()
          const api = await import('./lightning')
          check()
          await api.withVaultLightningSdkWallet(
            phoneSecret,
            status,
            async (session) => {
              check()
              const record = await api.getVaultLightningStatus(session.repository, rfqId)
              check()
              if (!record) throw new ReviewError('This Lightning payment is no longer available.')
              if (record.state === 'refunded' || record.state === 'settled') return
              if (record.state === 'needs_counterparty')
                throw new ReviewError('The Lightning payment could not be returned yet. Try again shortly.')
              if (record.state === 'failed')
                throw new ReviewError('The Lightning payment needs recovery before it can be returned.')
              throw new ReviewError('This Lightning payment is still processing.')
            },
            { refundRfqId: rfqId, signal },
          )
          check()
        } finally {
          zeroBytes(phoneSecret)
        }
      })
    },
  }
  return owner
}
export type SpendingPayments = ReturnType<typeof createSpendingPayments>
