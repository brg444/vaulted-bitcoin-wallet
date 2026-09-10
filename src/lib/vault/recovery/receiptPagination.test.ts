import { expect, it, vi, afterEach } from 'vitest'
import {
  RestArkProvider,
  RestIndexerProvider,
  InMemoryVirtualTxRepository,
  ChainedTxType,
  ChainTxType,
} from '@arkade-os/sdk'
import { captureExitArchive, validateExitArchive, type ExitArchive } from './exitArchive'
import receipt from './testdata/funded-receipt-pagination.json'

afterEach(() => vi.restoreAllMocks())
it.each(['missing commitment', 'missing parent', 'complete'] as const)(
  'captures a funded receipt with a %s cache across the indexer page boundary',
  async (cache) => {
    const binding = {
      network: 'mutinynet',
      descriptorHash: receipt.archive.descriptorHash,
      scriptPubKey: JSON.parse(receipt.archive.coins)[0].script,
    }
    const { info, coins } = validateExitArchive(receipt.archive as ExitArchive, binding)
    expect(receipt.rawChain.length).toBeGreaterThan(100)
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(info)
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: coins })
    const chain = vi
      .spyOn(RestIndexerProvider.prototype, 'getVtxoChain')
      .mockImplementation(async (_, options) =>
        options
          ? { chain: receipt.rawChain.slice(0, 100) as never, page: { current: 1, next: 2, total: 2 } }
          : { chain: receipt.rawChain as never },
      )
    vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockImplementation(async (ids) => ({
      txs: ids.flatMap((id) => (receipt.archive.transactions as Record<string, string>)[id] || []),
    }))
    const repository = new InMemoryVirtualTxRepository()
    const types = {
      [ChainTxType.COMMITMENT]: ChainedTxType.Commitment,
      [ChainTxType.ARK]: ChainedTxType.Ark,
      [ChainTxType.TREE]: ChainedTxType.Tree,
      [ChainTxType.CHECKPOINT]: ChainedTxType.Checkpoint,
      [ChainTxType.UNSPECIFIED]: ChainedTxType.Unspecified,
    }
    const complete =
      receipt.archive.branches[`${coins[0].txid}:${coins[0].vout}` as keyof typeof receipt.archive.branches]
    const parent = complete.find((node) => node.txid !== coins[0].txid && node.type !== ChainTxType.COMMITMENT)!
    const cached = complete.filter((node) =>
      cache === 'missing commitment'
        ? node.txid === coins[0].txid
        : cache === 'missing parent'
          ? node.txid !== parent.txid
          : true,
    )
    if (cache === 'missing parent') expect(cached.some((node) => node.type === ChainTxType.COMMITMENT)).toBe(true)
    await repository.upsertVirtualTxs(
      cached.map((node) => ({
        txid: node.txid,
        psbt: (receipt.archive.transactions as Record<string, string>)[node.txid] ?? null,
        type: types[node.type as ChainTxType],
        expiresAt: null,
      })),
    )
    await repository.setBranch(
      coins[0],
      cached.map((node, position) => ({
        vtxoTxid: coins[0].txid,
        vtxoVout: coins[0].vout,
        virtualTxid: node.txid,
        position,
      })),
    )
    const archive = await captureExitArchive(binding, repository, null)
    if (cache === 'complete') expect(chain).not.toHaveBeenCalled()
    else expect(chain).toHaveBeenCalledWith({ txid: coins[0].txid, vout: coins[0].vout }, undefined)
    expect(validateExitArchive(archive, binding).coins[0].value).toBe(50000)
    expect(Object.keys(archive.transactions)).toHaveLength(92)
  },
)
