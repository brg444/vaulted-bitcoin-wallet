import { expect, it, vi } from 'vitest'
import { ChainTxType, type IndexerProvider } from '@arkade-os/sdk'
import { pagedRecoveryIndexer } from './pagedIndexer'

const outpoint = { txid: 'aa'.repeat(32), vout: 0 }
const node = (id: string, type = ChainTxType.ARK) => ({ txid: id.repeat(32), type, spends: [], expiresAt: '0' })
it('follows the server cursor when a short first page omits the Bitcoin commitment', async () => {
  const getVtxoChain = vi
    .fn()
    .mockResolvedValueOnce({
      chain: [node('aa')],
      page: { current: 1, next: 2, total: 2 },
    })
    .mockResolvedValueOnce({
      chain: [node('bb', ChainTxType.COMMITMENT)],
      page: { current: 2, next: 2, total: 2 },
    })
  const indexer = pagedRecoveryIndexer({ getVtxoChain } as unknown as IndexerProvider)
  expect((await indexer.getVtxoChain(outpoint)).chain).toHaveLength(2)
  expect(getVtxoChain.mock.calls.map((call) => call[1]?.pageIndex)).toEqual([undefined, 2])
})
it('fetches all virtual transaction pages and leaves ordinary wallet reads with the SDK', async () => {
  const getVirtualTxs = vi
    .fn()
    .mockResolvedValueOnce({
      txs: ['first'],
      page: { current: 1, next: 2, total: 2 },
    })
    .mockResolvedValueOnce({ txs: ['second'], page: { current: 2, next: 0, total: 2 } })
  const native = {
    getVirtualTxs,
    getVtxos: vi.fn(async function (this: unknown) {
      expect(this).toBe(native)
      return { vtxos: [] }
    }),
  }
  const indexer = pagedRecoveryIndexer(native as unknown as IndexerProvider)
  expect(await indexer.getVirtualTxs(['aa', 'bb'])).toEqual({ txs: ['first', 'second'] })
  await indexer.getVtxos({ outpoints: [outpoint] })
  expect(native.getVtxos).toHaveBeenCalledOnce()
})
it.each([
  { current: 1, next: 1, total: 2 },
  { current: 1, next: 3, total: 2 },
  { current: 1, next: 2.5, total: 3 },
])('rejects nonadvancing or invalid metadata %j', async (page) => {
  const getVtxoChain = vi.fn().mockResolvedValue({ chain: [node('aa')], page })
  await expect(
    pagedRecoveryIndexer({ getVtxoChain } as unknown as IndexerProvider).getVtxoChain(outpoint),
  ).rejects.toThrow('pagination')
})
it('rejects repeated pages even if the server claims the cursor advanced', async () => {
  const getVtxoChain = vi.fn().mockResolvedValue({ chain: [node('aa')], page: { current: 1, next: 2, total: 3 } })
  await expect(
    pagedRecoveryIndexer({ getVtxoChain } as unknown as IndexerProvider).getVtxoChain(outpoint),
  ).rejects.toThrow('pagination')
  expect(getVtxoChain).toHaveBeenCalledTimes(2)
})
