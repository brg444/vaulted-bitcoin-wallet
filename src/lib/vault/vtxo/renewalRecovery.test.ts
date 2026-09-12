import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Transaction, RestArkProvider, RestIndexerProvider, ChainTxType } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { nativeRenewalAccounts, nativeRenewalFixture } from './testdata/nativeRenewal'
import { importSpendingRenewalReplacement, requireSpendingRenewalAncestry } from './renewalRecovery'
import { captureExitArchive, exitArchiveProviders, validateExitArchive } from '../recovery/exitArchive'
import { vaultExitRepository } from './exitRepository'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe.each(nativeRenewalAccounts)('native renewal recovery for $network $tier through the pinned SDK', (account) => {
  const fixture = (pruned = false) => nativeRenewalFixture(account, pruned)
  const repository = (f: ReturnType<typeof fixture>) => vaultExitRepository(f.status.vaultId, f.status.network)
  const binding = (f: ReturnType<typeof fixture>) => ({
    network: f.status.network as 'mainnet' | 'mutinynet',
    descriptorHash: f.result.descriptorHash,
    scriptPubKey: f.status.spendingArkScript!,
  })
  const capture = async (f: ReturnType<typeof fixture>) => {
    const repo = repository(f)
    try {
      return await captureExitArchive(binding(f), repo, null)
    } finally {
      await repo[Symbol.asyncDispose]()
    }
  }
  it('uses verified local ancestry for a subsequent authorization without public graph lookup', async () => {
    const f = fixture(true)
    await importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)
    const indexer = new RestIndexerProvider('https://operator.invalid')
    const chain = vi.spyOn(indexer, 'getVtxoChain').mockRejectedValue(new Error('offline'))
    const txs = vi.spyOn(indexer, 'getVirtualTxs').mockRejectedValue(new Error('offline'))
    await expect(requireSpendingRenewalAncestry(f.status, f.coin, f.info, indexer)).resolves.toBeUndefined()
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
    for (const change of [
      { commitmentTxIds: [] },
      { commitmentTxIds: ['ff'.repeat(32)] },
      { script: '5120' + '01'.repeat(32) },
    ]) {
      await expect(
        requireSpendingRenewalAncestry(f.status, { ...f.coin, ...change }, f.info, indexer),
      ).rejects.toThrow()
    }
  })

  it('imports a signed participant path with omitted sibling references and archives it offline', async () => {
    const f = fixture(true)
    const original = structuredClone(f.result.recovery)
    await importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)
    expect(f.result.recovery).toEqual(original)
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<unknown>) => run() } })
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
    const chain = vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockRejectedValue(new Error('offline'))
    const txs = vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockRejectedValue(new Error('offline'))
    const archive = await capture(f)
    expect(validateExitArchive(archive, binding(f)).coins).toEqual([f.coin])
    for (const node of original!.vtxoTree) {
      const saved = Transaction.fromPSBT(base64.decode(archive.transactions[node.txid]))
      expect(saved.getInput(0).witnessUtxo).toBeDefined()
      expect(saved.id).toBe(node.txid)
      expect(saved.getInput(0).tapKeySig).toEqual(Transaction.fromPSBT(base64.decode(node.tx)).getInput(0).tapKeySig)
    }
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
  })

  it.each(['root', 'leaf', 'signature', 'unrelated'] as const)(
    'rejects a pruned path with invalid %s before repository writes',
    async (failure) => {
      const f = fixture(true)
      const nodes = f.result.recovery!.vtxoTree
      if (failure === 'root') f.result.recovery!.vtxoTree = nodes.filter((node) => !Object.keys(node.children).length)
      if (failure === 'leaf') f.result.recovery!.vtxoTree = nodes.filter((node) => Object.keys(node.children).length)
      if (failure === 'signature') {
        f.leaf.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) }, true)
        nodes.find((node) => node.txid === f.leaf.id)!.tx = base64.encode(f.leaf.toPSBT())
      }
      if (failure === 'unrelated') {
        f.sibling.updateOutput(0, { amount: 9000n }, true)
        nodes.push({ txid: f.sibling.id, tx: base64.encode(f.sibling.toPSBT()), children: {} })
      }
      await expect(importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)).rejects.toThrow()
      const repo = repository(f)
      expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
      await repo[Symbol.asyncDispose]()
    },
  )

  it('retains a verified spent renewal as ancestry for a live descendant archive', async () => {
    const f = fixture()
    const archiveBinding = binding(f)
    f.coin.isSpent = true
    await importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)
    // A transaction-shape fixture exercises ancestry capture; it is not a funded spend/exit claim.
    const child = new Transaction({ version: 3 })
    child.addInput({ txid: f.coin.txid, index: f.coin.vout })
    child.addOutput({ script: hex.decode(f.status.spendingArkScript!), amount: BigInt(f.coin.value - 100) })
    const live = { ...f.coin, txid: child.id, vout: 0, value: f.coin.value - 100, isSpent: false }
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [live] })
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
      chain: [
        { txid: f.commitment.id, type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
        { txid: f.root.id, type: ChainTxType.TREE, spends: [f.commitment.id], expiresAt: '0' },
        { txid: f.leaf.id, type: ChainTxType.TREE, spends: [f.root.id], expiresAt: '0' },
        { txid: child.id, type: ChainTxType.TREE, spends: [f.leaf.id], expiresAt: '0' },
      ],
    })
    vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockImplementation(async (ids) => {
      expect(ids).not.toContain(f.leaf.id)
      return { txs: [base64.encode(child.toPSBT())] }
    })
    const repo = repository(f)
    try {
      const archive = await captureExitArchive(archiveBinding, repo, null)
      expect(validateExitArchive(archive, archiveBinding).coins.map((coin) => coin.txid)).toEqual([child.id])
      expect(archive.transactions[f.leaf.id]).toBeTruthy()
      const offline = exitArchiveProviders(archive, archiveBinding)
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
    await importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)
    const repo = repository(f)
    const first = await repo.getVirtualTx(f.coin.txid)
    expect(Transaction.fromPSBT(base64.decode(first!.psbt!)).getInput(0).tapKeySig).toHaveLength(64)
    await repo[Symbol.asyncDispose]()
    await importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
    const chain = vi
      .spyOn(RestIndexerProvider.prototype, 'getVtxoChain')
      .mockRejectedValue(new Error('No public graph lookup needed'))
    const txs = vi
      .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
      .mockRejectedValue(new Error('No public PSBT lookup needed'))
    const archive = await capture(f)
    expect(validateExitArchive(archive, binding(f)).coins).toEqual([f.coin])
    expect(archive.transactions[f.coin.txid]).toBeTruthy()
    expect(chain).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
  })
  it('rejects invalid signatures before any canonical repository write', async () => {
    const f = fixture()
    f.leaf.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) }, true)
    f.result.recovery!.vtxoTree[0].tx = base64.encode(f.leaf.toPSBT())
    await expect(importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)).rejects.toThrow(
      'signature or recovery delay',
    )
    const repo = repository(f)
    expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
    await repo[Symbol.asyncDispose]()
  })
  it('rejects changed commitment, tree root key, receiver, delay and independent indexer facts', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.result.commitmentTxid = 'ff'.repeat(32)
      },
      (f: ReturnType<typeof fixture>) => {
        f.result.receiverSats--
      },
      (f: ReturnType<typeof fixture>) => {
        f.result.recovery!.batchExpiry += 512
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.commitmentTxIds = []
      },
      (f: ReturnType<typeof fixture>) => {
        f.coin.expiresAt = new Date(0)
      },
      (f: ReturnType<typeof fixture>) => {
        f.result.program = 'vault-light-policy-v1'
      },
      (f: ReturnType<typeof fixture>) => {
        f.result.recovery!.vtxoTree.push(f.result.recovery!.vtxoTree[0])
      },
      (f: ReturnType<typeof fixture>) => {
        f.commitment.updateOutput(0, { script: hex.decode(f.status.spendingArkScript!) }, true)
        f.result.recovery!.commitmentPsbt = base64.encode(f.commitment.toPSBT())
        f.result.commitmentTxid = f.commitment.id
        f.coin.commitmentTxIds = [f.commitment.id]
        f.leaf.updateInput(0, { txid: f.commitment.id }, true)
        f.result.receiverTxid = f.leaf.id
        f.coin.txid = f.leaf.id
        f.result.recovery!.vtxoTree[0] = { txid: f.leaf.id, tx: base64.encode(f.leaf.toPSBT()), children: {} }
        f.result.recovery!.connectors = []
      },
    ]) {
      const f = fixture()
      mutate(f)
      await expect(importSpendingRenewalReplacement(f.status, f.result, f.info, f.coin)).rejects.toThrow()
      const repo = repository(f)
      expect(await repo.getVirtualTx(f.coin.txid)).toBeNull()
      await repo[Symbol.asyncDispose]()
    }
  })
})
