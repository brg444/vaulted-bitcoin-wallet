import { ArkAddress, RestIndexerProvider, Transaction, hasTerminalSpend, type NetworkName } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import { vaultAccountRuntime, vaultWalletRuntimeKey } from './accountRuntime'
import type { VaultSession } from './session'
import { isVaultArkAddress } from './bitcoin'
import { DUST_SATS } from './constants'
import { zeroBytes } from './ceremony/directauth'
import { unlockPhoneBip340 } from './savingsSpend'
import { humanizeVaultError } from './humanize'
import { consoleError } from '../logs'
import { requireSdkNetworkName, sdkNetworkName, vaultOperatorOrigin } from './networkPins'
import {
  discoverVaultLightningSolver,
  isVaultLightningInput,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
} from './lightningConfig'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import {
  isFundedLightningRecord,
  listFundedTerminalLightningRecords,
  listVaultLightningActivityRecords,
  storedLightningProfile,
  validFundingProof,
  type StoredVaultLightningProfile,
  type VaultLightningQuote,
} from './lightningLifecycle'
import {
  isRfqSwapTerminal,
  readLockupFate,
  type AssetSwapRepository,
  type LockupFate,
  type RfqSwapRecord,
} from '@arkade-os/swap'
import { readLightningRefundAttempt, writeRetiredLightningFunding } from './lightningEvidence'
import { withVaultLightningLifecycleLock } from './lightningLock'
import { ensureVaultWalletWorker, fetchVaultWalletVtxoSnapshot } from './vtxo/walletWorker'
import {
  SPENDING_PAYMENT_EVENT,
  listPersistedVtxoSpends,
  loadPersistedVtxoSpend,
  loadPersistedVtxoSpendById,
} from './vtxo/spendingJournal'
import {
  createVtxoSpendUnlocker,
  acknowledgeSettledVtxoSpends,
  acknowledgeSpendingVtxoRecovery,
  isSameVtxoPayment,
  newVtxoSpendChallenge,
  previewVaultVtxoSend,
  quoteFromPersistedVtxoSpend,
  reserveVaultVtxo,
  sendVaultVtxo,
  vtxoSpendIsAbortable,
  vtxoSpendIsLivePending,
  type VaultVtxoSpendQuote,
} from './vtxo/spend'
import {
  isVtxoAbortFailedError,
  isVtxoLivePendingError,
  isVtxoReceiptPendingError,
  isVtxoReservedReplaceError,
  isVtxoReviewedReservationError,
  isVtxoSameSendInProgressError,
  isVtxoSpendInFlightError,
} from './vtxo/spendingErrors'
import {
  readCommittedRecoveryCoverage,
  readCommittedRecoveryEvidence,
  type CommittedRecoveryCoverage,
} from './recovery/committedCoverage'
import type { VaultHistoryItem } from './history'
import type { LightningRecoveryJournal } from './recovery/lightningArchive'
import type { VaultStatus } from './types'

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
  pending: 'review' | 'open' | 'approve' | 'refund' | 'acknowledge' | null
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
/** Best-effort retirement of funded Lightning terminals from the one committed
 * file snapshot. A cancelled caller aborts; missing evidence keeps the record. */
