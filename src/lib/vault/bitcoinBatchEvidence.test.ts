import { describe, expect, it } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction, TxTree, CosignerPublicKey, getArkPsbtFields, SingleKey, buildForfeitTx } from '@arkade-os/sdk'
import { serializeBitcoinForfeit, serializeBitcoinBatchTree } from './bitcoinBatchEvidence'
import { sharedSpendingStatus, sharedSpendingStatusForNetwork } from './vtxo/testdata/sharedSpending'
import { vaultPolicyV1ScriptFromStatus } from './vtxo/spendingTransaction'
const testOwner = new Uint8Array(32).fill(1)
describe('Bitcoin batch evidence', () => {
  it('canonicalizes the SDK default-sighash field without changing its owner signature', async () => {
    const status = sharedSpendingStatusForNetwork('mutinynet', { phoneSecret: testOwner })
    const script = vaultPolicyV1ScriptFromStatus(status)
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
    const canonical = serializeBitcoinForfeit(base64.encode(signed.toPSBT()))
    const parsed = Transaction.fromPSBT(base64.decode(canonical))
    expect(parsed.id).toBe(signed.id)
    expect(parsed.getInput(0).sighashType).toBeUndefined()
    expect(parsed.getInput(0).tapScriptSig).toEqual(signed.getInput(0).tapScriptSig)
    expect(serializeBitcoinForfeit(canonical)).toBe(canonical)
    tx.updateInput(0, { sighashType: 1 }, true)
    expect(() => serializeBitcoinForfeit(base64.encode(tx.toPSBT()))).toThrow('signature mode')
  })
  it('retains MuSig key metadata when the pinned SDK attaches tree signatures', () => {
    const tx = new Transaction({ version: 3 })
    tx.addInput({ txid: '01'.repeat(32), index: 0 })
    tx.updateInput(0, {
      unknown: [CosignerPublicKey.encode({ index: 0, key: hex.decode(sharedSpendingStatus().phoneBip340Pub!) })],
    })
    tx.addOutput({ amount: 40000n, script: hex.decode(sharedSpendingStatus().spendingArkScript!) })
    const unsigned = [{ txid: tx.id, tx: base64.encode(tx.toPSBT()), children: {} }]
    const tree = TxTree.create(unsigned)
    tree.root.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) })
    expect(getArkPsbtFields(tree.root, 0, CosignerPublicKey)).toEqual(getArkPsbtFields(tx, 0, CosignerPublicKey))
    const preserved = serializeBitcoinBatchTree(tree, unsigned)
    const decoded = Transaction.fromPSBT(base64.decode(preserved[0].tx))
    expect(getArkPsbtFields(decoded, 0, CosignerPublicKey)).toHaveLength(1)
    expect(decoded.getInput(0).tapKeySig).toEqual(tree.root.getInput(0).tapKeySig)
    expect(() => serializeBitcoinBatchTree(tree, [])).toThrow('changed')
    expect(() => serializeBitcoinBatchTree(tree, [{ ...unsigned[0], txid: 'ff'.repeat(32) }])).toThrow('changed')
    expect(() => serializeBitcoinBatchTree(TxTree.create(unsigned), unsigned)).toThrow('missing')
  })
})
