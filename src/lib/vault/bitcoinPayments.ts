import { vaultAccountRuntime, vaultWalletRuntimeKey } from './accountRuntime'
import type { VaultMaintenanceTask } from './accountMaintenance'
import type { VaultSession } from './session'
import type { CommittedRecoveryCoverage } from './recovery/committedCoverage'
import { bitcoinDustSats, isVaultBitcoinAddress, scriptHexFromAddress } from './bitcoin'
import { BitcoinPaymentError } from './bitcoinPaymentError'
import { humanizeVaultError } from './humanize'
import {
  BITCOIN_PAYMENT_EVENT,
  readSpendingBitcoin,
  type BitcoinPaymentJournal,
  type BitcoinPaymentOutput,
} from './spendingBitcoinStore'
import {
  acknowledgeSpendingBitcoinRecovery,
  cancelSpendingBitcoin,
  checkSpendingBitcoin,
  sendSpendingToBitcoin,
} from './spendingBitcoinFunding'

export interface BitcoinPaymentDraft {
  address: string
  amount: number
  fee: number
}
export interface BitcoinPaymentReview {
  operationId: string
  payment: BitcoinPaymentDraft
  outputs: BitcoinPaymentOutput[]
}
interface BitcoinPaymentsSnapshot {
  operation: BitcoinPaymentJournal | null
  journalError: string
  review: BitcoinPaymentReview | null
  pending: 'prepare' | 'approval' | 'send' | 'check' | 'cancel' | 'acknowledge' | null
  progress: string
  error: string
  paymentError?: BitcoinPaymentError
  notice: { operationId: string; message: string } | null
  completion: { id: number; payment: BitcoinPaymentDraft; txid: string | null } | null
}
type SessionSource = Pick<VaultSession, 'getSnapshot' | 'subscribe'>
const owners = new WeakMap<SessionSource, BitcoinPayments>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const released = (state?: string) => !!state && ['released', 'cancelled', 'rejected'].includes(state)

