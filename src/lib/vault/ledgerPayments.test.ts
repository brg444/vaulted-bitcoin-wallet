import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import type { VaultSessionSnapshot } from './session'
import type { AdmittedAccount } from './admittedAccount'
import type { LedgerSavingsPaymentRecord } from './ledgerSavingsWallet'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { ledgerPaymentsForSession, type LedgerPayments } from './ledgerPayments'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime } from './accountRuntime'

const api = vi.hoisted(() => ({
  load: vi.fn(),
  reconcile: vi.fn(),
  retain: vi.fn(),
  quote: vi.fn(),
  mark: vi.fn(),
  unlock: vi.fn(),
  phone: vi.fn(),
  savePhone: vi.fn(),
  saveSigned: vi.fn(),
  broadcast: vi.fn(),
  cancel: vi.fn(),
  fee: vi.fn(),
  validate: vi.fn(),
  connect: vi.fn(),
  deviceSign: vi.fn(),
  close: vi.fn(),
}))
vi.mock('./ledgerClient', () => ({
  connectLedgerSavings: api.connect,
  signLedgerSavings: api.deviceSign,
  registerLedgerSavings: vi.fn(),
}))
vi.mock('./ledgerSavingsWallet', () => ({
  loadLedgerSavingsPayment: api.load,
  reconcileLedgerSavingsPayment: api.reconcile,
  retainLedgerSavingsPayment: api.retain,
  quoteLedgerSavingsPayment: api.quote,
  markLedgerSavingsSigning: api.mark,
  signLedgerSavingsSeed: api.phone,
  saveLedgerSavingsPhoneApproval: api.savePhone,
  saveLedgerSavingsSigned: api.saveSigned,
  broadcastLedgerSavingsPayment: api.broadcast,
  cancelLedgerSavingsPayment: api.cancel,
}))
vi.mock('./program/ledgerEnrollment', () => ({ validateLedgerSavingsEnrollmentSecrets: api.validate }))
vi.mock('./savingsSpend', () => ({ unlockLedgerSavingsSeed: api.unlock }))
vi.mock('./esplora', () => ({ fetchFeeEstimates: api.fee }))

