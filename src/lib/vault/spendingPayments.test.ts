import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spendingPaymentsForSession, type SpendingPayments } from './spendingPayments'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime } from './accountRuntime'
import type { VaultSessionSnapshot } from './session'
import type { AdmittedAccount } from './admittedAccount'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import { MUTINYNET_INVOICE, MUTINYNET_INVOICE_TIMESTAMP } from './lightningTestUtils'
import { MUTINYNET_LIGHTNING_SOLVER } from './lightningConfig'
import { SPENDING_PAYMENT_EVENT } from './vtxo/spendingJournal'
import { VtxoReceiptPendingError, VtxoReservedReplaceError } from './vtxo/spendingErrors'
import { type PersistedVtxoSpend } from './vtxo/spendingTransaction'
import { type VaultVtxoSpendQuote } from './vtxo/spend'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  reserve: vi.fn(),
  send: vi.fn(),
  unlock: vi.fn(),
  unlockPhone: vi.fn(),
  dispose: vi.fn(),
  discover: vi.fn(),
  request: vi.fn(),
  sdk: vi.fn(),
  loadFunding: vi.fn(),
  resumeFunding: vi.fn(),
  beginFunding: vi.fn(),
  record: vi.fn(),
  current: vi.fn(),
  refundStatus: vi.fn(),
  ensure: vi.fn(),
}))
vi.mock('./vtxo/spendingJournal', async (original) => ({
  ...(await original<typeof import('./vtxo/spendingJournal')>()),
  listPersistedVtxoSpends: api.list,
  loadPersistedVtxoSpend: (vault: string) => api.list(vault).at(-1),
  loadPersistedVtxoSpendById: (vault: string, id: string) =>
    api.list(vault).find((record: PersistedVtxoSpend) => record.operationId === id),
}))
vi.mock('./vtxo/spend', async (original) => ({
  ...(await original<typeof import('./vtxo/spend')>()),
  quoteFromPersistedVtxoSpend: (record: PersistedVtxoSpend) => ({
    operationId: record.operationId,
    bundleDigest: record.bundleDigest,
    destAddress: record.destAddress,
    amountSats: record.amountSats,
    feeSats: record.feeSats,
  }),
  previewVaultVtxoSend: api.preview,
  reserveVaultVtxo: api.reserve,
  sendVaultVtxo: api.send,
  createVtxoSpendUnlocker: (_e: unknown, _s: unknown, _d: unknown, _u: unknown, signal?: AbortSignal) => ({
    unlock: () => {
      signal?.throwIfAborted()
      return api.unlock(signal)
    },
    dispose: api.dispose,
  }),
}))
vi.mock('./vtxo/walletWorker', () => ({ ensureVaultWalletWorker: api.ensure }))
vi.mock('./savingsSpend', () => ({ unlockPhoneBip340: api.unlockPhone }))
vi.mock('./lightningConfig', async (original) => ({
  ...(await original<typeof import('./lightningConfig')>()),
  vaultLightningSendEnabled: () => true,
  discoverVaultLightningSolver: api.discover,
}))
vi.mock('./lightning', () => ({
  requestVaultLightningQuote: api.request,
  withVaultLightningSdkWallet: api.sdk,
  withVaultLightningTransport: async (_p: unknown, run: (transport: unknown) => Promise<unknown>) => run({}),
  withVaultLightningRepository: async (_id: string, run: (repository: unknown) => Promise<unknown>) => run({}),
  withVaultLightningLifecycleLock: async (_id: string, run: () => Promise<unknown>) => run(),
  loadVaultLightningFundingQuote: api.loadFunding,
  resumeVaultLightningFunding: api.resumeFunding,
  beginVaultLightningFunding: api.beginFunding,
  recordVaultLightningFundingTxid: api.record,
  assertVaultLightningQuoteCurrent: api.current,
  getVaultLightningStatus: api.refundStatus,
  VaultLightningFundingNotStartedError: class extends Error {},
}))
const status = { ...sharedSpendingStatus(), vaultId: 'spending-owner' }
const enrollment = { vaultId: status.vaultId, credId: 'aa' }
const draft = { address: status.spendingArkAddress!, amount: 1500, fee: 0 }
const quote = {
  operationId: '11'.repeat(16),
  bundleDigest: '22'.repeat(32),
  destAddress: draft.address,
  amountSats: draft.amount,
  feeSats: 0,
} as VaultVtxoSpendQuote
const lightning = {
  kind: 'lightning',
  invoice: MUTINYNET_INVOICE,
  invoiceAmountSats: 1500,
  invoiceExpiresAt: MUTINYNET_INVOICE_TIMESTAMP + 3600,
  rfqId: '44'.repeat(32),
  fundAddress: draft.address,
  fundAmountSats: 1500,
  corridorFeeSats: 0,
  validUntil: MUTINYNET_INVOICE_TIMESTAMP + 600,
  refundLocktime: 1000,
}
const owners: SpendingPayments[] = []
const releases: (() => void)[] = []
let records: PersistedVtxoSpend[]
let funds: number
let phone: Uint8Array
function pending(stage: PersistedVtxoSpend['stage'] = 'authorized'): PersistedVtxoSpend {
  return { ...quote, vaultId: status.vaultId, arkTxid: 'ab'.repeat(32), stage } as PersistedVtxoSpend
}
function open() {
  let state = {
    account: { savings: 'absent', status, enrollment } as AdmittedAccount,
    locked: false,
    setup: { txCapSats: 100_000 },
  } as unknown as VaultSessionSnapshot
  const listeners = new Set<() => void>()
  const session = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const payments = spendingPaymentsForSession(session)
  owners.push(payments)
  releases.push(payments.retain())
  activeVaultAccountRuntime(status.vaultId)!.balances = {
    getSnapshot: () => ({ positions: { spending: { availableSats: funds } } }),
    dispose: () => {},
  } as never
  return {
    session,
    payments,
    update(change: Partial<VaultSessionSnapshot>) {
      state = { ...state, ...change }
      for (const listener of listeners) listener()
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime((MUTINYNET_INVOICE_TIMESTAMP + 30) * 1000)
  funds = 20_000
  phone = new Uint8Array(32).fill(7)
  records = []
  api.list.mockImplementation(() => structuredClone(records))
  api.preview.mockImplementation(async () => ({ ...quote, operationId: '', bundleDigest: '' }))
  api.reserve.mockImplementation(async () => {
    records = [pending('reserved')]
    return { ...quote }
  })
  api.send.mockResolvedValue({ txid: 'ab'.repeat(32), feeSats: 0 })
  api.unlock.mockResolvedValue({ phoneSecret: phone })
  api.unlockPhone.mockResolvedValue(phone)
  api.discover.mockResolvedValue(MUTINYNET_LIGHTNING_SOLVER)
  api.sdk.mockImplementation(async (_secret, _status, run) =>
    run({ wallet: {}, repository: {}, contracts: {}, manager: {} }),
  )
  api.request.mockResolvedValue(lightning)
  api.loadFunding.mockResolvedValue(null)
  api.resumeFunding.mockResolvedValue({ address: quote.destAddress, amountSats: quote.amountSats })
  api.refundStatus.mockResolvedValue({ state: 'refunded' })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const owner of owners.splice(0)) await owner.suspend()
  const account = activeVaultAccountRuntime(status.vaultId)
  if (account) await disposeVaultAccountRuntime(account)
  vi.useRealTimers()
})
it('shares one immutable review and coalesces repeated approval into one dispatch', async () => {
  const { payments, session } = open()
  expect(spendingPaymentsForSession(session)).toBe(payments)
  const reviewing = payments.review(draft)
  expect(payments.review({ ...draft })).toBe(reviewing)
  const view = await reviewing
  expect(Object.isFrozen(view.funding)).toBe(true)
  const first = payments.approve(view.payment)
  expect(payments.approve({ ...view.payment })).toBe(first)
  await first
  expect(api.unlock).toHaveBeenCalledOnce()
  expect(api.send).toHaveBeenCalledOnce()
  const event = payments.getSnapshot().event!
  expect(event).toMatchObject({ outcome: 'sent', payment: draft, txid: 'ab'.repeat(32) })
  expect(payments.consumeEvent(event.id)).toBe(event)
  expect(payments.consumeEvent(event.id)).toBeNull()
  expect(records[0].operationId).toBe(quote.operationId)
})
it.each(['address', 'amount', 'fee'] as const)('rejects changed %s before requesting a passkey', async (field) => {
  const { payments } = open()
  const review = await payments.review(draft)
  const changed = { ...review.payment, [field]: field === 'address' ? 'another-address' : review.payment[field] + 1 }
  await expect(payments.approve(changed)).rejects.toThrow('expired or changed')
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.send).not.toHaveBeenCalled()
})
it('requires another explicit approval after the authoritative reservation fee changes', async () => {
  api.reserve.mockResolvedValue({ ...quote, feeSats: 400 })
  api.send.mockResolvedValue({ txid: 'ab'.repeat(32), feeSats: 400 })
  const { payments } = open()
  const review = await payments.review(draft)
  await payments.approve(review.payment)
  expect(api.send).not.toHaveBeenCalled()
  const changed = payments.getSnapshot().review!
  expect(changed.payment.fee).toBe(400)
  expect(payments.getSnapshot().event?.outcome).toBe('fee-changed')
  await expect(payments.approve(review.payment)).rejects.toThrow('changed')
  const reopened = await payments.review({ ...draft, fee: 400 })
  // The second displayed fee is still obtained from the authoritative reservation.
  await payments.approve(reopened.payment)
  await payments.approve(payments.getSnapshot().review!.payment)
  expect(api.send).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().event?.payment.fee).toBe(400)
})
it.each(['cancel', 'lock', 'replace', 'dispose'])('discards a late preview after %s', async (action) => {
  const later = deferred<VaultVtxoSpendQuote>()
  api.preview.mockReturnValue(later.promise)
  const { payments, update } = open()
  const result = payments.review(draft)
  const rejected = expect(result).rejects.toThrow()
  let drain: Promise<void> | undefined
  if (action === 'cancel') payments.cancelReview()
  if (action === 'lock') update({ locked: true })
  if (action === 'replace')
    update({
      account: { savings: 'absent', status, enrollment: { ...enrollment, credId: 'bb' } } as unknown as AdmittedAccount,
    })
  if (action === 'dispose') drain = disposeVaultAccountRuntime(activeVaultAccountRuntime(status.vaultId)!)
  later.resolve(quote)
  await rejected
  await drain
  expect(payments.getSnapshot().review).toBeNull()
  expect(payments.getSnapshot().error).toBe('')
})
it('cancels a passkey approval before reservation and passes the same signal down', async () => {
  const later = deferred<{ phoneSecret: Uint8Array }>()
  api.unlock.mockReturnValue(later.promise)
  const { payments, update } = open()
  const view = await payments.review(draft)
  const result = payments.approve(view.payment)
  const rejected = expect(result).rejects.toThrow()
  const signal = api.unlock.mock.calls[0][0] as AbortSignal
  update({ locked: true })
  expect(signal.aborted).toBe(true)
  later.resolve({ phoneSecret: phone })
  await rejected
  expect(api.reserve).not.toHaveBeenCalled()
  expect(api.dispose).toHaveBeenCalled()
})
it('drains a dispatched payment before account close and suppresses late presentation', async () => {
  const later = deferred<{ txid: string; feeSats: number }>()
  api.send.mockReturnValue(later.promise)
  const { payments } = open()
  const view = await payments.review(draft)
  const result = payments.approve(view.payment)
  const rejected = expect(result).rejects.toThrow()
  await vi.waitFor(() => expect(api.send).toHaveBeenCalledOnce())
  const account = activeVaultAccountRuntime(status.vaultId)!
  const close = vi.fn(async () => {})
  account.closeConnection = close
  const drain = disposeVaultAccountRuntime(account)
  expect((api.send.mock.calls[0][4] as AbortSignal).aborted).toBe(true)
  await Promise.resolve()
  expect(close).not.toHaveBeenCalled()
  later.resolve({ txid: 'ab'.repeat(32), feeSats: 0 })
  await rejected
  await drain
  expect(close).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().event).toBeNull()
})
it('preserves pending identity after a lost response and reopens it without requiring available balance', async () => {
  api.send.mockImplementation(async () => {
    records = [pending()]
    throw new Error('lost response')
  })
  const { payments } = open()
  const review = await payments.review(draft)
  await expect(payments.approve(review.payment)).rejects.toThrow('pending')
  expect(payments.getSnapshot().pendingPayments).toMatchObject([{ operationId: quote.operationId, authorized: true }])
  funds = 0
  const opened = await payments.openPending(quote.operationId)
  expect(opened.review?.resuming).toBe(true)
  api.send.mockResolvedValue({ txid: 'ab'.repeat(32), feeSats: 0 })
  api.reserve.mockClear()
  await payments.approve(opened.payment)
  expect(api.reserve).not.toHaveBeenCalled()
  expect(api.send.mock.calls.at(-1)![2].operationId).toBe(quote.operationId)
})
it('treats a pending receipt as submitted without clearing the durable journal itself', async () => {
  api.send.mockImplementation(async () => {
    records = [pending('operator-finalized')]
    throw new VtxoReceiptPendingError('ab'.repeat(32), quote.operationId, 0)
  })
  const { payments } = open()
  const view = await payments.review(draft)
  await payments.approve(view.payment)
  expect(payments.getSnapshot().event?.outcome).toBe('sent')
  expect(records[0].operationId).toBe(quote.operationId)
})
it('invalidates an opened pre-reservation across lock and reauthentication even while both reviews are null', async () => {
  records = [pending('pre-reserve')]
  const { payments, update } = open()
  const previous = await payments.openPending(quote.operationId)
  expect(previous.review).toBeNull()
  expect(Object.isFrozen(previous.payment)).toBe(true)
  expect(payments.getSnapshot().opened).toBe(previous)
  update({ locked: true })
  update({ locked: false })
  expect(payments.getSnapshot().opened).toBeNull()
  expect(payments.getSnapshot().review).toBeNull()
  const next = await payments.openPending(quote.operationId)
  expect(next).not.toBe(previous)
  expect(payments.getSnapshot().opened).toBe(next)
  payments.cancelReview()
  expect(payments.getSnapshot().opened).toBeNull()
})
it('rejects pending-operation reopening if the account locks while its funding quote is loading', async () => {
  records = [pending('pre-reserve')]
  const later = deferred<null>()
  api.loadFunding.mockReturnValue(later.promise)
  const { payments, update } = open()
  const opening = payments.openPending(quote.operationId)
  const rejected = expect(opening).rejects.toThrow()
  await vi.waitFor(() => expect(api.loadFunding).toHaveBeenCalledOnce())
  update({ locked: true })
  update({ locked: false })
  later.resolve(null)
  await rejected
  expect(payments.getSnapshot().opened).toBeNull()
  expect(payments.getSnapshot().review).toBeNull()
})
it('keeps replacement approval bound to the offered reserved operation ids', async () => {
  records = [pending('reserved')]
  api.preview.mockRejectedValueOnce(new VtxoReservedReplaceError(quote.operationId))
  const { payments } = open()
  await expect(payments.review(draft)).rejects.toThrow()
  expect(payments.getSnapshot().canReplace).toBe(true)
  const view = await payments.review(draft, true)
  await payments.approve(view.payment)
  expect(api.reserve.mock.calls[0][4]).toMatchObject({ replaceExisting: true, replacementIds: [quote.operationId] })
})
it('observes journal changes once through shared consumers and removes its listener on release', () => {
  const { payments } = open()
  const release = payments.retain()
  const listener = vi.fn()
  payments.subscribe(listener)
  records = [pending()]
  window.dispatchEvent(new Event(SPENDING_PAYMENT_EVENT))
  window.dispatchEvent(new Event(SPENDING_PAYMENT_EVENT))
  expect(listener).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().pendingPayments[0].destination).toBe(draft.address)
  release()
})
it('uses one phone approval for Lightning quote and reservation, then records the funding transaction', async () => {
  const { payments } = open()
  const review = await payments.review({ address: MUTINYNET_INVOICE, amount: 0, fee: 0 })
  expect(api.unlockPhone).toHaveBeenCalledOnce()
  expect(api.reserve.mock.calls[0][4]).toMatchObject({ phoneSecret: phone, signal: expect.any(AbortSignal) })
  expect(phone.every((byte) => byte === 0)).toBe(true)
  await payments.approve(review.payment)
  expect(api.record).toHaveBeenCalledWith({}, lightning.rfqId, 'ab'.repeat(32))
  expect(payments.getSnapshot().event).toMatchObject({ outcome: 'sent', kind: 'lightning' })
})
it('stops Lightning quote acceptance after locking during solver discovery and wipes the phone key', async () => {
  const later = deferred<typeof MUTINYNET_LIGHTNING_SOLVER>()
  api.discover.mockReturnValue(later.promise)
  const { payments, update } = open()
  const result = payments.review({ address: MUTINYNET_INVOICE, amount: 0, fee: 0 })
  const rejected = expect(result).rejects.toThrow()
  await vi.waitFor(() => expect(api.discover).toHaveBeenCalled())
  update({ locked: true })
  later.resolve(MUTINYNET_LIGHTNING_SOLVER)
  await rejected
  expect(api.request).not.toHaveBeenCalled()
  expect(api.reserve).not.toHaveBeenCalled()
  expect(phone.every((byte) => byte === 0)).toBe(true)
})
it('rejects competing commands and coalesces an authenticated Lightning refund', async () => {
  const later = deferred<Uint8Array>()
  api.unlockPhone.mockReturnValue(later.promise)
  const { payments } = open()
  const refund = payments.retryRefund(lightning.rfqId)
  expect(payments.retryRefund(lightning.rfqId)).toBe(refund)
  await expect(payments.review(draft)).rejects.toThrow('Finish')
  later.resolve(phone)
  await refund
  expect(api.sdk.mock.calls[0][3]).toMatchObject({ refundRfqId: lightning.rfqId, signal: expect.any(AbortSignal) })
  expect(phone.every((byte) => byte === 0)).toBe(true)
})
