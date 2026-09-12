import { olderRowKey, type VaultHistoryItem } from './history'
import { describePayment, paymentIdentityForItem, type PaymentScope } from './payments'
import { loadArrivalBaseline } from './arrivalBaseline'

interface PaymentArrival {
  key: string
  item: VaultHistoryItem
}

const EMPTY_EXCLUDED: ReadonlySet<string> = new Set()

/** True when a row can announce: a complete receipt of verified external funds. */
function isArrivalCandidate(row: VaultHistoryItem, outgoingTxids: ReadonlySet<string>): boolean {
  if (row.type !== 'received' || outgoingTxids.has(row.txid)) return false
  const described = describePayment(row)
  return described.origin === 'verified-external' && described.complete
}

function outgoingReferences(rows: readonly VaultHistoryItem[]): Set<string> {
  // A receive sharing its transaction id with an outflow in the same history
  // is the wallet moving its own funds (for example Spending to Savings in
  // one Bitcoin transaction), never a new external receipt. Retained
  // `bitcoin:` placeholders carry no transaction id and never suppress.
  return new Set(rows.filter((row) => row.type === 'sent' && !row.txid.startsWith('bitcoin:')).map((row) => row.txid))
}

/**
 * Browsing history loaded beyond the recent window never feeds arrival
 * observation: older receipts are marked seen without announcing, so paging
 * through history cannot manufacture a new-payment alert.
 */
export function detectPaymentArrivals(
  seen: ReadonlyMap<string, boolean>,
  rows: readonly VaultHistoryItem[],
  scope: PaymentScope,
  excludedKeys: ReadonlySet<string> = EMPTY_EXCLUDED,
): { arrivals: PaymentArrival[]; seen: Map<string, boolean> } {
  const next = new Map(seen)
  const arrivals: PaymentArrival[] = []
  const outgoingTxids = outgoingReferences(rows)
  for (const row of rows) {
    const key = paymentIdentityForItem(row, scope).key
    const available = isArrivalCandidate(row, outgoingTxids)
    const was = next.get(key)
    if (was === undefined) {
      next.set(key, available)
      if (available && !excludedKeys.has(olderRowKey(row))) arrivals.push({ key, item: row })
      continue
    }
    if (available && !was) {
      // Record the available transition as seen even while excluded: the
      // notice stays suppressed, but removing the exclusion later must not
      // replay the historical receipt as a new arrival.
      next.set(key, true)
      if (!excludedKeys.has(olderRowKey(row))) arrivals.push({ key, item: row })
    }
  }
  return { arrivals, seen: next }
}

export function seedArrivalBaseline(rows: readonly VaultHistoryItem[], scope: PaymentScope): Map<string, boolean> {
  const seeded = loadArrivalBaseline(scope)
  // Every present row seeds quietly, whether or not a stored baseline
  // exists. A nonempty map is not evidence that an absent row is new: capped
  // baselines, partial snapshots, and restored data can all omit old
  // records, so absence from the cache never proves newness. Supported
  // reopen catch-up covers retained pending-to-available identity
  // transitions, which detection observes as state changes on known keys.
  // Brand-new IDs while closed stay unsupported until per-source
  // completeness evidence can prove them new.
  const outgoingTxids = outgoingReferences(rows)
  for (const row of rows) {
    const key = paymentIdentityForItem(row, scope).key
    if (seeded.has(key)) continue
    seeded.set(key, isArrivalCandidate(row, outgoingTxids))
  }
  return seeded
}
