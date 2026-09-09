import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import { describePayment, paymentIdentityForItem, type PaymentScope } from '../lib/vault/payments'
import { hapticSubtle } from '../lib/haptics'

export interface PaymentArrival {
  key: string
  item: VaultHistoryItem
}

/**
 * Edge detection for incoming payments. A payment banners once: either it is
 * first observed with funds already available, or it transitions from an
 * incomplete row to a verified available one. Outflows, internal movement,
 * and incomplete rows never banner. History is display data; this hook reads
 * rows and queues notices without touching any lifecycle.
 *
 * The baseline seeds silently from the first observed history, so a fresh
 * load or vault switch never replays old payments as new arrivals. Durable
 * cross-session receipts, reconnect summaries, and preferences arrive with
 * the foreground delivery work; until then a reload reseeds quietly.
 */
export function detectPaymentArrivals(
  seen: ReadonlyMap<string, boolean>,
  rows: readonly VaultHistoryItem[],
  scope: PaymentScope,
): { arrivals: PaymentArrival[]; seen: Map<string, boolean> } {
  const next = new Map(seen)
  const arrivals: PaymentArrival[] = []
  for (const row of rows) {
    const key = paymentIdentityForItem(row, scope).key
    const described = describePayment(row)
    const available = row.type === 'received' && !described.suppressArrival && described.complete
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

const MAX_VISIBLE_ARRIVALS = 3

export function usePaymentArrivals(
  history: readonly VaultHistoryItem[],
  scope: PaymentScope,
  paused: boolean,
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
    if (!seenRef.current) {
      // The first observed history is the quiet baseline: mark every row as
      // seen without bannering, so a fresh load never replays old payments.
      const seeded = new Map<string, boolean>()
      for (const row of history) {
        const described = describePayment(row)
        seeded.set(
          paymentIdentityForItem(row, scope).key,
          row.type === 'received' && !described.suppressArrival && described.complete,
        )
      }
      seenRef.current = seeded
      return
    }
    const { arrivals: fresh, seen } = detectPaymentArrivals(seenRef.current, history, scope)
    seenRef.current = seen
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
  }, [history])

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
