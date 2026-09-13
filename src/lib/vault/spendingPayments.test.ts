import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction } from '@arkade-os/sdk'
import { spendingPaymentsForSession, type SpendingPayments } from './spendingPayments'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime } from './accountRuntime'
import type { VaultSessionSnapshot } from './session'
import type { AdmittedAccount } from './admittedAccount'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import { MUTINYNET_INVOICE, MUTINYNET_INVOICE_TIMESTAMP, refundAddress } from './lightningTestUtils'
import { decodeVaultLightningInvoice } from './lightningInvoice'
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
  settle: vi.fn(),
  acknowledge: vi.fn(),
  snapshot: vi.fn(),
  lightningRepo: vi.fn(),
  lightningJournal: vi.fn(),
  coverage: vi.fn(),
}))
const fate = vi.hoisted(() => ({ checkpointTxid: '', checkpointPsbt: '', arkTxId: undefined as string | undefined }))
vi.mock('@arkade-os/sdk', async (original) => {
  const actual = await original<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestIndexerProvider: class {
      constructor(...args: unknown[]) {
        void args
      }
      getVtxos = async () => ({
        vtxos: [
          {
            txid: 'ee'.repeat(32),
            vout: 0,
            spentBy: fate.checkpointTxid,
            ...(fate.arkTxId ? { arkTxId: fate.arkTxId } : {}),
          },
        ],
      })
      getVirtualTxs = async () => ({ txs: [fate.checkpointPsbt] })
    },
  }
})
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
  acknowledgeSettledVtxoSpends: api.settle,
  acknowledgeSpendingVtxoRecovery: api.acknowledge,
  createVtxoSpendUnlocker: (_e: unknown, _s: unknown, _d: unknown, _u: unknown, signal?: AbortSignal) => ({
    unlock: () => {
      signal?.throwIfAborted()
      return api.unlock(signal)
    },
    dispose: api.dispose,
  }),
}))
vi.mock('./vtxo/walletWorker', () => ({
  ensureVaultWalletWorker: api.ensure,
  fetchVaultWalletVtxoSnapshot: api.snapshot,
}))
vi.mock('./recovery/committedCoverage', () => ({
  readCommittedRecoveryEvidence: async (...args: unknown[]) => {
    const lightningJournal = await api.lightningJournal(...args)
    const coverage = await api.coverage(...args)
    if (!lightningJournal && !coverage) return null
    return { coverage, matureBoardingJournal: null, lightningJournal }
  },
  readCommittedRecoveryCoverage: (...args: unknown[]) => api.coverage(...args),
}))
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
  withVaultLightningRepository: async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
    api.lightningRepo(_id, run),
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
  api.settle.mockResolvedValue(0)
  api.acknowledge.mockResolvedValue(false)
  api.snapshot.mockResolvedValue({ history: [] })
  api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) => run({}))
  api.lightningJournal.mockResolvedValue(null)
  api.coverage.mockResolvedValue(null)
  const checkpoint = new Transaction({ version: 2 })
  checkpoint.addInput({ txid: 'dd'.repeat(32), index: 0 })
  checkpoint.addOutput({ amount: 2125n, script: hex.decode('ab'.repeat(34)) })
  fate.checkpointTxid = checkpoint.id
  fate.checkpointPsbt = base64.encode(checkpoint.toPSBT())
  fate.arkTxId = undefined
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
it('settles finalized operations before review without failing on evidence lag', async () => {
  const { payments } = open()
  api.settle.mockRejectedValueOnce(new Error('coverage syncing'))
  await payments.review(draft)
  expect(api.settle).toHaveBeenCalledTimes(1)
  expect(api.settle.mock.calls[0][0]).toMatchObject({ vaultId: status.vaultId })
})
it('delegates recovery acknowledgment, coalesces identical commands and drains before teardown', async () => {
  const { payments } = open()
  const watching = deferred<boolean>()
  api.acknowledge.mockReturnValueOnce(watching.promise)
  const first = payments.acknowledgeRecovery(quote.operationId)
  expect(payments.acknowledgeRecovery(quote.operationId)).toBe(first)
  watching.resolve(true)
  await expect(first).resolves.toBe(true)
  expect(api.acknowledge).toHaveBeenCalledTimes(1)
  expect(api.acknowledge.mock.calls[0][0]).toMatchObject({ vaultId: status.vaultId })
  expect(api.acknowledge.mock.calls[0][1]).toBe(quote.operationId)
  const gated = deferred<boolean>()
  api.acknowledge.mockReturnValueOnce(gated.promise)
  const pending = payments.acknowledgeRecovery(quote.operationId)
  const suspended = payments.suspend()
  gated.resolve(false)
  await expect(pending).resolves.toBe(false)
  await suspended
  expect(payments.getSnapshot().pending).toBe(null)
})
it('opens a retired operation as finished after owner acknowledgment', async () => {
  const { payments } = open()
  api.acknowledge.mockResolvedValueOnce(true)
  await expect(payments.openPending(quote.operationId)).rejects.toThrow('already finished')
  expect(api.acknowledge).toHaveBeenCalledTimes(1)
})

