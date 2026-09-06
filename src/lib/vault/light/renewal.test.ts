import { beforeEach, describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { Transaction, TxTree, CosignerPublicKey, getArkPsbtFields, SingleKey, buildForfeitTx } from '@arkade-os/sdk'
import { lightDescriptorDigest, LightScript } from './contract'
import {
  readLightRenewal,
  serializeLightRenewalForfeit,
  serializeLightRenewalTree,
  validateLightRenewalPlan,
} from './renewal'
import { testDescriptor, testOwner } from './testdata/helpers'
import type { LightRenewalPlan, LightRenewalPrepared } from './renewalTypes'

function prepared(): LightRenewalPrepared {
  const plan: LightRenewalPlan = {
    operationId: '01'.repeat(16),
    vaultId: testDescriptor.vaultId,
    descriptorHash: lightDescriptorDigest(testDescriptor),
    txid: '02'.repeat(32),
    vout: 1,
    valueSats: 80000,
    receiverSats: 79900,
    feeSats: 100,
    feePolicyDigest: '03'.repeat(32),
    registerExpireAt: 1789000000,
  }
  return {
    plan,
    planDigest: hex.encode(sha256(new TextEncoder().encode(`vaulted-light/renewal-plan/v1:${JSON.stringify(plan)}`))),
    state: 'prepared',
  }
}
beforeEach(() => localStorage.clear())
describe('Light renewal approval', () => {
  it('canonicalizes the SDK default-sighash field without changing its owner signature', async () => {
    const script = new LightScript(testDescriptor)
    const tx = buildForfeitTx(
      [
        {
          txid: '01'.repeat(32),
          index: 0,
          witnessUtxo: { amount: 40000n, script: script.pkScript },
          tapLeafScript: [script.forfeit()],
          sighashType: 0,
        },
        { txid: '02'.repeat(32), index: 0, witnessUtxo: { amount: 330n, script: script.pkScript } },
      ],
      hex.decode('0014' + '03'.repeat(20)),
    )
    const signed = await SingleKey.fromPrivateKey(testOwner).sign(tx, [0])
    expect(signed.getInput(0).sighashType).toBe(0)
    const canonical = serializeLightRenewalForfeit(base64.encode(signed.toPSBT()))
    const parsed = Transaction.fromPSBT(base64.decode(canonical))
    expect(parsed.id).toBe(signed.id)
    expect(parsed.getInput(0).sighashType).toBeUndefined()
    expect(parsed.getInput(0).tapScriptSig).toEqual(signed.getInput(0).tapScriptSig)
    expect(serializeLightRenewalForfeit(canonical)).toBe(canonical)
    tx.updateInput(0, { sighashType: 1 }, true)
    expect(() => serializeLightRenewalForfeit(base64.encode(tx.toPSBT()))).toThrow('signature mode')
  })
  it('retains MuSig key metadata when the pinned SDK attaches tree signatures', () => {
    const tx = new Transaction({ version: 3 })
    tx.addInput({ txid: '01'.repeat(32), index: 0 })
    tx.updateInput(0, {
      unknown: [CosignerPublicKey.encode({ index: 0, key: hex.decode(`02${testDescriptor.ownerPub}`) })],
    })
    tx.addOutput({ amount: 40000n, script: hex.decode(testDescriptor.scriptPubKey) })
    const unsigned = [{ txid: tx.id, tx: base64.encode(tx.toPSBT()), children: {} }]
    const tree = TxTree.create(unsigned)
    tree.root.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) })
    expect(getArkPsbtFields(tree.root, 0, CosignerPublicKey)).toHaveLength(0)
    const preserved = serializeLightRenewalTree(tree, unsigned)
    const decoded = Transaction.fromPSBT(base64.decode(preserved[0].tx))
    expect(getArkPsbtFields(decoded, 0, CosignerPublicKey)).toHaveLength(1)
    expect(decoded.getInput(0).tapKeySig).toEqual(tree.root.getInput(0).tapKeySig)
    expect(() => serializeLightRenewalTree(tree, [])).toThrow('changed')
    expect(() => serializeLightRenewalTree(tree, [{ ...unsigned[0], txid: 'ff'.repeat(32) }])).toThrow('changed')
    expect(() => serializeLightRenewalTree(TxTree.create(unsigned), unsigned)).toThrow('missing')
  })
  it('preserves principal above the payment limit and binds the exact fee', () => {
    const quote = prepared()
    expect(quote.plan.valueSats).toBeGreaterThan(testDescriptor.spendingPolicy.txRecipientCapSats)
    expect(validateLightRenewalPlan(quote, testDescriptor)).toEqual(quote)
    for (const change of [
      { receiverSats: quote.plan.receiverSats - 1, feeSats: quote.plan.feeSats + 1 },
      { operationId: 'ab'.repeat(16) },
      { txid: 'cd'.repeat(32) },
      { registerExpireAt: quote.plan.registerExpireAt + 1 },
      { feePolicyDigest: 'ff'.repeat(32) },
    ])
      expect(() => validateLightRenewalPlan({ ...quote, plan: { ...quote.plan, ...change } }, testDescriptor)).toThrow()
  })
  it('rejects malformed, unsafe and over-limit amounts before approval', () => {
    for (const change of [
      { valueSats: Number.MAX_SAFE_INTEGER },
      { receiverSats: 329 },
      { feeSats: -1 },
      { feeSats: testDescriptor.spendingPolicy.absoluteFeeCapSats + 1 },
      { vout: -1 },
      { vout: 2 ** 32 },
      { receiverSats: NaN },
      { registerExpireAt: Infinity },
      { vaultId: 'ab'.repeat(32) },
    ])
      expect(() =>
        validateLightRenewalPlan({ ...prepared(), plan: { ...prepared().plan, ...change } }, testDescriptor),
      ).toThrow()
  })
  it('detects a saved plan substituted into another renewal operation', () => {
    const plan = prepared()
    const journal = {
      version: 1,
      vaultId: testDescriptor.vaultId,
      descriptorHash: lightDescriptorDigest(testDescriptor),
      operationId: plan.plan.operationId,
      txid: plan.plan.txid,
      vout: plan.plan.vout,
      stage: 'finalizing',
      plan,
    }
    const key = `vaulted-light-renewal:${testDescriptor.vaultId}`
    localStorage.setItem(key, JSON.stringify(journal))
    expect(readLightRenewal(testDescriptor)?.stage).toBe('finalizing')
    localStorage.setItem(key, JSON.stringify({ ...journal, operationId: 'ff'.repeat(16) }))
    expect(() => readLightRenewal(testDescriptor)).toThrow('changed')
  })
})
