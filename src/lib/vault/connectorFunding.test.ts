import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { Transaction, p2tr, p2wpkh } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { prepareFunding, type FundingRequest } from './connectorFunding'

function fixture(type: 'p2wpkh' | 'p2tr' = 'p2wpkh', change = true) {
  const key = new Uint8Array(32).fill(3)
  const pub = secp256k1.getPublicKey(key)
  const payment = type === 'p2tr' ? p2tr(pub.slice(1)) : p2wpkh(pub)
  const savings = p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(4)).slice(1))
  const reserve = p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(5)))
  const parent = new Transaction()
  parent.addInput({ txid: '11'.repeat(32), index: 0 })
  parent.addOutput({ script: payment.script, amount: 100000n })
  const source = new Transaction()
  source.addInput({
    txid: parent.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { amount: 100000n, script: payment.script },
    ...(type === 'p2tr' ? { tapInternalKey: pub.slice(1) } : { sighashType: 1 }),
  })
  source.addOutput({ script: savings.script, amount: change ? 80000n : 99800n })
  if (change) source.addOutput({ script: payment.script, amount: 19800n })
  const request: FundingRequest = {
    sourcePsbt: hex.encode(source.toPSBT()),
    parents: [hex.encode(parent.toBytes(true, true))],
    savingsScript: hex.encode(savings.script),
    reserveScript: hex.encode(reserve.script),
    addReserve: true,
    feeRate: 2,
    feeCap: 20000,
    feerateCap: 25,
  }
  return { key, source, request, payment }
}

for (const type of ['p2wpkh', 'p2tr'] as const) {
  describe(type, () => {
    it.each([true, false])(
      'funds Savings and exactly one reserve, preserves change=%s and verifies real signatures',
      (change) => {
        const f = fixture(type, change)
        const prepared = prepareFunding(f.request)
        const tx = Transaction.fromPSBT(hex.decode(prepared.psbt))
        expect(tx.inputsLength).toBe(1)
        expect(tx.outputsLength).toBe(change ? 3 : 2)
        expect(tx.getOutput(tx.outputsLength - 1)).toMatchObject({
          amount: 1000n,
          script: hex.decode(f.request.reserveScript),
        })
        if (change) expect(tx.getOutput(1)).toEqual(f.source.getOutput(1))
        expect(prepared.savings + prepared.reserve + prepared.fee + (change ? 19800 : 0)).toBe(100000)
        tx.sign(f.key)
        const partial = prepared.accept(hex.encode(tx.toPSBT()))
        tx.finalize()
        expect(prepared.accept(hex.encode(tx.extract()))).toEqual(partial)
        expect(partial.txid).toBe(prepared.txid)
      },
    )
    it('refuses missing, corrupt and changed-transaction approvals', () => {
      const f = fixture(type)
      const prepared = prepareFunding(f.request)
      expect(() => prepared.accept(prepared.psbt)).toThrow(/signature/i)
      const tx = Transaction.fromPSBT(hex.decode(prepared.psbt))
      tx.sign(f.key)
      const input = tx.getInput(0)
      if (type === 'p2tr') {
        const sig = input.tapKeySig!.slice()
        sig[5] ^= 1
        tx.updateInput(0, { tapKeySig: sig }, true)
      } else {
        const [pub, value] = input.partialSig![0]
        const sig = value.slice()
        sig[5] ^= 1
        tx.updateInput(0, { partialSig: undefined }, true)
        tx.updateInput(0, { partialSig: [[pub, sig]] }, true)
      }
      expect(() => prepared.accept(hex.encode(tx.toPSBT()))).toThrow(/signature/i)
      const different = Transaction.fromPSBT(hex.decode(prepared.psbt))
      different.updateOutput(0, { amount: 1n })
      different.sign(f.key)
      expect(() => prepared.accept(hex.encode(different.toPSBT()))).toThrow(/changed/)
    })
  })
}

it('does not add another reserve when one already exists', () => {
  const f = fixture()
  const result = prepareFunding({ ...f.request, addReserve: false })
  expect(result.reserve).toBe(0)
  expect(Transaction.fromPSBT(hex.decode(result.psbt)).outputsLength).toBe(2)
})
it('rejects wrong parents, wrong Savings, signed drafts, duplicates and unsupported fee rates', () => {
  const f = fixture()
  expect(() => prepareFunding({ ...f.request, parents: ['00'] })).toThrow()
  expect(() => prepareFunding({ ...f.request, savingsScript: f.request.reserveScript })).toThrow(/Savings/)
  expect(() => prepareFunding({ ...f.request, feeRate: 100 })).toThrow(/fee/)
  const duplicate = Transaction.fromPSBT(hex.decode(f.request.sourcePsbt))
  duplicate.addInput(duplicate.getInput(0))
  expect(() =>
    prepareFunding({
      ...f.request,
      sourcePsbt: hex.encode(duplicate.toPSBT()),
      parents: [...f.request.parents, ...f.request.parents],
    }),
  ).toThrow(/Duplicate/)
  f.source.sign(f.key)
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/unsigned/)
})
it('rejects deposits too small to fund reserve and fees', () => {
  const f = fixture()
  f.source.updateOutput(0, { amount: 1000n })
  f.source.updateOutput(1, { amount: 98800n })
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/too small/)
})

it.each(['p2wpkh', 'p2tr'] as const)(
  'accepts full parent metadata and ALL signatures for %s at the fee ceiling',
  (type) => {
    const f = fixture(type)
    f.source.updateInput(0, { nonWitnessUtxo: hex.decode(f.request.parents[0]), sighashType: 1 })
    const result = prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()), feeRate: 25 })
    const tx = Transaction.fromPSBT(hex.decode(result.psbt))
    tx.sign(f.key, [1])
    expect(result.accept(hex.encode(tx.toPSBT())).txid).toBe(result.txid)
  },
)
it('refuses prevout value substitution and signatures not committing all outputs', () => {
  const f = fixture()
  f.source.updateInput(0, { witnessUtxo: { amount: 100001n, script: f.payment.script } }, true)
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/prevout mismatch/)
  f.source.updateInput(0, { witnessUtxo: { amount: 100000n, script: f.payment.script }, sighashType: 0x81 }, true)
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/all outputs/)
})
it('refuses duplicate Savings outputs and an already included reserve', () => {
  const f = fixture()
  f.source.updateOutput(1, { script: hex.decode(f.request.savingsScript) })
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/exactly one/)
  f.source.updateOutput(1, { script: hex.decode(f.request.reserveScript), amount: 1000n })
  expect(() => prepareFunding({ ...f.request, sourcePsbt: hex.encode(f.source.toPSBT()) })).toThrow(/adds the reserve/)
})

it('preserves multiple inputs, signatures and metadata in a combined deposit', () => {
  const f = fixture()
  const parent = new Transaction()
  parent.addInput({ txid: '22'.repeat(32), index: 0 })
  parent.addOutput({ amount: 10000n, script: f.payment.script })
  f.source.addInput({
    txid: parent.id,
    index: 0,
    witnessUtxo: { amount: 10000n, script: f.payment.script },
    sighashType: 1,
  })
  f.source.updateOutput(0, { amount: 90000n })
  const result = prepareFunding({
    ...f.request,
    sourcePsbt: hex.encode(f.source.toPSBT()),
    parents: [...f.request.parents, hex.encode(parent.toBytes(true, true))],
  })
  const tx = Transaction.fromPSBT(hex.decode(result.psbt))
  expect(tx.sign(f.key)).toBe(2)
  expect(result.accept(hex.encode(tx.toPSBT())).txid).toBe(result.txid)
})