it('retires settled operations with committed recovery evidence', async () => {
  const { payments } = open()
  const coverage = {
    vaultId: status.vaultId,
    network: status.network,
    descriptorHash: 'aa'.repeat(32),
    fileDigest: 'bb'.repeat(32),
    outputs: [],
  }
  api.settle.mockResolvedValueOnce(2)
  await payments.acknowledgeSettledRecovery(coverage)
  expect(api.settle).toHaveBeenCalledTimes(1)
  expect(api.settle.mock.calls[0][0]).toMatchObject({ vaultId: status.vaultId })
  expect(api.settle.mock.calls[0][1]).toMatchObject({ fileDigest: coverage.fileDigest })
})

it('sweeps funded Lightning terminals through the one committed file snapshot', async () => {
  const { payments } = open()
  const coverage = {
    vaultId: status.vaultId,
    network: status.network,
    descriptorHash: 'aa'.repeat(32),
    fileDigest: 'bb'.repeat(32),
    outputs: [],
  }
  const rfqId = '44'.repeat(32)
  api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
    run({
      getAllRfqSwaps: async () => [
        { kind: 'lightning_send', state: 'settled', rfqId, fundingArkTxid: 'ab'.repeat(32) },
      ],
      getRfqSwap: async () => null,
    }),
  )
  api.coverage.mockResolvedValue(coverage)
  const restoreLock = installImmediateLock()
  try {
    await payments.acknowledgeSettledRecovery(coverage)
  } finally {
    restoreLock()
  }
  expect(api.settle).toHaveBeenCalledTimes(1)
  expect(api.snapshot).toHaveBeenCalledTimes(1)
  expect(api.lightningJournal).toHaveBeenCalledTimes(1)
})

it('skips the committed evidence read when no funded Lightning terminal awaits retirement', async () => {
  const { payments } = open()
  api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
    run({ getAllRfqSwaps: async () => [] }),
  )
  await payments.acknowledgeSettledRecovery({
    vaultId: status.vaultId,
    network: status.network,
    descriptorHash: 'aa'.repeat(32),
    fileDigest: 'bb'.repeat(32),
    outputs: [],
  })
  expect(api.settle).toHaveBeenCalledTimes(1)
  expect(api.snapshot).not.toHaveBeenCalled()
  expect(api.lightningJournal).not.toHaveBeenCalled()
})

it('does not acknowledge settled operations from a replaced session', async () => {
  const { payments, update } = open()
  update({
    account: {
      savings: 'absent',
      status: { ...status, vaultId: 'other-vault' },
      enrollment,
    } as unknown as AdmittedAccount,
  })
  await payments.acknowledgeSettledRecovery({
    vaultId: status.vaultId,
    network: status.network,
    descriptorHash: 'aa'.repeat(32),
    fileDigest: 'bb'.repeat(32),
    outputs: [],
  })
  expect(api.settle).not.toHaveBeenCalled()
})

it('ignores committed evidence for another network', async () => {
  const { payments } = open()
  await payments.acknowledgeSettledRecovery({
    vaultId: status.vaultId,
    network: 'mainnet',
    descriptorHash: 'aa'.repeat(32),
    fileDigest: 'bb'.repeat(32),
    outputs: [],
  })
  expect(api.settle).not.toHaveBeenCalled()
})
function installImmediateLock() {
  const original = (navigator as Navigator & { locks?: unknown }).locks
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({}),
    },
  })
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', { configurable: true, value: original })
    else Reflect.deleteProperty(navigator, 'locks')
  }
}

function memoryLightningRepo(initial: { rfqId: string }[]) {
  const records = new Map(initial.map((record) => [record.rfqId, record]))
  return {
    getRfqSwap: async (id: string) => records.get(id),
    getAllRfqSwaps: async () => [...records.values()],
    saveRfqSwap: async (record: { rfqId: string }) => {
      records.set(record.rfqId, record)
    },
    removeRfqSwap: async (id: string) => {
      records.delete(id)
    },
  }
}

