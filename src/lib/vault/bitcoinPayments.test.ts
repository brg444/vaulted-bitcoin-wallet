import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Address, TEST_NETWORK } from '@scure/btc-signer'
import { bitcoinPaymentsForSession, type BitcoinPayments } from './bitcoinPayments'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime } from './accountRuntime'
import type { VaultSessionSnapshot } from './session'
import type { BitcoinPaymentJournal, SpendingBitcoinPlan } from './spendingBitcoinStore'
import { SPENDING_ONLY_TEMPLATE } from './spendingEnrollment'

const api = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), check: vi.fn(), cancel: vi.fn(), acknowledge: vi.fn() }))
vi.mock('./spendingBitcoinStore', () => ({ readSpendingBitcoin: api.read, BITCOIN_PAYMENT_EVENT: 'bitcoin-journal' }))
vi.mock('./spendingBitcoinFunding', () => ({
  sendSpendingToBitcoin: api.send,
  checkSpendingBitcoin: api.check,
  cancelSpendingBitcoin: api.cancel,
  acknowledgeSpendingBitcoinRecovery: api.acknowledge,
}))
const status = {
  vaultId: 'bitcoin-vault',
  network: 'mutinynet',
  enrolled: true,
  templateVersion: SPENDING_ONLY_TEMPLATE,
}
const enrollment = { vaultId: status.vaultId, credId: 'aa' }
const address = Address(TEST_NETWORK).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(0x43) })
const draft = { address, amount: 1500, fee: 0 }
const plan = { operationId: 'same-operation', feeSats: 400 } as SpendingBitcoinPlan
const coverage = {
  vaultId: status.vaultId,
  network: status.network,
  descriptorHash: 'aa',
  fileDigest: 'bb',
  outputs: [],
}
let journal: BitcoinPaymentJournal | null
let accepted: boolean | undefined
const owners: BitcoinPayments[] = []
const releases: (() => void)[] = []
function open(locked = false) {
  let snapshot = { status, enrollment, locked } as VaultSessionSnapshot
  const listeners = new Set<() => void>()
  const session = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const payments = bitcoinPaymentsForSession(session)
  owners.push(payments)
  releases.push(payments.retain())
  return {
    payments,
    session,
    update(change: Partial<VaultSessionSnapshot>) {
      snapshot = { ...snapshot, ...change }
      for (const listener of listeners) listener()
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function settled(payments: BitcoinPayments) {
  await vi.waitFor(() => expect(payments.getSnapshot().pending).toBeNull())
}
beforeEach(() => {
  vi.resetAllMocks()
  journal = null
  accepted = undefined
  api.read.mockImplementation(() => structuredClone(journal))
  api.acknowledge.mockResolvedValue(false)
  api.check.mockResolvedValue({ state: 'uncertain' })
  api.send.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
    journal = { operationId: plan.operationId, stage: 'prepared', plan: { plan } } as BitcoinPaymentJournal
    accepted = await approve(plan)
    return accepted ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) } : { state: 'cancelled' }
  })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const owner of owners.splice(0)) await owner.suspend()
  const account = activeVaultAccountRuntime(status.vaultId)
  if (account) await disposeVaultAccountRuntime(account)
})
it('owns one immutable review and consumes completion without retiring the saved operation', async () => {
  const { payments } = open()
  const reviewing = payments.review(draft)
  expect(payments.review({ ...draft })).toBe(reviewing)
  const view = await reviewing
  expect(view).toBe(payments.getSnapshot().review)
  expect(api.send).toHaveBeenCalledOnce()
  expect(Object.isFrozen(view!.payment)).toBe(true)
  payments.approve(view!.payment)
  payments.approve(view!.payment)
  await settled(payments)
  expect(accepted).toBe(true)
  expect(payments.getSnapshot().error).toBe('')
  const completion = payments.getSnapshot().completion!
  expect(completion.payment).toEqual({ ...draft, fee: 400 })
  expect(payments.consumeCompletion(completion.id)).toBe(completion)
  expect(payments.consumeCompletion(completion.id)).toBeNull()
  expect(journal?.operationId).toBe(plan.operationId)
})
it.each(['cancel', 'lock', 'replace', 'dispose'])(
  'rejects a prepared approval after %s without publishing success',
  async (change) => {
    const { payments, update } = open()
    await payments.review(draft)
    if (change === 'cancel') payments.cancelReview()
    if (change === 'lock') update({ locked: true })
    if (change === 'replace') update({ enrollment: { ...enrollment, credId: 'bb' } as never })
    if (change === 'dispose') await disposeVaultAccountRuntime(activeVaultAccountRuntime(status.vaultId)!)
    await settled(payments)
    expect(accepted).toBe(false)
    expect(payments.getSnapshot().completion).toBeNull()
    expect(payments.getSnapshot().review).toBeNull()
  },
)
it.each(['address', 'amount', 'fee', 'journal'])('refuses an altered %s before accepting review', async (field) => {
  const { payments } = open()
  const view = (await payments.review(draft))!
  const changed = { ...view.payment }
  if (field === 'address') changed.address += 'different'
  if (field === 'amount') changed.amount++
  if (field === 'fee') changed.fee++
  if (field === 'journal') journal = { ...journal!, plan: { ...journal!.plan!, plan: { ...plan, feeSats: 401 } } }
  payments.approve(changed)
  await settled(payments)
  expect(accepted).toBe(false)
  expect(payments.getSnapshot().error).toMatch(/changed/)
})
it('cancels a late prepared result and keeps stale errors out of a locked session', async () => {
  const later = deferred<void>()
  let signal!: AbortSignal
  api.send.mockImplementation(async (_e, _s, _o, approve, _p, scope) => {
    signal = scope
    await later.promise
    accepted = await approve(plan)
    throw new Error('old failure')
  })
  const { payments, update } = open()
  const review = payments.review(draft)
  update({ locked: true })
  expect(signal.aborted).toBe(true)
  later.resolve()
  expect(await review).toBeNull()
  await settled(payments)
  expect(accepted).toBe(false)
  expect(payments.getSnapshot().error).toBe('')
})
it('drains an accepted submission before account close and suppresses a late completion', async () => {
  const later = deferred<void>()
  const original = api.send.getMockImplementation()!
  api.send.mockImplementation(async (...args) => {
    const result = await original(...args)
    await later.promise
    return result
  })
  const { payments } = open()
  const view = (await payments.review(draft))!
  payments.approve(view.payment)
  const account = activeVaultAccountRuntime(status.vaultId)!
  const close = vi.fn(async () => undefined)
  account.closeConnection = close
  const drain = disposeVaultAccountRuntime(account)
  await Promise.resolve()
  expect(close).not.toHaveBeenCalled()
  later.resolve()
  await drain
  expect(close).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().completion).toBeNull()
})
it('retains an uncertain accepted operation and produces one pending completion', async () => {
  api.send.mockImplementation(async (_e, _s, _o, approve) => {
    journal = { operationId: plan.operationId, stage: 'prepared' } as BitcoinPaymentJournal
    expect(await approve(plan)).toBe(true)
    throw new Error('Lost final response')
  })
  const { payments } = open()
  const view = (await payments.review(draft))!
  payments.approve(view.payment)
  await settled(payments)
  expect(payments.getSnapshot().completion).toMatchObject({ txid: null, payment: { ...draft, fee: 400 } })
  expect(journal?.operationId).toBe(plan.operationId)
  expect(payments.getSnapshot().error).toBe('Something went wrong. Try again.')
})
it('coalesces manual status commands and binds cancellation to the selected operation', async () => {
  const { payments } = open()
  const later = deferred<{ state: string }>()
  api.check.mockReturnValue(later.promise)
  const first = payments.check('selected')
  expect(payments.check('selected')).toBe(first)
  await expect(payments.cancel('selected')).rejects.toThrow('Finish')
  expect(api.check).toHaveBeenCalledWith(status, { operationId: 'selected', signal: expect.any(AbortSignal) })
  later.resolve({ state: 'released' })
  await first
  expect(payments.getSnapshot().notice?.operationId).toBe('selected')
  api.cancel.mockResolvedValue({ state: 'uncertain' })
  await payments.cancel('selected')
  expect(api.cancel).toHaveBeenCalledWith(status, { operationId: 'selected', signal: expect.any(AbortSignal) })
  expect(payments.getSnapshot().notice?.message).toContain('remain reserved')
})
it('resumes confirmed acknowledgment from one observer shared by multiple consumers', async () => {
  journal = { operationId: plan.operationId, stage: 'confirmed' } as BitcoinPaymentJournal
  api.acknowledge.mockImplementation(async () => {
    journal = null
    return true
  })
  const { payments, session } = open()
  const second = bitcoinPaymentsForSession(session)
  expect(second).toBe(payments)
  const release = second.retain()
  await vi.waitFor(() => expect(api.acknowledge).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(payments.getSnapshot().operation).toBeNull())
  expect(api.check).not.toHaveBeenCalled()
  release()
})
it.each(['lock', 'unmount'])('does not begin acknowledgment after %s during reconciliation', async (change) => {
  journal = { operationId: plan.operationId, stage: 'submitted' } as BitcoinPaymentJournal
  const later = deferred<void>()
  api.check.mockReturnValue(later.promise)
  const { payments, update } = open()
  await vi.waitFor(() => expect(api.check).toHaveBeenCalledOnce())
  if (change === 'lock') update({ locked: true })
  else releases.pop()!()
  later.resolve()
  await payments.suspend()
  expect(api.acknowledge).not.toHaveBeenCalled()
})
it('keeps failed acknowledgment resumable without failing a completed backup', async () => {
  journal = { operationId: plan.operationId, stage: 'confirmed' } as BitcoinPaymentJournal
  api.acknowledge.mockRejectedValue(new Error('History unavailable'))
  const { payments } = open()
  await vi.waitFor(() => expect(api.acknowledge).toHaveBeenCalledOnce())
  await payments.acknowledgeRecovery(coverage)
  expect(payments.getSnapshot().operation?.operationId).toBe(plan.operationId)
  api.acknowledge.mockImplementation(async () => {
    journal = null
    return true
  })
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(payments.getSnapshot().operation).toBeNull())
})
it('rejects recovery evidence for another account or a locked session', async () => {
  const { payments, update } = open()
  await payments.acknowledgeRecovery({ ...coverage, vaultId: 'other' })
  await payments.acknowledgeRecovery({ ...coverage, network: 'mainnet' })
  update({ locked: true })
  await payments.acknowledgeRecovery(coverage)
  expect(api.acknowledge).not.toHaveBeenCalled()
})
