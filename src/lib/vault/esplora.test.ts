import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECENT_HISTORY_LIMIT } from './constants'
import {
  broadcastTx,
  confirmedSpendables,
  ESPLORA_TX_PAGE_SIZE,
  fetchAddressTxs,
  fetchOlderAddressTxs,
  type EsploraTx,
  type EsploraUtxo,
} from './esplora'

const RAW_TX =
  '0200000000010198f5fe4a8b84239cf3bd9fa9c96802329d2ae42f78eb797f1bc3f0515a39b9cf0100000000ffffffff02983a000000000000225120ca0a318ed6f599f8e89fecb3e419813c345cd69330733b33e49e52561973cb282c460100000000002251208973ae69c51a75646dc396f54f910c6518c3cede49bb0cd288591fd7ba21bb40044055ed0f392d4c26e34fae877cb69cc8b13930464a5d974ea330ef8fe4365f8a520d7b07867e5812b6af3057f29cb6a84d83916cd828c634e68713562fca0da2ae40f6e2df9f024f75265aebfdddd14fb040e82fbbdf8d31ffef4026125e9d241f8fa987f1aec75e1913793e72a53498d63b1a4edbd39df4b6ed3ca4bd93b52fb7a94420003780f6049ff0977a9fdce567116be4ec372b1927d9a028c39b8fa83c4da1a6ad20295314e2ed8f1f026ddf368daab6e1177f0ca9fdf8804df0dbb35f3853186c39ac61c032e127e098956b9a863a8e2b19190149afc415031b4ddcbbccd03a23fe968ae57575000a51de7bbd27e11db694540a2e49c949d7189f8871f2c296d3382c498b4428ad5d2583068d9c7b54aa1787a65d0e34df0e572f803abafd34fb6389421800000000'
const RAW_TXID = '6b15d8425ff82b7fbbbe986474b7a5047f42fb1cfa2d01c4ba4bcea4d48d4fb1'

function utxo(value: number, confirmed = true, txid = 'aa'): EsploraUtxo {
  return { txid, vout: 0, value, status: { confirmed } }
}

describe('confirmedSpendables', () => {
  it('picks the smallest confirmed coin that covers the payment', () => {
    const chosen = confirmedSpendables([utxo(80_000), utxo(20_000), utxo(21_500, false)], 21_000)
    expect(chosen.map((coin) => coin.value)).toEqual([80_000])
  })

  it('combines fragmented confirmed savings in canonical outpoint order', () => {
    const chosen = confirmedSpendables(
      [utxo(30_000, true, 'bb'), utxo(25_000, true, 'aa'), utxo(20_000, false, 'cc')],
      50_000,
    )
    expect(chosen.map((coin) => `${coin.txid}:${coin.vout}`)).toEqual(['aa:0', 'bb:0'])
  })

  it('ignores unconfirmed coins', () => {
    expect(confirmedSpendables([utxo(100_000, false)], 1_000)).toEqual([])
  })
})

function transaction(txid: string, confirmed = true): EsploraTx {
  return { txid, vin: [], vout: [], status: { confirmed } }
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchAddressTxs', () => {
  it('loads subsequent confirmed pages while retaining first-page mempool activity', async () => {
    const first = [transaction('mempool', false)]
    for (let index = 0; index < ESPLORA_TX_PAGE_SIZE; index += 1) first.push(transaction(`confirmed-${index}`))
    const second = [transaction('older')]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(second), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchAddressTxs('tb1p address')

    expect(rows).toHaveLength(ESPLORA_TX_PAGE_SIZE + 2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/esplora/address/tb1p%20address/txs')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/esplora/address/tb1p%20address/txs/chain/confirmed-${ESPLORA_TX_PAGE_SIZE - 1}`,
    )
  })

  it('deduplicates a transaction repeated across moving pages', async () => {
    const first = Array.from({ length: ESPLORA_TX_PAGE_SIZE }, (_, index) => transaction(`tx-${index}`))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([first.at(-1), transaction('older')]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchAddressTxs('tb1psavings')

    expect(rows.filter((row) => row.txid === first.at(-1)?.txid)).toHaveLength(1)
    expect(rows).toHaveLength(ESPLORA_TX_PAGE_SIZE + 1)
  })

  it('caps recent history before an unvirtualized wallet screen becomes unbounded', async () => {
    const pages = Array.from({ length: RECENT_HISTORY_LIMIT / ESPLORA_TX_PAGE_SIZE + 1 }, (_, page) =>
      Array.from({ length: ESPLORA_TX_PAGE_SIZE }, (_unused, index) => transaction(`page-${page}-tx-${index}`)),
    )
    const fetchMock = vi.fn()
    for (const page of pages) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchAddressTxs('tb1psavings')

    expect(fetchMock).toHaveBeenCalledTimes(RECENT_HISTORY_LIMIT / ESPLORA_TX_PAGE_SIZE)
    expect(rows).toHaveLength(RECENT_HISTORY_LIMIT)
    expect(rows.at(-1)?.txid).toBe('page-3-tx-24')
  })
})

describe('fetchOlderAddressTxs', () => {
  it('pages from a known transaction and reports exhaustion honestly', async () => {
    const full = Array.from({ length: ESPLORA_TX_PAGE_SIZE }, (_, index) => transaction(`older-${index}`))
    const partial = [transaction('oldest')]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(full), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(partial), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { transactions, exhausted } = await fetchOlderAddressTxs('tb1psavings', 'cursor-txid')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/esplora/address/tb1psavings/txs/chain/cursor-txid')
    expect(transactions).toHaveLength(ESPLORA_TX_PAGE_SIZE + 1)
    expect(exhausted).toBe(true)
  })

  it('fails retryably when the first older page is unavailable', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchOlderAddressTxs('tb1psavings', 'cursor-txid')).rejects.toThrow('Could not load older activity')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails retryably when a later older page is unavailable', async () => {
    const full = Array.from({ length: ESPLORA_TX_PAGE_SIZE }, (_, index) => transaction(`older-${index}`))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(full), { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchOlderAddressTxs('tb1psavings', 'cursor-txid', 4)).rejects.toThrow(
      'Older activity stopped partway',
    )
  })

  it('fails retryably when pagination stalls on a repeated cursor', async () => {
    const full = Array.from({ length: ESPLORA_TX_PAGE_SIZE }, (_, index) => transaction(`older-${index}`))
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(full), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    // Every page ends on the same transaction, so the cursor never advances.
    await expect(fetchOlderAddressTxs('tb1psavings', 'cursor-txid', 4)).rejects.toThrow('paging stalled')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('broadcastTx', () => {
  it('accepts an exact successful broadcast response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(RAW_TXID)))
    await expect(broadcastTx(RAW_TX)).resolves.toBe(RAW_TXID)
  })

  it('treats a duplicate broadcast as success only when Esplora knows the exact transaction', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('txn-already-in-mempool', { status: 400 }))
      .mockResolvedValueOnce(new Response('{"confirmed":false}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(broadcastTx(RAW_TX)).resolves.toBe(RAW_TXID)
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/esplora/tx/${RAW_TXID}/status`, { cache: 'no-store' })
  })

  it('preserves the broadcast failure when the transaction is not known', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('mandatory-script-verify-flag-failed', { status: 400 }))
        .mockResolvedValueOnce(new Response('not found', { status: 404 })),
    )
    await expect(broadcastTx(RAW_TX)).rejects.toThrow('mandatory-script-verify-flag-failed')
  })
})
