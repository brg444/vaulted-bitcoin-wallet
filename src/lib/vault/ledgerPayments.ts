import { vaultAccountRuntime } from './accountRuntime'
import type { VaultMaintenanceTask } from './accountMaintenance'
import type { VaultSession } from './session'
import type { LedgerSavingsRegistration } from './ledgerClient'
import { approveLedgerPayment, type LedgerApprovalPhase } from './ledgerApproval'
import {
  broadcastLedgerSavingsPayment,
  cancelLedgerSavingsPayment,
  loadLedgerSavingsPayment,
  markLedgerSavingsSigning,
  quoteLedgerSavingsPayment,
  reconcileLedgerSavingsPayment,
  retainLedgerSavingsPayment,
  saveLedgerSavingsPhoneApproval,
  saveLedgerSavingsSigned,
  signLedgerSavingsSeed,
  type LedgerSavingsPaymentRecord,
  type LedgerSavingsOutcomeKind,
} from './ledgerSavingsWallet'
import { fetchFeeEstimates } from './esplora'
import { satPerVFromFeeEstimates } from './onchainFee'
import { validateLedgerSavingsEnrollmentSecrets } from './program/ledgerEnrollment'
import { unlockLedgerSavingsSeed } from './savingsSpend'
import { humanizeVaultError } from './humanize'

export interface LedgerSavingsView {
  record: LedgerSavingsPaymentRecord
  registration: LedgerSavingsRegistration
  outcome: LedgerSavingsOutcomeKind
}
export interface SavingsPaymentDraft {
  address: string
  amount: number
  fee: number
}
interface LedgerPaymentsSnapshot {
  readonly view: LedgerSavingsView | null
  readonly pending: 'review' | 'reopen' | 'phone' | 'hardware' | null
  readonly hardwarePhase: LedgerApprovalPhase
  readonly error: string
  readonly completion: { id: number; txid: string; payment: SavingsPaymentDraft } | null
}
type SessionSource = Pick<VaultSession, 'getSnapshot' | 'subscribe'>
const owners = new WeakMap<SessionSource, LedgerPayments>()

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** A session has one Savings payment owner, including every observing React view. */
export function ledgerPaymentsForSession(session: SessionSource) {
  let owner = owners.get(session)
  if (!owner) {
    owner = createLedgerPayments(session)
    owners.set(session, owner)
  }
  return owner
}