const status = {
  enrolled: true,
  vaultId: 'vault-a',
  network: 'mutinynet',
  templateVersion: LEDGER_NATIVE_TEMPLATE,
  ledgerSavings: { descriptorHash: 'bound-a', context: { vaultId: 'vault-a' }, spendingPolicy: {} },
} as VaultStatus
const enrollment = {
  vaultId: 'vault-a',
  ledgerSavings: {
    contract: { context: status.ledgerSavings!.context, spendingPolicy: {} },
    registration: { walletId: 'registered-a' },
  },
} as EnrollmentSecrets
const draft = { address: 'reviewed-recipient', amount: 20000, fee: 212 }
let record: LedgerSavingsPaymentRecord
let seed: Uint8Array
beforeEach(() => {
  vi.resetAllMocks()
  record = {
    version: 1,
    candidateId: 'exact-tx',
    contextDigest: 'context',
    phase: 'prepared',
    payment: {
      contract: enrollment.ledgerSavings!.contract,
      coins: [],
      destAddress: draft.address,
      amountSats: draft.amount,
      feeSats: draft.fee,
    },
  }
  seed = new Uint8Array(32).fill(9)
  api.validate.mockImplementation((value) => value)
  api.load.mockImplementation(async () => structuredClone(record))
  api.reconcile.mockImplementation(async () => ({
    kind: record.phase === 'broadcast' ? 'broadcast' : 'signing',
    record: structuredClone(record),
  }))
  api.fee.mockResolvedValue({ '3': 1 })
  api.quote.mockImplementation(async () => ({ payment: record.payment }))
  api.retain.mockImplementation(async () => structuredClone(record))
  api.mark.mockImplementation(async () => {
    record.phase = 'signing'
    return structuredClone(record)
  })
  api.unlock.mockResolvedValue(seed)
  api.phone.mockReturnValue('phone-signature')
  api.savePhone.mockImplementation(async (_contract, _id, psbt) => {
    record.phonePsbt = psbt
    return structuredClone(record)
  })
  api.saveSigned.mockImplementation(async (_contract, _id, psbt) => {
    record.phase = 'signed'
    record.signedPsbt = psbt
    record.txHex = 'exact-bytes'
    return structuredClone(record)
  })
  api.broadcast.mockResolvedValue('exact-tx')
  api.connect.mockResolvedValue({ app: {}, close: api.close })
  api.close.mockResolvedValue(undefined)
  api.deviceSign.mockResolvedValue('ledger-signature')
})
const opened: LedgerPayments[] = []
const releases: (() => void)[] = []
function open(locked = false, selected = status) {
  let state = {
    account: { savings: 'ledger', status: selected, enrollment } as unknown as AdmittedAccount,
    locked,
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
  const payments = ledgerPaymentsForSession(session)
  opened.push(payments)
  releases.push(payments.retain())
  return {
    payments,
    session,
    update: (change: Partial<VaultSessionSnapshot>) => {
      state = { ...state, ...change }
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
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const payments of opened.splice(0)) await payments.suspend()
  const account = activeVaultAccountRuntime('vault-a')
  if (account) await disposeVaultAccountRuntime(account)
})

it('retains one phone approval and saves both signatures before hardware dispatch', async () => {
  const { payments } = open()
  expect(await payments.approve(draft)).toBe(payments.getSnapshot().view)
  expect(api.mark.mock.invocationCallOrder[0]).toBeLessThan(api.unlock.mock.invocationCallOrder[0])
  expect(api.savePhone).toHaveBeenCalledWith(enrollment.ledgerSavings!.contract, 'exact-tx', 'phone-signature')
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(payments.getSnapshot().view?.record.phonePsbt).toBe('phone-signature')
  expect(api.broadcast).not.toHaveBeenCalled()
  expect(await payments.approveWithLedger('exact-tx')).toBe('exact-tx')
  expect(api.saveSigned.mock.invocationCallOrder[0]).toBeLessThan(api.broadcast.mock.invocationCallOrder[0])
  expect(api.saveSigned.mock.invocationCallOrder[0]).toBeLessThan(api.close.mock.invocationCallOrder[0])
  expect(api.unlock).toHaveBeenCalledTimes(1)
  expect(payments.getSnapshot().completion?.payment).toEqual(draft)
})
it('resumes a saved phone approval without another passkey prompt', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'already-approved'
  const { payments } = open()
  expect(await payments.approve(draft)).toBe(payments.getSnapshot().view)
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.phone).not.toHaveBeenCalled()
  expect(payments.getSnapshot().view?.record.phonePsbt).toBe('already-approved')
})
it('rejects changed recipient, amount or fee before requesting either signature', async () => {
  const { payments } = open()
  for (const changed of [
    { ...draft, address: 'other' },
    { ...draft, amount: 1 },
    { ...draft, fee: 999 },
  ])
    await expect(payments.approve(changed)).rejects.toThrow(/Review/)
  expect(api.mark).not.toHaveBeenCalled()
  expect(api.unlock).not.toHaveBeenCalled()
})
it('wipes the unlocked seed when signing fails and never dispatches', async () => {
  api.phone.mockImplementation(() => {
    throw new Error('signing failed')
  })
  const { payments } = open()
  await expect(payments.approve(draft)).rejects.toThrow('signing failed')
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(api.savePhone).not.toHaveBeenCalled()
  expect(api.broadcast).not.toHaveBeenCalled()
})
it.each([false, true])('does not sign after locking during the passkey prompt, reopened=%s', async (reopen) => {
  const late = deferred<Uint8Array>()
  api.unlock.mockReturnValue(late.promise)
  const { payments, update } = open()
  const pending = payments.approve(draft)
  await vi.waitFor(() => expect(api.unlock).toHaveBeenCalledOnce())
  update({ locked: true })
  expect(api.unlock.mock.calls[0][2].aborted).toBe(true)
  if (reopen) update({ locked: false })
  late.resolve(seed)
  await expect(pending).rejects.toThrow(/active vault changed/)
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(api.phone).not.toHaveBeenCalled()
})
it('keeps both signatures after an uncertain submission and never retries during refresh', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'phone-signature'
  api.broadcast.mockRejectedValue(new Error('response lost'))
  api.reconcile.mockImplementation(async () => ({ kind: 'unknown', record: structuredClone(record) }))
  const { payments } = open()
  await payments.refresh()
  await expect(payments.approveWithLedger('exact-tx')).rejects.toThrow('response lost')
  await payments.refresh()
  await payments.refresh()
  expect(api.broadcast).toHaveBeenCalledTimes(1)
  expect(payments.getSnapshot().view?.record.txHex).toBe('exact-bytes')
  expect(payments.getSnapshot().view?.outcome).toBe('unknown')
  expect(payments.getSnapshot().hardwarePhase).toBe('check')
  expect(api.unlock).not.toHaveBeenCalled()
})
it('recognizes an observed payment without broadcasting or signing again', async () => {
  record.phase = 'broadcast'
  record.phonePsbt = 'phone'
  record.txHex = 'exact-bytes'
  const { payments } = open()
  expect(await payments.approve(draft)).toBeNull()
  expect(payments.getSnapshot().completion?.txid).toBe('exact-tx')
  expect(api.broadcast).not.toHaveBeenCalled()
  expect(api.unlock).not.toHaveBeenCalled()
})
it('consumes completion once without changing the durable payment', async () => {
  record.phase = 'broadcast'
  const { payments } = open()
  await payments.approve(draft)
  const completed = payments.getSnapshot().completion!
  expect(payments.consumeCompletion(completed.id + 1)).toBeNull()
  expect(payments.getSnapshot().completion).toBe(completed)
  expect(payments.consumeCompletion(completed.id)).toBe(completed)
  expect(payments.consumeCompletion(completed.id)).toBeNull()
  expect(payments.getSnapshot().completion).toBeNull()
  expect(api.cancel).not.toHaveBeenCalled()
  expect(api.saveSigned).not.toHaveBeenCalled()
})
it('resumes signatures discovered during reconciliation without another phone approval', async () => {
  const { payments } = open()
  await payments.refresh()
  api.reconcile.mockResolvedValue({
    kind: 'unknown',
    record: { ...record, phase: 'signed', phonePsbt: 'phone', signedPsbt: 'both', txHex: 'exact-bytes' },
  })
  await payments.approve(draft)
  expect(api.broadcast).toHaveBeenCalledExactlyOnceWith(enrollment.ledgerSavings!.contract, 'exact-tx')
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.mark).not.toHaveBeenCalled()
})

