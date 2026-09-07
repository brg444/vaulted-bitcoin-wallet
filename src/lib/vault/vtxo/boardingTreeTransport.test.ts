import { describe, expect, it } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import {
  Batch,
  TxTree,
  SettlementEventType,
  CosignerPublicKey,
  getArkPsbtFields,
  type TxTreeNode,
  type SettlementEvent,
} from '@arkade-os/sdk'
import fixtureData from './testdata/boarding-tree-transport.json'

const fixtures = fixtureData as { name: string; unsigned: TxTreeNode[]; signed: TxTreeNode[] }[]

// Synthetic single-receiver and shared trees built and MuSig2-signed by
// ark-lib 8b34e3528595. No live wallet data or signing keys are included.
describe('vendored SDK signed boarding tree transport', () => {
  it.each(fixtures)('preserves signed recovery evidence: $name', async (fixture) => {
    const unsigned = TxTree.create(fixture.unsigned)
    const expected = TxTree.create(fixture.signed)
    const common = { id: 'batch-1', topic: [], batchIndex: 0 }
    const events: SettlementEvent[] = [
      {
        ...common,
        type: SettlementEventType.BatchStarted,
        intentIdHashes: [],
        batchExpiry: 100n,
      },
      ...fixture.unsigned.map((chunk) => ({
        ...common,
        type: SettlementEventType.TreeTx as const,
        chunk,
      })),
      {
        ...common,
        type: SettlementEventType.TreeSigningStarted,
        cosignersPublicKeys: [],
        unsignedCommitmentTx: '',
      },
      {
        ...common,
        type: SettlementEventType.TreeNonces,
        txid: unsigned.txid,
        nonces: new Map(),
      },
      ...fixture.signed.map((node) => ({
        ...common,
        type: SettlementEventType.TreeSignature as const,
        txid: node.txid,
        signature: hex.encode(Transaction.fromPSBT(base64.decode(node.tx)).getInput(0).tapKeySig!),
      })),
      { ...common, type: SettlementEventType.BatchFinalization, commitmentTx: '' },
      {
        ...common,
        type: SettlementEventType.BatchFinalized,
        commitmentTxid: '22'.repeat(32),
      },
    ]
    async function* stream() {
      yield* events
    }
    let snapshot: TxTreeNode[] | undefined
    const handler: Batch.Handler = {
      onBatchStarted: async () => ({ skip: false }),
      onTreeSigningStarted: async () => ({ skip: false }),
      onTreeNonces: async () => ({ fullySigned: true }),
      onBatchFinalization: async (_, tree) => {
        snapshot = [...tree!.iterator()].map((node) => ({
          txid: node.txid,
          tx: base64.encode(node.root.toPSBT()),
          children: Object.fromEntries([...node.children].map(([index, child]) => [index, child.txid])),
        }))
      },
    }
    await expect(Batch.join(stream(), handler)).resolves.toBe('22'.repeat(32))
    const actual = TxTree.create(snapshot!)
    actual.validate()
    expect(actual.nbOfNodes()).toBe(fixture.signed.length)
    for (const node of actual.iterator()) {
      const input = node.root.getInput(0)
      const original = unsigned.find(node.txid)!.root.getInput(0)
      const signed = expected.find(node.txid)!.root.getInput(0)
      expect(input.unknown).toEqual(original.unknown)
      expect(input.tapKeySig).toEqual(signed.tapKeySig)
      expect(node.root.unsignedTx).toEqual(expected.find(node.txid)!.root.unsignedTx)
      const cosigners = getArkPsbtFields(node.root, 0, CosignerPublicKey).map((field) => field.key)
      expect(cosigners.length).toBeGreaterThanOrEqual(2)
    }
  })
})
