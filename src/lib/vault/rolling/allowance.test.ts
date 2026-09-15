import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../hex'
import vectors from './testdata/rolling-allowance-v1.json'
import {
  MAX_SEQUENCE,
  ROLLING_WINDOW_SECONDS,
  applyDebit,
  applyMatureCredit,
  buildHistoryProof,
  decodeDebit,
  decodeRollingState,
  encodeDebit,
  encodeRollingState,
  historyWitness,
  initialRollingState,
  receiptDomain,
  receiptMessage,
  verifyMatureReceipt,
  verifyRollingHistory,
  type RollingDebit,
  type RollingReceipt,
} from './allowance'

const receipt: RollingReceipt = { ...vectors.receipt, debit: vectors.debit }
const now = receipt.observedAt + ROLLING_WINDOW_SECONDS + 1

describe('rolling allowance compatibility', () => {
  it('matches the Go state, proof, receipt and history vectors', () => {
    const initial = initialRollingState(vectors.policy.budget)
    expect(bytesToHex(encodeRollingState(initial))).toBe(vectors.initialState)
    expect(decodeRollingState(hexToBytes(vectors.initialState))).toEqual(initial)
    expect(bytesToHex(encodeDebit(vectors.debit))).toBe(vectors.debitHex)
    expect(decodeDebit(hexToBytes(vectors.debitHex))).toEqual(vectors.debit)
    const { proof } = buildHistoryProof([], 0)
    expect(proof).toEqual(vectors.insertionProof)
    expect(historyWitness(proof).map(bytesToHex)).toEqual(vectors.insertionWitness)
    const spent = applyDebit(initial, vectors.policy.budget, vectors.debit, proof)
    expect(bytesToHex(encodeRollingState(spent))).toBe(vectors.spentState)
    expect(buildHistoryProof([vectors.debit], 0)).toEqual({ proof: vectors.removalProof, root: spent.root })
    expect(receiptDomain(vectors.policy)).toBe(vectors.receipt.domain)
    expect(bytesToHex(receiptMessage(receipt))).toBe(vectors.receipt.message)
    verifyRollingHistory(spent, [vectors.debit], vectors.policy.budget)
    verifyMatureReceipt(receipt, vectors.policy, now)
    const credited = applyMatureCredit(spent, vectors.policy, receipt, vectors.removalProof, now)
    expect(bytesToHex(encodeRollingState(credited))).toBe(vectors.creditedState)
    verifyRollingHistory(credited, [], vectors.policy.budget)
    expect(() => applyMatureCredit(credited, vectors.policy, receipt, vectors.removalProof, now)).toThrow()
  })

  it('rejects the exact 24-hour boundary and substituted receipt authority', () => {
    expect(() => verifyMatureReceipt(receipt, vectors.policy, now - 1)).toThrow(/maturity/)
    expect(() => verifyMatureReceipt(receipt, vectors.policy, now - 2)).toThrow(/maturity/)
    for (const changed of [
      { ...receipt, observedAt: receipt.observedAt - 1 },
      { ...receipt, debit: { ...receipt.debit, amount: 999 } },
      { ...receipt, signature: '00'.repeat(64) },
      { ...receipt, domain: 'ab'.repeat(32) },
    ])
      expect(() => verifyMatureReceipt(changed, vectors.policy, now)).toThrow()
    for (const changed of [
      { ...vectors.policy, budget: vectors.policy.budget + 1 },
      { ...vectors.policy, controllerTxid: 'ab'.repeat(32) },
      { ...vectors.policy, checkpointExit: `${vectors.policy.checkpointExit}00` },
      { ...vectors.policy, feeCap: vectors.policy.feeCap + 1 },
      { ...vectors.policy, networkGenesis: 'ab'.repeat(32) },
    ])
      expect(() => verifyMatureReceipt(receipt, changed, now)).toThrow()
  })

  it('retains old debits until an authenticated credit and rejects missing history', () => {
    const state = decodeRollingState(hexToBytes(vectors.spentState))
    verifyRollingHistory(state, [vectors.debit], vectors.policy.budget)
    expect(() => verifyRollingHistory(state, [], vectors.policy.budget)).toThrow(/history/)
    expect(() => verifyRollingHistory(state, [vectors.debit, vectors.debit], vectors.policy.budget)).toThrow()
    expect(() =>
      verifyRollingHistory({ ...state, remaining: state.remaining + 1 }, [vectors.debit], vectors.policy.budget),
    ).toThrow()
    const changed = [...vectors.removalProof]
    changed[0] = 'ab'.repeat(32)
    expect(() => applyMatureCredit(state, vectors.policy, receipt, changed, now)).toThrow()
  })

  it('rejects integer overflow, negative zero encodings and malformed proofs', () => {
    const encoded = hexToBytes(vectors.initialState)
    encoded[11] = 0x80
    expect(() => decodeRollingState(encoded)).toThrow()
    expect(() => encodeDebit({ ...vectors.debit, amount: -1 })).toThrow()
    expect(() => encodeDebit({ ...vectors.debit, sequence: MAX_SEQUENCE })).toThrow()
    expect(() => encodeDebit({ ...vectors.debit, parentIndex: 1 })).toThrow()
    expect(() => buildHistoryProof([], MAX_SEQUENCE)).toThrow()
    expect(() => historyWitness(vectors.insertionProof.slice(1))).toThrow()
    expect(() => receiptMessage({ ...receipt, observedAt: Number.NaN })).toThrow()
    expect(() => decodeDebit(hexToBytes(`${vectors.debitHex}00`))).toThrow()
  })

  it('reconstructs a sequence of debits and prevents reuse of occupied or old slots', () => {
    const budget = 1_000_000
    let state = initialRollingState(budget)
    const debits: RollingDebit[] = []
    for (let sequence = 0; sequence < 75; sequence++) {
      const debit = { ...vectors.debit, sequence, amount: 330 + sequence }
      const { proof, root } = buildHistoryProof(debits, sequence)
      expect(root).toBe(state.root)
      state = applyDebit(state, budget, debit, proof)
      debits.push(debit)
      verifyRollingHistory(state, debits, budget)
      expect(() => applyDebit(state, budget, debit, proof)).toThrow()
    }
  })
})
