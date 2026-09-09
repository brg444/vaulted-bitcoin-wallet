import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import { describePayment, paymentIdentityForItem, type PaymentScope } from '../lib/vault/payments'
import { loadArrivalBaseline, saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import { hapticSubtle } from '../lib/haptics'

export interface PaymentArrival {
  key: string
  item: VaultHistoryItem
}

/**
 * Edge detection for incoming payments. A payment banners once: either it is
 * first observed with funds already available, or it transitions from an
 * incomplete row to a verified available one. Only rows with verified
 * external provenance banner; internal movement, uncertain receipts,
 * outflows, and incomplete rows never do. History is display data; this hook
 * reads rows and queues notices without touching any lifecycle.
 *
 * Readiness: detection starts only after a successful baseline snapshot for
 * the active scope (cached or refreshed). Earlier history is ignored, never
 * queued, so a cold load cannot turn stored rows into new-payment alerts.
 * Presented payments persist as device-local receipts, so a reload or a
 * staged hydration replays nothing. Clearing local data reseeds quietly from
 * whatever history loads first.
 */
/** True when a row can banner: a complete receipt of verified external funds. */
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

export function detectPaymentArrivals(
  seen: ReadonlyMap<string, boolean>,
  rows: readonly VaultHistoryItem[],
  scope: PaymentScope,
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
      if (available) arrivals.push({ key, item: row })
      continue
    }
    if (available && !was) {
      next.set(key, true)
      arrivals.push({ key, item: row })
    }
  }
  return { arrivals, seen: next }
}

export function seedArrivalBaseline(rows: readonly VaultHistoryItem[], scope: PaymentScope): Map<string, boolean> {
  const seeded = loadArrivalBaseline(scope)
  const outgoingTxids = outgoingReferences(rows)
  for (const row of rows) {
    const key = paymentIdentityForItem(row, scope).key
    if (seeded.has(key)) continue
    seeded.set(key, isArrivalCandidate(row, outgoingTxids))
  }
  return seeded
}

const MAX_VISIBLE_ARRIVALS = 3

export function usePaymentArrivals(
  history: readonly VaultHistoryItem[],
  scope: PaymentScope,
  paused: boolean,
  ready: boolean,
): {
  arrivals: PaymentArrival[]
  dismissArrival: (key: string) => void
  openArrivalKey: (key: string) => VaultHistoryItem | null
} {
  const [arrivals, setArrivals] = useState<PaymentArrival[]>([])
  const seenRef = useRef<Map<string, boolean> | null>(null)
  const pendingRef = useRef<PaymentArrival[]>([])
  const scopeKey = `${scope.network}:${scope.vaultId}`
  const scopeRef = useRef(scopeKey)
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey
    seenRef.current = null
    pendingRef.current = []
    setArrivals([])
  }

  useEffect(() => {
    if (!ready) return
    if (!seenRef.current) {
      // The first post-readiness history merges into the stored baseline.
      // With no stored baseline this seeds quietly, so a fresh load never
      // replays old payments; with one, genuinely new available keys banner.
      seenRef.current = seedArrivalBaseline(history, scope)
    } else {
      // Another tab may have presented arrivals since this tab's last run.
      // Merge stored keys so a payment banners in at most one tab. A
      // simultaneous detection race across tabs remains explicitly pending.
      for (const [key, available] of loadArrivalBaseline(scope)) {
        if (!seenRef.current.has(key)) seenRef.current.set(key, available)
      }
    }
    const { arrivals: fresh, seen } = detectPaymentArrivals(seenRef.current, history, scope)
    seenRef.current = seen
    saveArrivalBaseline(scope, seen, new Set(history.map((row) => paymentIdentityForItem(row, scope).key)))
    if (fresh.length === 0) return
    if (paused) {
      const queued = new Map(pendingRef.current.map((arrival) => [arrival.key, arrival]))
      for (const arrival of fresh) queued.set(arrival.key, arrival)
      pendingRef.current = [...queued.values()]
      return
    }
    hapticSubtle()
    setArrivals((current) => {
      const queued = new Map(current.map((arrival) => [arrival.key, arrival]))
      for (const arrival of [...pendingRef.current, ...fresh]) queued.set(arrival.key, arrival)
      pendingRef.current = []
      return [...queued.values()].slice(-MAX_VISIBLE_ARRIVALS)
    })
    // paused intentionally gates delivery without reseeding the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, ready])

  useEffect(() => {
    if (paused || pendingRef.current.length === 0) return
    const flushed = pendingRef.current
    pendingRef.current = []
    hapticSubtle()
    setArrivals((current) => {
      const queued = new Map(current.map((arrival) => [arrival.key, arrival]))
      for (const arrival of flushed) queued.set(arrival.key, arrival)
      return [...queued.values()].slice(-MAX_VISIBLE_ARRIVALS)
    })
  }, [paused])

  const dismissArrival = useCallback((key: string) => {
    pendingRef.current = pendingRef.current.filter((arrival) => arrival.key !== key)
    setArrivals((current) => current.filter((arrival) => arrival.key !== key))
  }, [])

  const openArrivalKey = useCallback(
    (key: string) => {
      const arrival = [...pendingRef.current, ...arrivals].find((candidate) => candidate.key === key)
      return arrival?.item || null
    },
    [arrivals],
  )

  return { arrivals, dismissArrival, openArrivalKey }
}