export function bitcoinPaymentsForSession(session: SessionSource) {
  let owner = owners.get(session)
  if (!owner) {
    owner = createBitcoinPayments(session)
    owners.set(session, owner)
  }
  return owner
}
function createBitcoinPayments(session: SessionSource) {
  let snapshot: BitcoinPaymentsSnapshot = freeze({
    operation: null,
    journalError: '',
    review: null,
    pending: null,
    progress: '',
    error: '',
    notice: null,
    completion: null,
  })
  const listeners = new Set<() => void>()
  let consumers = 0
  let identity = ''
  let generation = 0
  let completionId = 0
  let unsubscribe: (() => void) | undefined
  let task: VaultMaintenanceTask<void> | undefined
  let approval: { view: BitcoinPaymentReview; journal: string; resolve: (accepted: boolean) => void } | undefined
  let reviewReady: Promise<BitcoinPaymentReview | null> | undefined
  let flight: { key: string; abort: AbortController; promise: Promise<unknown> } | undefined
  const publish = (change: Partial<BitcoinPaymentsSnapshot>) => {
    if (
      Object.entries(change).every(([key, value]) => Object.is(snapshot[key as keyof BitcoinPaymentsSnapshot], value))
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
    const { status, enrollment } = session.getSnapshot()
    if (!consumers || !task || !identity || identity !== sessionIdentity() || !status?.enrolled || !enrollment)
      throw new Error('Unlock this vault before sending from Spending.')
    return structuredClone({ status, enrollment })
  }
  const requireCurrent = (epoch: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (epoch !== generation || identity !== sessionIdentity())
      throw new DOMException('Bitcoin payment session ended', 'AbortError')
  }
  const load = () => {
    if (!identity || identity !== sessionIdentity() || !task) return
    try {
      const operation = readSpendingBitcoin(access().status)
      // Storage and journal events can repeat without changing the retained facts.
      if (JSON.stringify(operation) !== JSON.stringify(snapshot.operation) || snapshot.journalError)
        publish({ operation: structuredClone(operation), journalError: '' })
    } catch (error) {
      publish({ operation: null, journalError: humanizeVaultError(error) })
    }
  }
  const cancel = () => {
    generation++
    flight?.abort.abort(new DOMException('Bitcoin payment approval ended', 'AbortError'))
    approval?.resolve(false)
    approval = undefined
    publish({ review: null })
  }
  const stopObservation = () => {
    const previous = task
    task = undefined
    return previous?.dispose() || Promise.resolve()
  }
  const observe = async (signal: AbortSignal) => {
    if (flight) return
    const epoch = generation
    try {
      const { status } = access()
      const saved = readSpendingBitcoin(status)
      if (!saved) return
      if (saved.stage !== 'confirmed') await checkSpendingBitcoin(status, { operationId: saved.operationId, signal })
      requireCurrent(epoch, signal)
      if (!flight) await acknowledgeSpendingBitcoinRecovery(status, undefined, signal)
    } catch {
      // The journal remains visible and acknowledgment can resume on the next refresh.
    } finally {
      if (!signal.aborted && epoch === generation) load()
    }
  }
  const bind = () => {
    const next = sessionIdentity()
    if (next !== identity) {
      cancel()
      void stopObservation()
      identity = next
      publish({
        operation: null,
        journalError: '',
        error: '',
        paymentError: undefined,
        progress: '',
        notice: null,
        completion: null,
      })
    }
    if (consumers && identity && !task) {
      const account = vaultAccountRuntime(session.getSnapshot().status!)
      account.bitcoinPayments = owner
      task = account.maintenance.observe('bitcoin-payment', observe, { intervalMs: 15_000 })
      load()
      task.request()
    }
  }
  const run = <T>(
    kind: NonNullable<BitcoinPaymentsSnapshot['pending']>,
    key: string,
    work: (check: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (flight) {
      if (!flight.abort.signal.aborted && flight.key === key) return flight.promise as Promise<T>
      return Promise.reject(new Error('Finish the current Bitcoin payment action before continuing.'))
    }
    const abort = new AbortController()
    const epoch = generation
    const current = { key, abort, promise: Promise.resolve() as Promise<unknown> }
    flight = current
    const check = () => requireCurrent(epoch, abort.signal)
    publish({ pending: kind, error: '', paymentError: undefined, notice: null })
    current.promise = (async () => {
      check()
      return work(check, abort.signal)
    })()
      .catch((error) => {
        if (kind !== 'acknowledge' && epoch === generation && !abort.signal.aborted)
          publish({
            error: humanizeVaultError(error),
            paymentError: error instanceof BitcoinPaymentError ? error : undefined,
          })
        throw error
      })
      .finally(() => {
        if (flight === current) {
          flight = undefined
          publish({ pending: null, progress: '' })
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
    clearError: () => publish({ error: '', paymentError: undefined }),
    consumeCompletion(id: number) {
      const completion = snapshot.completion
      if (completion?.id !== id) return null
      publish({ completion: null })
      return completion
    },
    retain() {
      consumers++
      if (consumers === 1) {
        unsubscribe = session.subscribe(bind)
        window.addEventListener(BITCOIN_PAYMENT_EVENT, load)
        window.addEventListener('storage', load)
        bind()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--consumers === 0) {
          unsubscribe?.()
          window.removeEventListener(BITCOIN_PAYMENT_EVENT, load)
          window.removeEventListener('storage', load)
          void owner.suspend()
        }
      }
    },
    async suspend() {
      cancel()
      const drain = stopObservation()
      identity = ''
      publish({ operation: null, journalError: '', error: '', paymentError: undefined, notice: null, completion: null })
      await Promise.all([drain, flight?.promise.catch(() => undefined)])
    },
    cancelReview() {
      if (snapshot.pending === 'prepare' || snapshot.pending === 'approval') cancel()
    },
    review(draft: BitcoinPaymentDraft): Promise<BitcoinPaymentReview | null> {
      const payment = { ...draft }
      const key = JSON.stringify(['review', payment.address, payment.amount])
      if (flight) {
        if (flight.key === key && !flight.abort.signal.aborted && reviewReady) return reviewReady
        return Promise.reject(new Error('Finish the current Bitcoin payment action before continuing.'))
      }
      let ready!: (view: BitcoinPaymentReview | null) => void
      const promise = new Promise<BitcoinPaymentReview | null>((resolve) => {
        ready = resolve
      })
      reviewReady = promise
      void run('prepare', key, async (check, signal) => {
        const { status, enrollment } = access()
        if (!isVaultBitcoinAddress(payment.address, status.network)) throw new Error('Enter a Bitcoin address.')
        const dust = bitcoinDustSats(payment.address, status.network)
        if (!Number.isSafeInteger(payment.amount) || payment.amount < dust) throw new Error(`At least ₿${dust}.`)
        const outputs = [{ script: scriptHexFromAddress(payment.address, status.network), amountSats: payment.amount }]
        let accepted = false
        let reviewedPayment = payment
        try {
          const result = await sendSpendingToBitcoin(
            enrollment,
            status,
            outputs,
            async (plan) => {
              if (signal.aborted) return false
              check()
              if (!plan.operationId || !Number.isSafeInteger(plan.feeSats) || plan.feeSats < 0)
                throw new Error('Invalid Bitcoin payment review.')
              reviewedPayment = { ...payment, fee: plan.feeSats }
              const view = freeze({
                operationId: plan.operationId,
                payment: reviewedPayment,
                outputs: structuredClone(outputs),
              })
              const answer = new Promise<boolean>((resolve) => {
                approval = { view, journal: JSON.stringify(readSpendingBitcoin(status)), resolve }
              })
              publish({ review: view, pending: 'approval' })
              ready(view)
              accepted = await answer
              return accepted && !signal.aborted
            },
            (progress) => {
              if (!signal.aborted) {
                check()
                publish({ progress })
              }
            },
            signal,
          )
          check()
          if (accepted)
            publish({
              completion: {
                id: ++completionId,
                payment: reviewedPayment,
                txid:
                  ['submitted', 'confirmed'].includes(result.state) && result.commitmentTxid
                    ? result.commitmentTxid
                    : null,
              },
            })
        } catch (error) {
          if (accepted && !signal.aborted) {
            check()
            publish({ completion: { id: ++completionId, payment: reviewedPayment, txid: null } })
          }
          throw error
        } finally {
          approval = undefined
          publish({ review: null })
        }
      })
        .catch(() => undefined)
        .finally(() => {
          ready(null)
          if (reviewReady === promise) reviewReady = undefined
        })
      return promise
    },
    approve(draft: BitcoinPaymentDraft) {
      try {
        access()
        const current = approval
        const retained = snapshot.review?.payment
        if (
          snapshot.pending === 'send' &&
          retained &&
          draft.address === retained.address &&
          draft.amount === retained.amount &&
          draft.fee === retained.fee
        )
          return
        if (!current || snapshot.review !== current.view || snapshot.pending !== 'approval')
          throw new Error('Review the Bitcoin payment before confirming.')
        const expected = current.view.payment
        if (draft.address !== expected.address || draft.amount !== expected.amount || draft.fee !== expected.fee) {
          cancel()
          throw new BitcoinPaymentError('not_sent', 'Payment details changed. Review the payment again.')
        }
        const saved = readSpendingBitcoin(access().status)
        if (
          !saved ||
          saved.operationId !== current.view.operationId ||
          saved.stage !== 'prepared' ||
          JSON.stringify(saved) !== current.journal
        ) {
          cancel()
          throw new BitcoinPaymentError(
            'pending',
            'The saved Bitcoin payment changed. Check its status before continuing.',
          )
        }
        approval = undefined
        publish({ pending: 'send' })
        current.resolve(true)
      } catch (error) {
        publish({ error: humanizeVaultError(error) })
      }
    },
    check(operationId: string) {
      return run('check', `check:${operationId}`, async (check, signal) => {
        const { status } = access()
        const result = await checkSpendingBitcoin(status, { operationId, signal })
        check()
        if (released(result?.state))
          publish({
            notice: { operationId, message: 'This payment was not completed. Its reservation has been released.' },
          })
        return result
      })
    },
    cancel(operationId: string) {
      return run('cancel', `cancel:${operationId}`, async (check, signal) => {
        const { status } = access()
        const result = await cancelSpendingBitcoin(status, { operationId, signal })
        check()
        publish({
          notice: {
            operationId,
            message: released(result?.state)
              ? 'Payment cancelled. Its reservation has been released.'
              : 'Cancellation is still being checked. Funds remain reserved until it is confirmed.',
          },
        })
        return result
      })
    },
    async acknowledgeRecovery(coverage: CommittedRecoveryCoverage) {
      if (flight || !identity || identity !== sessionIdentity()) return
      const { status } = access()
      if (coverage.vaultId !== status.vaultId || coverage.network !== status.network) return
      await run('acknowledge', `acknowledge:${coverage.fileDigest}`, async (check, signal) => {
        check()
        await acknowledgeSpendingBitcoinRecovery(status, coverage, signal)
      }).catch(() => undefined)
    },
  }
  return owner
}
export type BitcoinPayments = ReturnType<typeof createBitcoinPayments>