it.each(['review', 'approve'] as const)('rejects a candidate replaced while %s reconciles', async (command) => {
  const { payments } = open()
  await payments.refresh()
  api.reconcile.mockResolvedValue({ kind: 'signing', record: { ...record, candidateId: 'other-candidate' } })
  await expect(payments[command](draft)).rejects.toThrow(/saved Savings payment changed/)
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.retain).not.toHaveBeenCalled()
  expect(api.broadcast).not.toHaveBeenCalled()
})

it('drains dispatch during account disposal and suppresses its late UI completion', async () => {
  record.phonePsbt = 'phone'
  record.phase = 'signing'
  const dispatched = deferred<string>()
  api.broadcast.mockReturnValue(dispatched.promise)
  const { payments } = open()
  await payments.refresh()
  const pending = payments.approveWithLedger('exact-tx')
  await vi.waitFor(() => expect(api.broadcast).toHaveBeenCalledOnce())
  const account = activeVaultAccountRuntime('vault-a')!
  let disposed = false
  const disposal = disposeVaultAccountRuntime(account).then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  expect(api.close).not.toHaveBeenCalled()
  const rejected = expect(pending).rejects.toThrow(/active vault changed/)
  dispatched.resolve('exact-tx')
  await Promise.all([disposal, rejected])
  expect(disposed).toBe(true)
  expect(api.close).toHaveBeenCalledOnce()
  expect(record.txHex).toBe('exact-bytes')
  expect(payments.getSnapshot().completion).toBeNull()
  await expect(payments.approve(draft)).rejects.toThrow(/Unlock this Ledger vault/)
})
it.each([
  'phone-hww-recovery-savings-v1',
  'phone-connector-recovery-savings-v1',
  'phone-connector-recovery-savings-v2',
  'unknown',
])('rejects discarded Savings identity %s before reading or approving', async (templateVersion) => {
  const { payments } = open(false, {
    ...status,
    templateVersion,
    ledgerSavings: undefined,
  } as unknown as VaultStatus)
  await expect(payments.review(draft)).rejects.toThrow(/Unlock this Ledger/)
  await expect(payments.approve(draft)).rejects.toThrow(/Unlock this Ledger/)
  expect(api.load).not.toHaveBeenCalled()
  expect(api.fee).not.toHaveBeenCalled()
})
it('shares repeated phone and hardware commands without a second approval or dispatch', async () => {
  const { payments } = open()
  const phone = payments.approve(draft)
  expect(payments.approve(draft)).toBe(phone)
  await phone
  const hardware = payments.approveWithLedger('exact-tx')
  expect(payments.approveWithLedger('exact-tx')).toBe(hardware)
  await hardware
  expect(api.unlock).toHaveBeenCalledOnce()
  expect(api.connect).toHaveBeenCalledOnce()
  expect(api.deviceSign).toHaveBeenCalledOnce()
  expect(api.broadcast).toHaveBeenCalledOnce()
})
it('closes a late device connection after lock without requesting a signature', async () => {
  record.phonePsbt = 'phone'
  record.phase = 'signing'
  const late = deferred<{ app: object; close: typeof api.close }>()
  api.connect.mockReturnValue(late.promise)
  const { payments, update } = open()
  await payments.refresh()
  const pending = payments.approveWithLedger('exact-tx')
  await vi.waitFor(() => expect(api.connect).toHaveBeenCalledOnce())
  update({ locked: true })
  late.resolve({ app: {}, close: api.close })
  await expect(pending).rejects.toThrow()
  expect(api.deviceSign).not.toHaveBeenCalled()
  expect(api.close).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().completion).toBeNull()
})
it('discards a late hardware response after navigation cancels approval', async () => {
  record.phonePsbt = 'phone'
  record.phase = 'signing'
  const late = deferred<string>()
  api.deviceSign.mockReturnValue(late.promise)
  const { payments } = open()
  await payments.refresh()
  const pending = payments.approveWithLedger('exact-tx')
  await vi.waitFor(() => expect(api.deviceSign).toHaveBeenCalledOnce())
  payments.cancelHardware()
  late.resolve('stale signed psbt')
  await expect(pending).rejects.toThrow()
  expect(api.saveSigned).not.toHaveBeenCalled()
  expect(api.broadcast).not.toHaveBeenCalled()
  expect(api.close).toHaveBeenCalledOnce()
})
it('retains an accepted signature during lock but starts no broadcast after persistence', async () => {
  record.phonePsbt = 'phone'
  record.phase = 'signing'
  const saved = deferred<LedgerSavingsPaymentRecord>()
  api.saveSigned.mockReturnValue(saved.promise)
  const { payments, update } = open()
  await payments.refresh()
  const pending = payments.approveWithLedger('exact-tx')
  await vi.waitFor(() => expect(api.saveSigned).toHaveBeenCalledOnce())
  update({ locked: true })
  saved.resolve({ ...record, phase: 'signed', txHex: 'exact-bytes' })
  await expect(pending).rejects.toThrow(/active vault changed/)
  expect(api.broadcast).not.toHaveBeenCalled()
  expect(api.close).toHaveBeenCalledOnce()
  expect(payments.getSnapshot().view).toBeNull()
})
it('rejects a different retained candidate before connecting the device', async () => {
  record.phonePsbt = 'phone'
  record.phase = 'signing'
  const { payments } = open()
  await payments.refresh()
  await expect(payments.approveWithLedger('another-transaction')).rejects.toThrow(/Reopen/)
  expect(api.connect).not.toHaveBeenCalled()
})
it('shares observation between consumers of the same session', async () => {
  const read = deferred<Awaited<ReturnType<typeof api.reconcile>>>()
  api.reconcile.mockReturnValue(read.promise)
  const { payments, session } = open()
  const other = ledgerPaymentsForSession(session)
  expect(other).toBe(payments)
  const release = other.retain()
  releases.push(release)
  await vi.waitFor(() => expect(api.reconcile).toHaveBeenCalledOnce())
  const first = payments.refresh(),
    second = other.refresh()
  read.resolve({ kind: 'signing', record })
  await Promise.all([first, second])
  expect(api.reconcile).toHaveBeenCalledOnce()
})
it('cancels a pending review before it can retain a different draft', async () => {
  api.load.mockResolvedValue(null)
  const quote = deferred<{ payment: typeof record.payment }>()
  api.quote.mockReturnValue(quote.promise)
  const { payments } = open()
  const pending = payments.review(draft)
  await vi.waitFor(() => expect(api.quote).toHaveBeenCalledOnce())
  payments.cancelReview()
  quote.resolve({ payment: record.payment })
  await expect(pending).rejects.toThrow()
  expect(api.retain).not.toHaveBeenCalled()
})
it('exposes immutable candidate and completion snapshots', async () => {
  const { payments } = open()
  await payments.approve(draft)
  expect(() => {
    payments.getSnapshot().view!.record.payment.amountSats = 1
  }).toThrow()
  await payments.approveWithLedger('exact-tx')
  expect(() => {
    payments.getSnapshot().completion!.payment.amount = 1
  }).toThrow()
  expect(payments.getSnapshot().completion!.payment).toEqual(draft)
})

