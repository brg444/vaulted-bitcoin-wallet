import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Transaction, RestArkProvider, RestIndexerProvider, ChainTxType, type VirtualCoin } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import native from './testdata/nativeDelegationRecovery.json'
import pruned from './testdata/prunedDelegationRecovery.json'
import { delegationFixture } from './testdata/delegation'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import { importGuardianReplacement, importDelegationReplacementForBinding } from './delegationRecovery'
import { captureExitArchive, exitArchiveProviders, validateExitArchive } from '../recovery/exitArchive'
import { lightExitRepository } from './exitRepository'
import { captureLightRecoveryArchive, validateLightRecoveryArchive } from './recoveryArchive'
import type { GuardianDelegationStatus } from './delegationStore'

function fixture(source: typeof native = native) {
  const d = source.descriptor as LightDescriptor
  const info = { ...delegationFixture(d).info, vtxoTreeExpiry: BigInt(source.recovery.batchExpiry) }
  const commitment = Transaction.fromPSBT(base64.decode(source.recovery.commitmentPsbt))
  const leaf = Transaction.fromPSBT(base64.decode(source.recovery.vtxoTree[0].tx))
  const vout = Array.from({ length: leaf.outputsLength }, (_, i) => i).find(
    (i) => hex.encode(leaf.getOutput(i).script!) === d.scriptPubKey,
  )!
  const coin = {
    txid: leaf.id,
    vout,
    value: source.plan.renewal.receiverSats,
    script: d.scriptPubKey,
    createdAt: new Date(source.plan.validAt * 1000),
    expiresAt: new Date(source.plan.inputExpiresAt * 1000),
    commitmentTxIds: [commitment.id],
    isSpent: false,
    isSwept: false,
    isUnrolled: false,
    isPreconfirmed: false,
  } as VirtualCoin
  const status: GuardianDelegationStatus = {
    version: 1,
    operationId: source.plan.request.operationId,
    descriptorHash: lightDescriptorDigest(d),
    state: 'confirmed',
    validAt: source.plan.validAt,
    expiresAt: source.plan.request.expiresAt,
    txid: source.plan.renewal.txid,
    vout: source.plan.renewal.vout,
    inputValueSats: source.plan.renewal.valueSats,
    receiverSats: coin.value,
    commitmentTxid: commitment.id,
    receiverTxid: coin.txid,
    receiverVout: coin.vout,
    receiverExpiresAt: Math.floor(coin.expiresAt!.getTime() / 1000),
    recovery: structuredClone(source.recovery),
  }
  return { d, info, coin, status, commitment, leaf }
}
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('actual native Guardian MuSig recovery graph through the pinned SDK', () => {
  it('imports a signed participant path with omitted sibling references and archives it offline', async () => {
    const f = fixture(pruned)
    const original = structuredClone(f.status.recovery)
    await importGuardianReplacement(f.d, f.status, f.info, f.coin)
    expect(f.status.recovery).toEqual(original)
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<unknown>) => run() } })
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
    const chain = vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockRejectedValue(new Error('offline'))
    const txs = vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockRejectedValue(new Error('offline'))
    const archive = await captureLightRecoveryArchive(f.d, [f.coin])
    expect(validateLightRecoveryArchive(archive, f.d).coins).toEqual([f.coin])
    for (const node of pruned.recovery.vtxoTree) expect(archive.transactions[node.txid]).toBeTruthy()
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
  })

  it.each(['root', 'leaf', 'signature', 'unrelated'] as const)(
    'rejects a pruned path with invalid %s before repository writes',
    async (failure) => {
      const f = fixture(pruned)
      const nodes = f.status.recovery!.vtxoTree
      if (failure === 'root') f.status.recovery!.vtxoTree = nodes.filter((node) => !Object.keys(node.children).length)
      if (failure === 'leaf') f.status.recovery!.vtxoTree = nodes.filter((node) => Object.keys(node.children).length)
      if (failure === 'signature') {
        f.leaf.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) }, true)
        nodes.find((node) => node.txid === f.leaf.id)!.tx = base64.encode(f.leaf.toPSBT())
      }
      if (failure === 'unrelated') nodes.push(structuredClone(native.recovery.vtxoTree[0]))
      await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow()
      const repo = lightExitRepository(f.d)
      expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
      await repo[Symbol.asyncDispose]()
    },
  )

  it('retains a verified spent renewal as ancestry for a live descendant archive', async () => {
    const f = fixture()
    const binding = {
      network: f.d.network,
      descriptorHash: lightDescriptorDigest(f.d),
      scriptPubKey: f.d.scriptPubKey,
      cosignerPub: f.d.cosignerPub,
      absoluteFeeCapSats: f.d.spendingPolicy.absoluteFeeCapSats,
    }
    f.coin.isSpent = true
    await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow()
    await importDelegationReplacementForBinding(binding, f.status, f.info, f.coin, () => lightExitRepository(f.d), true)
    // A transaction-shape fixture exercises ancestry capture; it is not a funded spend/exit claim.
    const child = new Transaction({ version: 3 })
    child.addInput({ txid: f.coin.txid, index: f.coin.vout })
    child.addOutput({ script: hex.decode(f.d.scriptPubKey), amount: BigInt(f.coin.value - 100) })
    const live = { ...f.coin, txid: child.id, vout: 0, value: f.coin.value - 100, isSpent: false }
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [live] })
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
      chain: [
        { txid: f.commitment.id, type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
        { txid: f.leaf.id, type: ChainTxType.TREE, spends: [f.commitment.id], expiresAt: '0' },
        { txid: child.id, type: ChainTxType.TREE, spends: [f.leaf.id], expiresAt: '0' },
      ],
    })
    vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockImplementation(async (ids) => {
      expect(ids).not.toContain(f.leaf.id)
      return { txs: [base64.encode(child.toPSBT())] }
    })
    const repo = lightExitRepository(f.d)
    try {
      const archive = await captureExitArchive(binding, repo, null)
      expect(validateExitArchive(archive, binding).coins.map((coin) => coin.txid)).toEqual([child.id])
      expect(archive.transactions[f.leaf.id]).toBeTruthy()
      const offline = exitArchiveProviders(archive, binding)
      const forbidden = vi.fn(async () => {
        throw new Error('Operator and Guardian are blocked')
      })
      vi.stubGlobal('fetch', forbidden)
      expect(offline.coins[0].txid).toBe(child.id)
      expect(archive.branches[`${child.id}:0`].map((node) => node.txid)).toContain(f.leaf.id)
      expect(
        (await offline.indexerProvider.getVtxos({ outpoints: [{ txid: f.leaf.id, vout: f.coin.vout }] })).vtxos,
      ).toEqual([])
      const branch = await offline.source.getVtxoChain!(live)
      expect(branch?.map((node) => node.txid)).toContain(f.leaf.id)
      const localTransactions = await offline.source.getVirtualTxs!([f.leaf.id, child.id])
      expect(localTransactions.size).toBe(2)
      expect(f.coin.isSpent).toBe(true)
      expect(forbidden).not.toHaveBeenCalled()
    } finally {
      await repo[Symbol.asyncDispose]()
    }
  })
  it('imports verified signed transactions into the SDK repository and captures the ordinary full archive', async () => {
    const f = fixture()
    await importGuardianReplacement(f.d, f.status, f.info, f.coin)
    const repo = lightExitRepository(f.d)
    const first = await repo.getVirtualTx(f.coin.txid)
    expect(Transaction.fromPSBT(base64.decode(first!.psbt!)).getInput(0).tapKeySig).toHaveLength(64)
    await repo[Symbol.asyncDispose]()
    await importGuardianReplacement(f.d, f.status, f.info, f.coin)
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
    const chain = vi
      .spyOn(RestIndexerProvider.prototype, 'getVtxoChain')
      .mockRejectedValue(new Error('No public graph lookup needed'))
    const txs = vi
      .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
      .mockRejectedValue(new Error('No public PSBT lookup needed'))
    const archive = await captureLightRecoveryArchive(f.d, [f.coin])
    expect(validateLightRecoveryArchive(archive, f.d).coins).toEqual([f.coin])
    expect(archive.transactions[f.coin.txid]).toBeTruthy()
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
  })
  it('rejects invalid signatures before any canonical repository write', async () => {
    const f = fixture()
    f.leaf.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) }, true)
    f.status.recovery!.vtxoTree[0].tx = base64.encode(f.leaf.toPSBT())
    await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow(
      'signature or recovery delay',
    )
    const repo = lightExitRepository(f.d)
    expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
    await repo[Symbol.asyncDispose]()
  })
  it('rejects changed commitment, tree root key, receiver, delay and independent indexer facts', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.status.commitmentTxid = 'ff'.repeat(32)
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.receiverSats--
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.recovery!.batchExpiry += 512
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.commitmentTxIds = []
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.expiresAt = new Date(0)
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.isSpent = true
      },
      (f: ReturnType<typeof fixture>) => {
        f.status.recovery!.vtxoTree.push(f.status.recovery!.vtxoTree[0])
      },
      (f: ReturnType<typeof fixture>) => {
        f.commitment.updateOutput(0, { script: hex.decode(f.d.scriptPubKey) }, true)
        f.status.recovery!.commitmentPsbt = base64.encode(f.commitment.toPSBT())
        f.status.commitmentTxid = f.commitment.id
        f.coin.commitmentTxIds = [f.commitment.id]
        f.leaf.updateInput(0, { txid: f.commitment.id }, true)
        f.status.receiverTxid = f.leaf.id
        f.coin.txid = f.leaf.id
        f.status.recovery!.vtxoTree[0] = { txid: f.leaf.id, tx: base64.encode(f.leaf.toPSBT()), children: {} }
        f.status.recovery!.connectors = []
      },
    ]) {
      const f = fixture()
      mutate(f)
      await expect(importGuardianReplacement(f.d, f.status, f.info, f.coin)).rejects.toThrow()
      const repo = lightExitRepository(f.d)
      expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
      await repo[Symbol.asyncDispose]()
    }
  })
})
