import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import type { LedgerSavingsPaymentRecord } from '../lib/vault/ledgerSavingsWallet'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { useLedgerSavings } from './useLedgerSavings'

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
}))
vi.mock('../lib/vault/ledgerSavingsWallet', () => ({
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
vi.mock('../lib/vault/program/ledgerEnrollment', () => ({ validateLedgerSavingsEnrollmentSecrets: api.validate }))
vi.mock('../lib/vault/savingsSpend', () => ({ unlockLedgerSavingsSeed: api.unlock }))
vi.mock('../lib/vault/esplora', () => ({ fetchFeeEstimates: api.fee }))

const status = {
  enrolled: true,
  vaultId: 'vault-a',
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
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function open() {
  return renderHook(() => useLedgerSavings(status, enrollment, false))
}

it('retains the candidate before one passkey approval and leaves broadcast to Ledger completion', async () => {
  const { result } = open()
  await act(async () => {
    expect(await result.current.approve(draft)).toBeNull()
  })
  expect(api.mark.mock.invocationCallOrder[0]).toBeLessThan(api.unlock.mock.invocationCallOrder[0])
  expect(api.savePhone).toHaveBeenCalledWith(enrollment.ledgerSavings!.contract, 'exact-tx', 'phone-signature')
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(result.current.view?.record.phonePsbt).toBe('phone-signature')
  expect(api.broadcast).not.toHaveBeenCalled()
  await act(async () => {
    expect(await result.current.complete('exact-tx', 'ledger-signature')).toBe('exact-tx')
  })
  expect(api.saveSigned.mock.invocationCallOrder[0]).toBeLessThan(api.broadcast.mock.invocationCallOrder[0])
  expect(api.unlock).toHaveBeenCalledTimes(1)
})

it('resumes a saved phone approval without another passkey prompt', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'already-approved'
  const { result } = open()
  await act(async () => {
    expect(await result.current.approve(draft)).toBeNull()
  })
  expect(api.unlock).not.toHaveBeenCalled()
  expect(api.phone).not.toHaveBeenCalled()
  expect(result.current.view?.record.phonePsbt).toBe('already-approved')
})

it('rejects changed recipient, amount or fee before requesting either signature', async () => {
  const { result } = open()
  for (const changed of [
    { ...draft, address: 'other' },
    { ...draft, amount: 1 },
    { ...draft, fee: 999 },
  ])
    await act(async () => {
      await expect(result.current.approve(changed)).rejects.toThrow(/Review/)
    })
  expect(api.mark).not.toHaveBeenCalled()
  expect(api.unlock).not.toHaveBeenCalled()
})

it('wipes the unlocked seed when phone signing fails and never dispatches a payment', async () => {
  api.phone.mockImplementation(() => {
    throw new Error('signing failed')
  })
  const { result } = open()
  await act(async () => {
    await expect(result.current.approve(draft)).rejects.toThrow('signing failed')
  })
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(api.savePhone).not.toHaveBeenCalled()
  expect(api.broadcast).not.toHaveBeenCalled()
})

it.each([false, true])('does not sign after locking during the passkey prompt, reopened=%s', async (reopen) => {
  let resolve!: (value: Uint8Array) => void
  api.unlock.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { result, rerender } = renderHook(({ locked }) => useLedgerSavings(status, enrollment, locked), {
    initialProps: { locked: false },
  })
  let pending!: Promise<string | null>
  act(() => {
    pending = result.current.approve(draft)
  })
  await waitFor(() => expect(api.unlock).toHaveBeenCalledOnce())
  rerender({ locked: true })
  if (reopen) rerender({ locked: false })
  await act(async () => {
    resolve(seed)
    await expect(pending).rejects.toThrow(/active vault changed/)
  })
  expect(seed.every((byte) => byte === 0)).toBe(true)
  expect(api.phone).not.toHaveBeenCalled()
})

it('keeps both signatures after an uncertain submission and never retries during refresh', async () => {
  record.phase = 'signing'
  record.phonePsbt = 'phone-signature'
  api.broadcast.mockRejectedValue(new Error('response lost'))
  api.reconcile.mockImplementation(async () => ({ kind: 'unknown', record: structuredClone(record) }))
  const { result } = open()
  await act(async () => {
    await expect(result.current.complete('exact-tx', 'ledger-signature')).rejects.toThrow('response lost')
  })
  await act(async () => {
    await result.current.refresh()
    await result.current.refresh()
  })
  expect(api.broadcast).toHaveBeenCalledTimes(1)
  expect(result.current.view?.record.txHex).toBe('exact-bytes')
  expect(result.current.view?.outcome).toBe('unknown')
  expect(api.unlock).not.toHaveBeenCalled()
})

it('recognizes an already observed payment without broadcasting or signing again', async () => {
  record.phase = 'broadcast'
  record.phonePsbt = 'phone'
  record.txHex = 'exact-bytes'
  const { result } = open()
  await act(async () => {
    expect(await result.current.approve(draft)).toBe('exact-tx')
  })
  expect(api.broadcast).not.toHaveBeenCalled()
  expect(api.unlock).not.toHaveBeenCalled()
})

it('keeps existing non-Ledger enrollments outside the new coordinator', async () => {
  const legacy = { ...status, templateVersion: 'phone-hww-recovery-staged-v6', ledgerSavings: undefined }
  const { result } = renderHook(() => useLedgerSavings(legacy, enrollment, false))
  await act(async () => {
    await expect(result.current.review(draft)).rejects.toThrow(/Unlock this Ledger/)
  })
  expect(api.load).not.toHaveBeenCalled()
  expect(api.fee).not.toHaveBeenCalled()
})
