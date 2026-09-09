import { readBounded } from './bounded'
import { RECENT_HISTORY_LIMIT } from './constants'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'

export function esploraBase(): string {
  return '/esplora'
}

export interface EsploraUtxo {
  txid: string
  vout: number
  status: { confirmed: boolean; block_height?: number }
  value: number
}

async function esploraJson<T>(res: Response, fail: string): Promise<T> {
  const text = await readBounded(res)
  if (!res.ok) throw new Error(fail)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(fail)
  }
}

export interface EsploraTxio {
  scriptpubkey_address?: string
  value?: number
}

export interface EsploraTx {
  txid: string
  vin: { prevout?: EsploraTxio }[]
  vout: EsploraTxio[]
  status: { confirmed: boolean; block_height?: number; block_time?: number }
}

export const ESPLORA_TX_PAGE_SIZE = 25
const MAX_ESPLORA_TX_PAGES = Math.ceil(RECENT_HISTORY_LIMIT / ESPLORA_TX_PAGE_SIZE)

async function fetchAddressTxPage(address: string, cursor: string): Promise<EsploraTx[]> {
  const encodedAddress = encodeURIComponent(address)
  const suffix = cursor ? `/chain/${encodeURIComponent(cursor)}` : ''
  const res = await fetch(`${esploraBase()}/address/${encodedAddress}/txs${suffix}`)
  return esploraJson<EsploraTx[]>(res, 'Could not load activity')
}

function mergeAddressTx(accumulated: Map<string, EsploraTx>, transactions: EsploraTx[]): void {
  for (const transaction of transactions) {
    const previous = accumulated.get(transaction.txid)
    if (!previous || (!previous.status.confirmed && transaction.status.confirmed)) {
      accumulated.set(transaction.txid, transaction)
    }
  }
}

export async function fetchAddressTxs(address: string): Promise<EsploraTx[]> {
  const byTxid = new Map<string, EsploraTx>()
  const cursors = new Set<string>()
  let cursor = ''
  for (let page = 0; page < MAX_ESPLORA_TX_PAGES; page += 1) {
    const transactions = await fetchAddressTxPage(address, cursor)
    mergeAddressTx(byTxid, transactions)
    const confirmed = transactions.filter((transaction) => transaction.status.confirmed)
    if (confirmed.length < ESPLORA_TX_PAGE_SIZE) break
    const next = confirmed.at(-1)?.txid || ''
    if (!next || cursors.has(next)) break
    cursors.add(next)
    cursor = next
  }
  return [...byTxid.values()].slice(0, RECENT_HISTORY_LIMIT)
}

/**
 * Older Bitcoin records beyond the recent window, paged from a known
 * transaction id. Only Esplora-backed address history supports this; SDK
 * activity, journals, and local approval records are already complete.
 * Returns the records and whether the address is exhausted. A failed page or
 * a stalled cursor throws a retryable error instead of masquerading as an
 * empty result, so the caller can offer a retry without losing its place.
 */
export async function fetchOlderAddressTxs(
  address: string,
  afterTxid: string,
  pages = MAX_ESPLORA_TX_PAGES,
): Promise<{ transactions: EsploraTx[]; exhausted: boolean }> {
  const byTxid = new Map<string, EsploraTx>()
  const cursors = new Set<string>()
  let cursor = afterTxid
  for (let page = 0; page < Math.max(1, pages); page += 1) {
    let transactions: EsploraTx[]
    try {
      transactions = await fetchAddressTxPage(address, cursor)
    } catch {
      throw new Error(
        page === 0 ? 'Could not load older activity' : 'Older activity stopped partway before finishing the window',
      )
    }
    mergeAddressTx(byTxid, transactions)
    const confirmed = transactions.filter((transaction) => transaction.status.confirmed)
    if (confirmed.length < ESPLORA_TX_PAGE_SIZE) return { transactions: [...byTxid.values()], exhausted: true }
    const next = confirmed.at(-1)?.txid || ''
    if (!next || next === cursor || cursors.has(next)) {
      throw new Error('Older activity paging stalled without advancing')
    }
    cursors.add(next)
    cursor = next
  }
  return { transactions: [...byTxid.values()], exhausted: false }
}

export async function fetchAddressUtxos(address: string): Promise<EsploraUtxo[]> {
  const res = await fetch(`${esploraBase()}/address/${address}/utxo`)
  return esploraJson<EsploraUtxo[]>(res, 'Could not load coins')
}

export async function fetchTxHex(txid: string): Promise<string> {
  const res = await fetch(`${esploraBase()}/tx/${txid}/hex`)
  const text = await readBounded(res)
  if (!res.ok) throw new Error('Could not load the previous transaction')
  return text.trim()
}

export async function fetchAddressStats(address: string): Promise<{ funded: number; spent: number }> {
  const res = await fetch(`${esploraBase()}/address/${address}`)
  const body = await esploraJson<{ chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } }>(
    res,
    'Could not load the balance',
  )
  const chain = body.chain_stats || {}
  return {
    funded: Number(chain.funded_txo_sum || 0),
    spent: Number(chain.spent_txo_sum || 0),
  }
}

function compareOutpoints(a: EsploraUtxo, b: EsploraUtxo): number {
  return a.txid.localeCompare(b.txid) || a.vout - b.vout
}

export function confirmedSpendables(utxos: EsploraUtxo[], need: number): EsploraUtxo[] {
  if (!Number.isSafeInteger(need) || need <= 0) return []
  const confirmed = utxos.filter((utxo) => utxo.status.confirmed && Number.isSafeInteger(utxo.value) && utxo.value > 0)
  const single = confirmed
    .filter((utxo) => utxo.value >= need)
    .sort((a, b) => a.value - b.value || compareOutpoints(a, b))[0]
  if (single) return [single]

  const selected: EsploraUtxo[] = []
  let total = 0
  for (const utxo of confirmed.sort((a, b) => b.value - a.value || compareOutpoints(a, b))) {
    selected.push(utxo)
    total += utxo.value
    if (total >= need) return selected.sort(compareOutpoints)
  }
  return []
}

export async function fetchTipHeight(): Promise<number> {
  const res = await fetch(`${esploraBase()}/blocks/tip/height`)
  const text = await readBounded(res)
  if (!res.ok) throw new Error('Could not load the chain tip')
  const height = Number(text.trim())
  if (!Number.isInteger(height) || height < 0) throw new Error('Could not load the chain tip')
  return height
}

export async function fetchFeeEstimates(): Promise<Record<string, number>> {
  const res = await fetch(`${esploraBase()}/fee-estimates`)
  const estimates = await esploraJson<Record<string, number>>(res, 'Could not load fee estimates')
  if (!estimates || typeof estimates !== 'object' || Array.isArray(estimates)) {
    throw new Error('Could not load fee estimates')
  }
  return estimates
}

export async function broadcastTx(txHex: string): Promise<string> {
  const expectedTxid = Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).id
  const res = await fetch(`${esploraBase()}/tx`, { method: 'POST', body: txHex })
  const text = await readBounded(res)
  if (res.ok) {
    const returnedTxid = text.trim()
    if (returnedTxid !== expectedTxid) throw new Error('Broadcast returned the wrong transaction id')
    return expectedTxid
  }

  // A retry after a lost response commonly returns "already in mempool". Only
  // accept it when Esplora confirms this exact locally-derived transaction id.
  try {
    const known = await fetch(`${esploraBase()}/tx/${expectedTxid}/status`, { cache: 'no-store' })
    if (known.ok) return expectedTxid
  } catch {
    // Preserve the original broadcast error below.
  }
  throw new Error(text.trim() || 'Could not broadcast')
}
