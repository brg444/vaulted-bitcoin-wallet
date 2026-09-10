import { expect, it, vi, afterEach } from 'vitest'
import { RestArkProvider, RestIndexerProvider, InMemoryVirtualTxRepository, ChainedTxType } from '@arkade-os/sdk'
import { captureExitArchive, validateExitArchive, type ExitArchive } from './exitArchive'
import receipt from './testdata/funded-receipt-pagination.json'

afterEach(() => vi.restoreAllMocks())
it('captures a funded receipt whose shared ancestry crosses the indexer page boundary, bypassing an incomplete SDK cache', async () => {
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
  // Older SDK versions can persist a short first page with no commitment.
  await repository.upsertVirtualTxs([
    {
      txid: coins[0].txid,
      psbt: (receipt.archive.transactions as Record<string, string>)[coins[0].txid],
      type: ChainedTxType.Ark,
      expiresAt: null,
    },
  ])
  await repository.setBranch(coins[0], [
    { vtxoTxid: coins[0].txid, vtxoVout: coins[0].vout, virtualTxid: coins[0].txid, position: 0 },
  ])
  const archive = await captureExitArchive(binding, repository, null)
  expect(chain).toHaveBeenCalledWith({ txid: coins[0].txid, vout: coins[0].vout }, undefined)
  expect(validateExitArchive(archive, binding).coins[0].value).toBe(50000)
  expect(Object.keys(archive.transactions)).toHaveLength(92)
})