async function sweepSettledVaultLightning(status: VaultStatus, check: () => void, signal?: AbortSignal) {
  try {
    const api = await import('./lightning')
    check()
    const funded = await api.withVaultLightningRepository(status.vaultId, (repository) =>
      listFundedTerminalLightningRecords(repository),
    )
    if (!funded.length) return
    const snapshot = await fetchVaultWalletVtxoSnapshot(status)
    check()
    const evidence = await readCommittedRecoveryEvidence(status)
    check()
    await api.withVaultLightningRepository(status.vaultId, (repository) =>
      acknowledgeSettledVaultLightning(
        status,
        repository,
        snapshot.history,
        evidence?.lightningJournal ?? null,
        evidence?.coverage,
        signal,
      ),
    )
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    consoleError(error, 'Lightning settled acknowledgment')
  }
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
    const { account, locked } = session.getSnapshot()
    return !locked && account ? JSON.stringify([vaultWalletRuntimeKey(account.status), account.enrollment]) : ''
  }
  const access = () => {
    const { account, setup } = session.getSnapshot()
    if (!consumers || !identity || identity !== sessionIdentity() || !account)
      throw new ReviewError('Sign in with the passkey that created this vault.')
    return structuredClone({ account, status: account.status, enrollment: account.enrollment, setup })
  }
  const load = () => {
    if (!consumers || !identity || identity !== sessionIdentity()) return
    let status: { vaultId: string }
    try {
      status = access().status
    } catch {
      return
    }
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
      vaultAccountRuntime(session.getSnapshot().account!.status).spendingPayments = owner
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
        // Retire service-finalized operations whose recovery evidence has
        // caught up, so a settled payment stops blocking review. Evidence lag
        // keeps the journal; the live-pending check below still applies. The
        // sweep runs after the passkey gesture so WebAuthn starts in the click.
        const retireSettled = async () => {
          try {
            await acknowledgeSettledVtxoSpends(status, undefined, signal)
          } catch (error) {
            if (signal.aborted) signal.throwIfAborted()
            consoleError(error, 'Spending settled acknowledgment')
          }
          // Retire funded Lightning terminals on the same terms, from the one
          // committed file snapshot. Evidence lag keeps the record for later.
          await sweepSettledVaultLightning(status, check, signal)
        }
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
            if (invoice.amountSats > setup.txCapSats)
              throw new ReviewError(`Over this device’s send limit of ${setup.txCapSats.toLocaleString()} sats.`)
            if (invoice.amountSats > available()) throw new ReviewError('Not enough confirmed spending funds.')
            // Start WebAuthn in the click gesture, before solver discovery or dynamic imports.
            phase = 'passkey approval'
            const phoneSecret = await unlockPhoneBip340(enrollment, status, signal)
            try {
              check()
              await retireSettled()
              check()
              if (listPersistedVtxoSpends(status.vaultId).some(vtxoSpendIsLivePending))
                throw new ReviewError(
                  'A payment is still pending. Open Pending payment to resume it before starting another.',
                )
              const current = loadPersistedVtxoSpend(status.vaultId)
              const resumeVtxo =
                current?.bundleDigest && current.destAddress && Number.isSafeInteger(current.amountSats)
                  ? {
                      operationId: current.operationId,
                      bundleDigest: current.bundleDigest,
                      address: current.destAddress,
                      amountSats: current.amountSats,
                      fundingFeeSats: current.feeSats,
                    }
                  : undefined
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
          await retireSettled()
          check()
          const operations = listPersistedVtxoSpends(status.vaultId)
          const pending = loadPersistedVtxoSpend(status.vaultId)
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
      return run('open', 'open:' + operationId, async (check, signal) => {
        const { status } = access()
        try {
          if (await acknowledgeSpendingVtxoRecovery(status, operationId, undefined, signal))
            throw new ReviewError('This pending payment has already finished. Refresh the wallet.')
        } catch (error) {
          if (error instanceof ReviewError) throw error
          if (signal.aborted) signal.throwIfAborted()
          consoleError(error, 'Spending settled acknowledgment')
        }
        check()
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
    acknowledgeRecovery(operationId: string, coverage?: CommittedRecoveryCoverage): Promise<boolean> {
      return run(
        'acknowledge',
        `acknowledge:${operationId}:${coverage?.fileDigest || 'latest'}`,
        async (check, signal) => {
          const { status } = access()
          check()
          return acknowledgeSpendingVtxoRecovery(status, operationId, coverage, signal)
        },
      )
    },
    /** Best-effort retirement of every service-finalized operation when the
     * caller has committed recovery evidence. A cancelled or replaced session
     * performs no mutation; a concurrent command keeps the existing journal. */
    async acknowledgeSettledRecovery(coverage: CommittedRecoveryCoverage): Promise<void> {
      if (flight || !identity || identity !== sessionIdentity()) return
      let status: ReturnType<typeof access>['status'] | undefined
      try {
        status = access().status
      } catch {
        return
      }
      if (!status || coverage.vaultId !== status.vaultId || coverage.network !== status.network) return
      const covered = status
      await run('acknowledge', `acknowledge-settled:${coverage.fileDigest}`, async (check, signal) => {
        check()
        await acknowledgeSettledVtxoSpends(covered, coverage, signal)
        check()
        await sweepSettledVaultLightning(covered, check, signal)
      }).catch(() => undefined)
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
function fundingOutpointKey(out: { txid: string; vout: number }) {
  return `${out.txid}:${out.vout}`
}

function parsePackedFundingOutpoints(exit: unknown): { txid: string; vout: number }[] {
  if (!exit || typeof exit !== 'object') return []
  const packed = (exit as { coins?: unknown }).coins
  if (typeof packed !== 'string') return []
  try {
    const raw = JSON.parse(packed) as unknown
    if (!Array.isArray(raw) || !raw.length) return []
    const out: { txid: string; vout: number }[] = []
    const seen = new Set<string>()
    for (const coin of raw) {
      if (!coin || typeof coin !== 'object') return []
      const txid = (coin as { txid?: unknown }).txid
      const vout = (coin as { vout?: unknown }).vout
      if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) return []
      if (!Number.isSafeInteger(vout) || (vout as number) < 0 || (vout as number) > 0xffffffff) return []
      const key = fundingOutpointKey({ txid, vout: vout as number })
      if (seen.has(key)) return []
      seen.add(key)
      out.push({ txid, vout: vout as number })
    }
    return out
  } catch {
    return []
  }
}

function parseAttemptFundingOutpoints(
  inputs: { txid?: unknown; vout?: unknown }[] | undefined,
): { txid: string; vout: number }[] | null {
  if (!inputs) return []
  if (!inputs.length) return []
  const out: { txid: string; vout: number }[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    if (!input || typeof input.txid !== 'string' || !/^[0-9a-f]{64}$/.test(input.txid)) return null
    if (!Number.isSafeInteger(input.vout) || (input.vout as number) < 0 || (input.vout as number) > 0xffffffff)
      return null
    const key = fundingOutpointKey({ txid: input.txid, vout: input.vout as number })
    if (seen.has(key)) return null
    seen.add(key)
    out.push({ txid: input.txid, vout: input.vout as number })
  }
  return out
}

/** Original lockup outpoints frozen in the committed archive or refund facts.
 * Missing, conflicting, or empty sets cannot prove every-input consumption. */
function retainedLightningFundingOutpoints(
  record: RfqSwapRecord,
  journal: LightningRecoveryJournal | null,
): { txid: string; vout: number }[] | null {
  const filed = journal?.entries.find(
    (entry) => entry.record.rfqId === record.rfqId && entry.record.fundingArkTxid === record.fundingArkTxid,
  )
  const fromArchive = parsePackedFundingOutpoints(filed?.exit)
  let fromAttempt: { txid: string; vout: number }[] | null
  try {
    fromAttempt = parseAttemptFundingOutpoints(
      filed?.refundAttempt?.fundedInputs ?? readLightningRefundAttempt(record.rfqId)?.fundedInputs,
    )
  } catch {
    return null
  }
  if (fromAttempt === null) return null
  if (fromArchive.length && fromAttempt.length) {
    if (fromArchive.length !== fromAttempt.length) return null
    const attemptKeys = new Set(fromAttempt.map(fundingOutpointKey))
    if (fromArchive.some((out) => !attemptKeys.has(fundingOutpointKey(out)))) return null
  }
  const merged = fromArchive.length ? fromArchive : fromAttempt
  return merged.length ? merged : null
}

async function lockupOutpointsAreConsumed(
  status: VaultStatus,
  expected: readonly { txid: string; vout: number }[],
): Promise<boolean> {
  if (!expected.length) return false
  try {
    const indexer = new RestIndexerProvider(vaultOperatorOrigin(status.network))
    const { vtxos } = await indexer.getVtxos({ outpoints: [...expected] })
    const observed = vtxos ?? []
    return expected.every((out) =>
      observed.some((vtxo) => vtxo.txid === out.txid && vtxo.vout === out.vout && hasTerminalSpend(vtxo)),
    )
  } catch {
    return false
  }
}

/** Whether an indexer fate observation proves consumption of the exact
 * expected checkpoints. A null expectation list (no durable checkpoint
 * identities) accepts any non-empty spend set; callers document that bound.
 * Every reported ark transaction for our own refund must equal the retained
 * refund id, and spends never reference unknown checkpoints. */
function lockupSpendsCoverCheckpoints(
  spends: readonly { checkpointTxid: string; arkTxid?: string }[],
  expectedCheckpointTxids: readonly string[] | null,
  refundArkTxid: string | null,
): boolean {
  if (!spends.length) return false
  for (const spend of spends) {
    if (!/^[0-9a-f]{64}$/.test(spend.checkpointTxid)) return false
    if (spend.arkTxid !== undefined && !/^[0-9a-f]{64}$/.test(spend.arkTxid)) return false
  }
  if (expectedCheckpointTxids !== null) {
    if (expectedCheckpointTxids.some((id) => !/^[0-9a-f]{64}$/.test(id))) return false
    const seen = new Set(spends.map((spend) => spend.checkpointTxid))
    if (seen.size !== spends.length) return false
    if (expectedCheckpointTxids.length !== spends.length) return false
    if (!expectedCheckpointTxids.every((id) => seen.has(id))) return false
  }
  if (refundArkTxid !== null) {
    for (const spend of spends) {
      if (spend.arkTxid !== undefined && spend.arkTxid !== refundArkTxid) return false
    }
  }
  return true
}

/** Resolve the lockup fate for retirement. Unresolvable, open, exited and
 * unknown outcomes all retain the journal; only positively consumed spends
 * proceed to checkpoint matching. */
async function readRetirementLockupFate(
  status: VaultStatus,
  record: RfqSwapRecord,
): Promise<Extract<LockupFate, { fate: 'claimed' | 'returned' }> | null> {
  try {
    const profile = record.profile as Record<string, unknown>
    const hashlock = profile?.hashlock as unknown
    const paymentHash =
      typeof hashlock === 'string' ? hashlock : (hashlock as { paymentHash?: unknown } | null)?.paymentHash
    if (typeof paymentHash !== 'string' || !/^[0-9a-f]{64}$/.test(paymentHash)) return null
    const indexer = new RestIndexerProvider(vaultOperatorOrigin(status.network))
    const fate = await readLockupFate(indexer, {
      swapPkScript: ArkAddress.decode(record.lockupAddress).pkScript,
      paymentHash,
    })
    if (fate.fate !== 'claimed' && fate.fate !== 'returned') return null
    return fate
  } catch {
    return null
  }
}

/** Owner-side retirement predicate for a funded Lightning record.
 *
 * Retires only when the terminal package record, the activity receipt, the
 * wallet history, the committed operation journal and positive lockup
 * consumption agree on the exact immutable swap. Anything short of that
 * keeps the record for resume, reload and independent recovery. */
export async function acknowledgeVaultLightningRecovery(
  status: VaultStatus,
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'getAllRfqSwaps' | 'removeRfqSwap'>,
  rfqId: string,
  history: readonly VaultHistoryItem[],
  journal: LightningRecoveryJournal | null,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<boolean> {
  return withVaultLightningLifecycleLock(status.vaultId, () =>
    acknowledgeVaultLightningRecoveryLocked(status, repository, rfqId, history, journal, evidence, signal),
  )
}

async function acknowledgeVaultLightningRecoveryLocked(
  status: VaultStatus,
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'getAllRfqSwaps' | 'removeRfqSwap'>,
  rfqId: string,
  history: readonly VaultHistoryItem[],
  journal: LightningRecoveryJournal | null,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  const record = await repository.getRfqSwap(rfqId)
  if (!record || record.kind !== 'lightning_send' || !isRfqSwapTerminal(record.state)) return false
  if (!isFundedLightningRecord(record) || !record.fundingArkTxid) return false
  // A failed funding without a refund successor stays for recovery: its
  // locked outputs may still be refundable, and no successor proves them out.
  if (record.state === 'failed' && !record.refundArkTxid) return false
  let stored: StoredVaultLightningProfile
  try {
    stored = storedLightningProfile(record)
  } catch {
    return false
  }
  // Stored profiles use the SDK network name (bitcoin), while Vault status
  // uses mainnet; compare through the existing mapping so mainnet retires.
  if (stored.network !== sdkNetworkName(status.network)) return false
  const proof = stored.fundingProof
  if (
    proof &&
    (proof.rfqId !== rfqId || proof.address !== record.lockupAddress || proof.amountSats !== record.amount)
  ) {
    return false
  }
  if (proof && !validFundingProof({ ...proof, rfqId })) return false
  signal?.throwIfAborted()
  const activities = await listVaultLightningActivityRecords(repository)
  const receipt = activities.find(
    (activity) => activity.rfqId === rfqId && activity.terminal && activity.fundingTxid === record.fundingArkTxid,
  )
  if (!receipt) return false
  // SDK activity amounts net fees differently per path, so history binds the
  // funding transaction presence, not a recomputed amount.
  if (!history.some((row) => row.account === 'spend' && row.type === 'sent' && row.txid === record.fundingArkTxid)) {
    return false
  }
  // The committed file must retain this exact swap; outputs alone cannot
  // prove that.
  const filed = journal?.entries.find(
    (entry) => entry.record.rfqId === rfqId && entry.record.fundingArkTxid === record.fundingArkTxid,
  )
  if (!filed) return false
  // Every original funding output retained in the archive or refund facts must
  // be positively consumed. A script-only indexer subset is not enough.
  const expectedFunding = retainedLightningFundingOutpoints(record, journal)
  if (!expectedFunding) return false
  if (!(await lockupOutpointsAreConsumed(status, expectedFunding))) return false
  // Positive consumption with exact checkpoint linkage. Expected checkpoint
  // identities come from the retained refund attempt when one exists.
  const fate = await readRetirementLockupFate(status, record)
  if (!fate) return false
  let expectedCheckpoints: string[] | null = null
  try {
    const attempt = readLightningRefundAttempt(rfqId)
    if (attempt?.submittedCheckpointPsbts?.length) {
      expectedCheckpoints = attempt.submittedCheckpointPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)
    }
  } catch {
    return false
  }
  const refundId = record.refundArkTxid ?? null
  if (!lockupSpendsCoverCheckpoints(fate.spends, expectedCheckpoints, refundId)) return false
  signal?.throwIfAborted()
  const coverage = await readCommittedRecoveryCoverage(status)
  if (
    !coverage ||
    (evidence &&
      (evidence.vaultId !== coverage.vaultId ||
        evidence.network !== coverage.network ||
        evidence.descriptorHash !== coverage.descriptorHash ||
        evidence.fileDigest !== coverage.fileDigest))
  ) {
    return false
  }
  if (record.refundArkTxid) {
    if (
      !coverage.outputs.some((coin) => coin.txid === record.refundArkTxid && coin.script === status.spendingArkScript)
    ) {
      return false
    }
  }
  // A stale observation cannot retire a replacement or rewritten record.
  const current = await repository.getRfqSwap(rfqId)
  if (JSON.stringify(current) !== JSON.stringify(record)) return false
  signal?.throwIfAborted()
  writeRetiredLightningFunding({
    rfqId,
    lockupAddress: record.lockupAddress,
    amountSats: record.amount!,
    fundingArkTxid: record.fundingArkTxid,
    ...(record.refundArkTxid ? { refundArkTxid: record.refundArkTxid } : {}),
    state: record.state,
    fileDigest: coverage.fileDigest,
    network: status.network,
    vaultId: status.vaultId,
    retiredAt: Math.floor(Date.now() / 1000),
  })
  await repository.removeRfqSwap(rfqId)
  if (await repository.getRfqSwap(rfqId)) {
    throw new Error(`Funded Lightning record ${rfqId} was not durably retired.`)
  }
  return true
}

/** Best-effort retirement of every funded terminal record. A cancelled caller
 * aborts the sweep; missing evidence keeps the remaining records. */
export async function acknowledgeSettledVaultLightning(
  status: VaultStatus,
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'getAllRfqSwaps' | 'removeRfqSwap'>,
  history: readonly VaultHistoryItem[],
  journal: LightningRecoveryJournal | null,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<number> {
  const funded = (await repository.getAllRfqSwaps())
    .filter(
      (record) =>
        record.kind === 'lightning_send' && isRfqSwapTerminal(record.state) && isFundedLightningRecord(record),
    )
    .map((record) => record.rfqId)
  let retired = 0
  for (const rfqId of funded) {
    signal?.throwIfAborted()
    try {
      if (await acknowledgeVaultLightningRecovery(status, repository, rfqId, history, journal, evidence, signal))
        retired++
    } catch (error) {
      signal?.throwIfAborted()
      if (signal?.aborted) throw error
      consoleError(error, `Lightning settled acknowledgment ${rfqId}`)
    }
  }
  return retired
}

export type SpendingPayments = ReturnType<typeof createSpendingPayments>
