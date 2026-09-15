import { describe, expect, it } from 'vitest'
import { Extension, getArkPsbtFields, PrevArkTxField, Transaction } from '@arkade-os/sdk'
import { bytesToHex, hexToBytes } from '../hex'
import vectors from './testdata/rolling-allowance-v1.json'
import { type RollingContractParameters } from './contract'
import {
  buildRollingPayment,
  buildRollingCredit,
  buildRollingRenewal,
  buildRollingPrincipalRenewal,
} from './transaction'
import { encodeRollingState } from './allowance'

const params: RollingContractParameters = {
  policy: vectors.policy,
  tier: 'light',
  exitDelaySeconds: vectors.descriptor.ExitDelaySeconds,
  user: vectors.descriptor.User,
  guardian: vectors.descriptor.Guardian,
  emulator: vectors.descriptor.Emulator,
  operator: vectors.descriptor.Operator,
}
const sources = [
  { previousTxHex: vectors.sourceTx, index: 0 },
  { previousTxHex: vectors.sourceTx, index: 1 },
]

describe('rolling wallet transaction construction', () => {
  it('matches runtime principal-only renewal without consuming the controller or charging a fee', () => {
    const vector = vectors.principalRenewal
    const result = buildRollingPrincipalRenewal(params, [sources[1]], vector.validAt, vector.expireAt)
    expect(result.message).toBe(vector.message)
    expect(bytesToHex(result.proof.toBytes(true, false))).toBe(vector.proofTx)
    expect(result.proof.getOutput(0).amount).toBe(Transaction.fromRaw(hexToBytes(vectors.sourceTx)).getOutput(1).amount)
    const ext = Extension.fromTx(result.proof)
    expect(ext.getAssetPacket()).toBeNull()
    expect(ext.getPacketByType(2)).toBeNull()
    expect(getArkPsbtFields(result.proof, 1, PrevArkTxField).map(bytesToHex)).toEqual([vectors.sourceTx])
    expect(() =>
      buildRollingPrincipalRenewal(
        params,
        [{ previousTxHex: vectors.paymentTx, index: 0 }],
        vector.validAt,
        vector.expireAt,
      ),
    ).toThrow()
    expect(() =>
      buildRollingPrincipalRenewal(params, [sources[1], sources[1]], vector.validAt, vector.expireAt),
    ).toThrow()
  })
  it('matches runtime renewal proofs with and without a shared allowance fee', () => {
    for (const vector of vectors.renewals) {
      const result = buildRollingRenewal(params, sources, [], vector.fee, vector.validAt, vector.expireAt)
      expect(result.message).toBe(vector.message)
      expect(bytesToHex(result.proof.toBytes(true, false))).toBe(vector.proofTx)
      expect(bytesToHex(encodeRollingState(result.after))).toBe(vector.after)
      expect(result.debit?.amount ?? 0).toBe(vector.fee)
      for (let i = 0; i < sources.length; i++)
        expect(getArkPsbtFields(result.proof, i + 1, PrevArkTxField).map(bytesToHex)).toEqual([vectors.sourceTx])
    }
  })
  it('rejects unbounded renewals and fees without principal', () => {
    expect(() => buildRollingRenewal(params, sources, [], 0, 1800000000, 1800003601)).toThrow()
    expect(() => buildRollingRenewal(params, sources, [], 201, 1800000000, 1800000600)).toThrow()
    expect(() => buildRollingRenewal(params, [sources[0]], [], 1, 1800000000, 1800000600)).toThrow()
    const renewal = buildRollingRenewal(params, [sources[0]], [], 0, 1800000000, 1800000600)
    expect(renewal.after).toEqual(renewal.before)
    expect(renewal.debit).toBeUndefined()
  })
  it('retains the complete previous transaction including recovery witnesses', () => {
    const parent = Transaction.fromRaw(hexToBytes(vectors.sourceTx))
    parent.updateInput(0, { finalScriptWitness: [new Uint8Array([1, 2, 3])] })
    const previousTxHex = bytesToHex(parent.toBytes(true, true))
    const witnessed = sources.map((source) => ({ ...source, previousTxHex }))
    const result = buildRollingPayment(params, witnessed, [], vectors.scripts.pkScript, 1000)
    expect(bytesToHex(result.arkTx.toBytes(true, false))).toBe(vectors.paymentTx)
    for (let i = 0; i < sources.length; i++)
      expect(getArkPsbtFields(result.arkTx, i, PrevArkTxField).map(bytesToHex)).toEqual([previousTxHex])
  })
  it('matches native runtime payment and checkpoint transactions exactly', () => {
    const result = buildRollingPayment(params, sources, [], vectors.scripts.pkScript, 1000)
    expect(bytesToHex(result.arkTx.toBytes(true, false))).toBe(vectors.paymentTx)
    expect(result.debit).toEqual(vectors.debit)
    expect(result.checkpoints.map((cp) => bytesToHex(cp.toBytes(true, false)))).toEqual(vectors.paymentCheckpoints)
    for (let i = 0; i < sources.length; i++)
      expect(getArkPsbtFields(result.arkTx, i, PrevArkTxField).map(bytesToHex)).toEqual([vectors.sourceTx])
  })
  it('matches a mature credit and cannot credit it early or twice', () => {
    const receipt = { ...vectors.receipt, debit: vectors.debit }
    const source = [{ previousTxHex: vectors.paymentTx, index: 0 }]
    const now = receipt.observedAt + 86401
    const result = buildRollingCredit(params, source, [vectors.debit], receipt, now)
    expect(bytesToHex(result.arkTx.toBytes(true, false))).toBe(vectors.creditTx)
    expect(result.debit).toBeUndefined()
    expect(() => buildRollingCredit(params, source, [vectors.debit], receipt, now - 1)).toThrow()
    expect(() =>
      buildRollingCredit(params, [{ previousTxHex: vectors.creditTx, index: 0 }], [], receipt, now),
    ).toThrow()
  })
  it('rejects missing history, duplicate sources, wrong controller and excessive payments', () => {
    expect(() => buildRollingPayment(params, [sources[0], sources[0]], [], vectors.scripts.pkScript, 1000)).toThrow()
    expect(() => buildRollingPayment(params, [sources[1], sources[0]], [], vectors.scripts.pkScript, 1000)).toThrow()
    expect(() =>
      buildRollingPayment(params, sources, [], vectors.scripts.pkScript, params.policy.recipientCap + 1),
    ).toThrow()
    expect(() =>
      buildRollingPayment(
        params,
        [
          { previousTxHex: vectors.paymentTx, index: 0 },
          { previousTxHex: vectors.paymentTx, index: 2 },
        ],
        [],
        vectors.scripts.pkScript,
        1000,
      ),
    ).toThrow()
  })
})