async function fundedLightningRecord(state: 'settled' | 'refunded') {
  const rfqId = 'ab'.repeat(32)
  const fundingArkTxid = 'bb'.repeat(32)
  const invoice = decodeVaultLightningInvoice(MUTINYNET_INVOICE, 'mutinynet', 0)
  const lockupAddress = await refundAddress('mutinynet')
  const record = {
    rfqId,
    kind: 'lightning_send',
    state,
    createdAt: 1,
    updatedAt: 2,
    amount: invoice.amountSats,
    lockupAddress,
    fundingArkTxid,
    ...(state === 'refunded' ? { refundArkTxid: 'cc'.repeat(32) } : {}),
    profile: {
      hashlock: { paymentHash: 'cc'.repeat(32) },
      vaultLightning: {
        version: 2,
        network: 'mutinynet',
        invoice: MUTINYNET_INVOICE,
        fundingState: 'funding',
        fundingProof: {
          rfqId,
          operationId: '11'.repeat(16),
          bundleDigest: 'aa'.repeat(32),
          address: lockupAddress,
          amountSats: invoice.amountSats,
          fundingFeeSats: 25,
        },
        quote: {
          v: 1,
          type: 'rfq_quote',
          rfq_id: rfqId,
          pair: 'arkade:BTC->lightning:BTC',
          amount_side: 'to',
          from_amount: invoice.amountSats,
          to_amount: invoice.amountSats,
          solver_pubkey: '03'.repeat(33),
          valid_until: MUTINYNET_INVOICE_TIMESTAMP + 600,
          refund_locktime: 1000,
          profile: { receiver_pk_script: 'ab'.repeat(34), lockup_address: lockupAddress },
        },
      },
    },
  }
  return { record: record as never, fundingArkTxid }
}

function lightningCoverage() {
  return {
    vaultId: status.vaultId,
    network: 'mutinynet',
    descriptorHash: 'descriptor',
    fileDigest: 'digest',
    outputs: [],
  } as never
}

it('settles funded Lightning terminals before review without failing on evidence lag', async () => {
  const restoreLock = installImmediateLock()
  try {
    const { payments } = open()
    const { record, fundingArkTxid } = await fundedLightningRecord('settled')
    const repository = memoryLightningRepo([record])
    api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
      run(repository),
    )
    api.snapshot.mockResolvedValue({
      history: [{ account: 'spend', type: 'sent', txid: fundingArkTxid, amount: 1500 }],
    })
    api.coverage.mockResolvedValue(lightningCoverage())
    api.lightningJournal.mockResolvedValue({ entries: [{ record }] })
    await payments.review(draft)
    expect(await repository.getRfqSwap((record as { rfqId: string }).rfqId)).toBeUndefined()
    expect(api.snapshot).toHaveBeenCalled()
    api.coverage.mockResolvedValue(null)
    const lagging = await fundedLightningRecord('settled')
    const pending = memoryLightningRepo([lagging.record])
    api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
      run(pending),
    )
    api.lightningJournal.mockResolvedValue({ entries: [{ record: lagging.record }] })
    await payments.review(draft)
    expect(await pending.getRfqSwap((lagging.record as { rfqId: string }).rfqId)).not.toBeUndefined()
  } finally {
    restoreLock()
  }
})
it('delegates Lightning recovery acknowledgment, coalesces identical commands and drains before teardown', async () => {
  const restoreLock = installImmediateLock()
  try {
    const { payments } = open()
    const { record, fundingArkTxid } = await fundedLightningRecord('settled')
    const repository = memoryLightningRepo([record])
    api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
      run(repository),
    )
    api.snapshot.mockResolvedValue({
      history: [{ account: 'spend', type: 'sent', txid: fundingArkTxid, amount: 1500 }],
    })
    const coverage = lightningCoverage()
    api.coverage.mockResolvedValue(coverage)
    const watching = deferred<{ entries: { record: unknown }[] }>()
    api.lightningJournal.mockReturnValueOnce(watching.promise)
    const first = payments.acknowledgeLightningRecovery((record as { rfqId: string }).rfqId, coverage)
    expect(payments.acknowledgeLightningRecovery((record as { rfqId: string }).rfqId, coverage)).toBe(first)
    watching.resolve({ entries: [{ record }] })
    await expect(first).resolves.toBe(true)
    expect(await repository.getRfqSwap((record as { rfqId: string }).rfqId)).toBeUndefined()
    const lagging = await fundedLightningRecord('settled')
    const pending = memoryLightningRepo([lagging.record])
    api.lightningRepo.mockImplementation(async (_id: string, run: (repository: unknown) => Promise<unknown>) =>
      run(pending),
    )
    const holding = deferred<{ entries: { record: unknown }[] }>()
    api.lightningJournal.mockReturnValueOnce(holding.promise)
    api.coverage.mockResolvedValueOnce(null)
    const gated = payments.acknowledgeLightningRecovery((lagging.record as { rfqId: string }).rfqId, coverage)
    const suspended = payments.suspend()
    holding.resolve({ entries: [{ record: lagging.record }] })
    await expect(gated).rejects.toThrow()
    await suspended
    expect(payments.getSnapshot().pending).toBe(null)
    expect(await pending.getRfqSwap((lagging.record as { rfqId: string }).rfqId)).not.toBeUndefined()
  } finally {
    restoreLock()
  }
})