it('connects from the command gesture before awaiting durable candidate verification', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'phone'
  const { payments } = open()
  await payments.refresh()
  const retained = deferred<LedgerSavingsPaymentRecord>()
  api.load.mockReturnValue(retained.promise)
  const pending = payments.approveWithLedger('exact-tx')
  expect(api.connect).toHaveBeenCalledOnce()
  expect(api.deviceSign).not.toHaveBeenCalled()
  retained.resolve(record)
  await pending
  expect(api.deviceSign).toHaveBeenCalledOnce()
})
it('rejects a changed journal after connection and before requesting a signature', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'phone'
  const { payments } = open()
  await payments.refresh()
  api.load.mockResolvedValue({ ...record, candidateId: 'different-candidate' })
  await expect(payments.approveWithLedger('exact-tx')).rejects.toThrow(/saved Savings payment changed/)
  expect(api.deviceSign).not.toHaveBeenCalled()
  expect(api.close).toHaveBeenCalledOnce()
})
it('reopens saved phone approval after checking a failed hardware attempt', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'phone'
  api.saveSigned.mockRejectedValueOnce(new Error('Storage unavailable'))
  const { payments } = open()
  await payments.refresh()
  await expect(payments.approveWithLedger('exact-tx')).rejects.toThrow('Storage unavailable')
  expect(payments.getSnapshot().hardwarePhase).toBe('check')
  const opened = await payments.reopen('exact-tx')
  expect(opened.record.phonePsbt).toBe('phone')
  expect(payments.getSnapshot().hardwarePhase).toBe('idle')
  await payments.approveWithLedger('exact-tx')
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.broadcast).toHaveBeenCalledOnce()
})