function createLedgerPayments(session: SessionSource) {
  let snapshot: LedgerPaymentsSnapshot = freeze({
    view: null,
    pending: null,
    hardwarePhase: 'idle',
    error: '',
    completion: null,
  })
  const listeners = new Set<() => void>()
  let consumers = 0
  let generation = 0
  let completionId = 0
  let identity = ''
  let unsubscribe: (() => void) | undefined
  let task: VaultMaintenanceTask<Awaited<ReturnType<typeof reconcileLedgerSavingsPayment>>> | undefined
  let flight:
    | {
        key: string
        kind: NonNullable<LedgerPaymentsSnapshot['pending']>
        abort: AbortController
        promise: Promise<unknown>
      }
    | undefined

  const publish = (change: Partial<LedgerPaymentsSnapshot>) => {
    if (Object.entries(change).every(([key, value]) => Object.is(snapshot[key as keyof LedgerPaymentsSnapshot], value)))
      return
    snapshot = freeze({ ...snapshot, ...change })
    for (const listener of listeners) listener()
  }
  const sessionIdentity = () => {
    const { account, locked } = session.getSnapshot()
    if (locked || account?.savings !== 'ledger' || !account.status.ledgerSavings) return ''
    return JSON.stringify([
      account.status.vaultId,
      account.status.network,
      account.status.ledgerSavings.descriptorHash,
      account.enrollment.ledgerSavings,
    ])
  }
  const access = () => {
    const { account } = session.getSnapshot()
    if (!consumers || !task || !identity || identity !== sessionIdentity() || account?.savings !== 'ledger')
      throw new Error('Unlock this Ledger vault before sending from Savings.')
    let saved: ReturnType<typeof validateLedgerSavingsEnrollmentSecrets>
    try {
      saved = validateLedgerSavingsEnrollmentSecrets(account.enrollment.ledgerSavings, {
        context: account.status.ledgerSavings.context,
        spendingPolicy: account.status.ledgerSavings.spendingPolicy,
      })
    } catch {
      throw new Error('Unlock this Ledger vault before sending from Savings.')
    }
    return structuredClone({ ...saved, enrollment: account.enrollment, status: account.status })
  }
  const requireCurrent = (epoch: number, signal: AbortSignal) => {
    if (epoch !== generation || identity !== sessionIdentity())
      throw new Error('The active vault changed. Reopen the saved payment.')
    signal.throwIfAborted()
  }
  const show = (
    record: LedgerSavingsPaymentRecord,
    registration: LedgerSavingsRegistration,
    outcome: LedgerSavingsOutcomeKind,
  ) => publish({ view: structuredClone({ record, registration, outcome }) })
  const complete = (record: LedgerSavingsPaymentRecord, txid: string) => {
    const { destAddress: address, amountSats: amount, feeSats: fee } = record.payment
    publish({ completion: { id: ++completionId, txid, payment: { address, amount, fee } } })
  }
  const cancel = () => {
    generation++
    flight?.abort.abort(new DOMException('Savings approval ended', 'AbortError'))
  }
  const stopObservation = () => {
    const previous = task
    task = undefined
    return previous?.dispose() || Promise.resolve()
  }
  const read = async (signal: AbortSignal) => {
    await flight?.promise.catch(() => undefined)
    signal.throwIfAborted()
    const epoch = generation
    const saved = access()
    const retained = await loadLedgerSavingsPayment(saved.contract)
    requireCurrent(epoch, signal)
    if (!flight) {
      if (retained)
        show(
          retained,
          saved.registration,
          retained.phase === 'prepared' ? 'prepared' : retained.phase === 'signing' ? 'signing' : 'unknown',
        )
      else publish({ view: null })
    }
    const result = await reconcileLedgerSavingsPayment(saved.contract)
    requireCurrent(epoch, signal)
    if (!flight) {
      if (result.kind === 'none') publish({ view: null })
      else show(result.record, saved.registration, result.kind)
    }
    return result
  }
  const bind = () => {
    const next = sessionIdentity()
    if (identity !== next) {
      cancel()
      void stopObservation()
      identity = next
      publish({ view: null, hardwarePhase: 'idle', error: '', completion: null })
    }
    if (consumers && identity && !task) {
      const account = vaultAccountRuntime(session.getSnapshot().account!.status)
      account.ledgerPayments = owner
      task = account.maintenance.observe('ledger-payment', read, { intervalMs: 20_000 })
      task.request()
    }
  }
  const run = <T>(
    kind: NonNullable<LedgerPaymentsSnapshot['pending']>,
    key: string,
    work: (check: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (flight) {
      if (!flight.abort.signal.aborted && flight.key === key) return flight.promise as Promise<T>
      return Promise.reject(new Error('Finish the current Savings approval before continuing.'))
    }
    const abort = new AbortController()
    const epoch = ++generation
    const current = { kind, key, abort, promise: Promise.resolve() as Promise<unknown> }
    const check = () => requireCurrent(epoch, abort.signal)
    publish({ pending: kind, error: '' })
    current.promise = (async () => {
      check()
      return work(check, abort.signal)
    })()
      .catch((error) => {
        if (epoch === generation && !abort.signal.aborted) publish({ error: humanizeVaultError(error) })
        throw error
      })
      .finally(() => {
        if (flight === current) {
          flight = undefined
          publish({ pending: null })
        }
      })
    flight = current
    return current.promise as Promise<T>
  }

  const owner = {
    clearError: () => publish({ error: '' }),
    consumeCompletion(id: number) {
      const completed = snapshot.completion
      if (completed?.id !== id) return null
      publish({ completion: null })
      return completed
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    retain() {
      consumers++
      if (consumers === 1) {
        unsubscribe = session.subscribe(bind)
        bind()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        consumers--
        queueMicrotask(() => {
          if (consumers) return
          unsubscribe?.()
          unsubscribe = undefined
          void owner.suspend()
        })
      }
    },
    async suspend() {
      cancel()
      const pending = flight?.promise
      const observation = stopObservation()
      publish({ view: null, hardwarePhase: 'idle', error: '', completion: null })
      await Promise.all([observation, pending?.catch(() => undefined)])
    },
    refresh() {
      return task?.refresh() || Promise.reject(new Error('Unlock this Ledger vault before refreshing Savings.'))
    },
    cancelReview() {
      if (flight?.kind === 'review') cancel()
    },
    cancelHardware() {
      if (flight?.kind === 'hardware' && ['connecting', 'approving'].includes(snapshot.hardwarePhase)) cancel()
    },
    review(draft: SavingsPaymentDraft) {
      draft = structuredClone(draft)
      return run('review', JSON.stringify(['review', draft]), async (check) => {
        const saved = access()
        const retained = await loadLedgerSavingsPayment(saved.contract)
        check()
        if (
          retained &&
          retained.payment.destAddress === draft.address &&
          retained.payment.amountSats === draft.amount
        ) {
          const result = await reconcileLedgerSavingsPayment(saved.contract)
          check()
          if (result.kind === 'none' || result.record.candidateId !== retained.candidateId)
            throw new Error('The saved Savings payment changed. Review it again.')
          if (!['broadcast', 'confirmed', 'conflicted'].includes(result.kind)) {
            show(result.record, saved.registration, result.kind)
            return snapshot.view!
          }
        }
        if (retained?.phase === 'prepared') {
          await cancelLedgerSavingsPayment(saved.contract, retained.candidateId)
          check()
        }
        const fees = await fetchFeeEstimates()
        check()
        const quote = await quoteLedgerSavingsPayment({
          contract: saved.contract,
          destAddress: draft.address,
          amountSats: draft.amount,
          feeRate: Math.max(1, satPerVFromFeeEstimates(fees)),
        })
        check()
        const record = await retainLedgerSavingsPayment(quote.payment)
        check()
        show(record, saved.registration, 'prepared')
        publish({ hardwarePhase: 'idle' })
        return snapshot.view!
      })
    },
    approve(draft: SavingsPaymentDraft) {
      draft = structuredClone(draft)
      return run('phone', JSON.stringify(['phone', draft]), async (check, signal) => {
        const saved = access()
        let record = await loadLedgerSavingsPayment(saved.contract)
        check()
        if (
          !record ||
          record.payment.destAddress !== draft.address ||
          record.payment.amountSats !== draft.amount ||
          record.payment.feeSats !== draft.fee
        )
          throw new Error('Review this Savings payment again.')
        const result = await reconcileLedgerSavingsPayment(saved.contract)
        check()
        if (result.kind === 'none' || result.record.candidateId !== record.candidateId)
          throw new Error('The saved Savings payment changed. Review it again.')
        record = result.record
        if (result.kind === 'conflicted')
          throw new Error('This payment was replaced by a confirmed transaction. Review a new payment.')
        if (result.kind === 'broadcast' || result.kind === 'confirmed') {
          complete(record, record.candidateId)
          return null
        }
        if (record.txHex) {
          const txid = await broadcastLedgerSavingsPayment(saved.contract, record.candidateId)
          check()
          complete(record, txid)
          return null
        }
        record = await markLedgerSavingsSigning(saved.contract, record.candidateId)
        check()
        if (!record.phonePsbt) {
          const seed = await unlockLedgerSavingsSeed(saved.enrollment, saved.status, signal)
          try {
            check()
            const signed = signLedgerSavingsSeed(record.payment, seed)
            record = await saveLedgerSavingsPhoneApproval(saved.contract, record.candidateId, signed)
          } finally {
            seed.fill(0)
          }
          check()
        }
        show(record, saved.registration, 'signing')
        publish({ hardwarePhase: 'idle' })
        return snapshot.view!
      })
    },
    approveWithLedger(candidateId: string) {
      return run('hardware', `hardware:${candidateId}`, async (check, signal) => {
        const saved = access()
        let record = snapshot.view?.record
        if (!record || record.candidateId !== candidateId || !record.phonePsbt || record.txHex)
          throw new Error('Reopen the saved Savings payment before approving on Ledger.')
        publish({ hardwarePhase: 'connecting' })
        let saving = false
        try {
          return await approveLedgerPayment(
            record.payment,
            record.phonePsbt,
            saved.registration,
            signal,
            async () => {
              const retained = await loadLedgerSavingsPayment(saved.contract)
              check()
              if (
                !retained ||
                retained.candidateId !== candidateId ||
                retained.phonePsbt !== record!.phonePsbt ||
                retained.txHex
              )
                throw new Error('The saved Savings payment changed. Reopen it before approving on Ledger.')
              record = retained
              check()
              publish({ hardwarePhase: 'approving' })
            },
            async (signed) => {
              check()
              saving = true
              publish({ hardwarePhase: 'saving' })
              record = await saveLedgerSavingsSigned(saved.contract, candidateId, signed)
              check()
              show(record, saved.registration, 'unknown')
              // Both signatures are durable before dispatch; observation never broadcasts.
              const txid = await broadcastLedgerSavingsPayment(saved.contract, candidateId)
              check()
              publish({ hardwarePhase: 'complete' })
              complete(record, txid)
              return txid
            },
          )
        } catch (error) {
          if (!signal.aborted && identity === sessionIdentity()) publish({ hardwarePhase: saving ? 'check' : 'idle' })
          throw error
        }
      })
    },
    reopen(candidateId: string) {
      return run('reopen', `reopen:${candidateId}`, async (check) => {
        const saved = access()
        const result = await reconcileLedgerSavingsPayment(saved.contract)
        check()
        if (result.kind === 'none' || result.record.candidateId !== candidateId)
          throw new Error('This Savings payment changed. Refresh the wallet before continuing.')
        show(result.record, saved.registration, result.kind)
        publish({ hardwarePhase: 'idle' })
        return snapshot.view!
      })
    },
  }
  return owner
}
export type LedgerPayments = ReturnType<typeof createLedgerPayments>
