import { useCallback, useEffect, useReducer, useRef } from 'react'
import { olderRowKey, type VaultHistoryItem } from '../lib/vault/history'
import { describePayment, paymentIdentityForItem, type PaymentScope } from '../lib/vault/payments'
import { loadArrivalBaseline, saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import { claimArrivalDelivery } from '../lib/vault/arrivalDelivery'
import { hapticSubtle } from '../lib/haptics'

export interface PaymentArrival {
  key: string
  item: VaultHistoryItem
}

/**
 * One accessible catch-up notice for newly verified incoming payments that
 * landed together, such as after reconnect or reopen. A single summary
 * replaces a burst of individual banners; one fresh payment still banners
 * alone. The summary links to full Activity and never replays: its keys are
 * claimed and marked seen like any delivered arrival.
 */
export interface PaymentCatchUp {
  count: number
  totalSats: number
  keys: string[]
  items: PaymentArrival[]
}

export function summarizeArrivals(arrivals: readonly PaymentArrival[]): PaymentCatchUp {
  const keys = arrivals.map((arrival) => arrival.key)
  return {
    count: arrivals.length,
    totalSats: arrivals.reduce((total, arrival) => total + (arrival.item.displayAmount ?? arrival.item.amount), 0),
    keys,
    items: [...arrivals],
  }
}

interface ArrivalNotices {
  arrivals: PaymentArrival[]
  catchUp: PaymentCatchUp | null
}

const EMPTY_NOTICES: ArrivalNotices = { arrivals: [], catchUp: null }

type NoticesAction =
  | { type: 'present'; accepted: PaymentArrival[] }
  | { type: 'dismiss'; key: string }
  | { type: 'dismiss-summary' }
  | { type: 'reset' }

/**
 * Atomic notice updates: every presentation merges into one state value, so
 * two deliveries resolving before React renders union instead of
 * overwriting. A lone fresh payment banners alone only when nothing is
 * already showing; otherwise everything folds into a single catch-up
 * summary, and successive batches never stack a burst alongside it.
 */
function noticesReducer(state: ArrivalNotices, action: NoticesAction): ArrivalNotices {
  switch (action.type) {
    case 'present': {
      if (action.accepted.length === 0) return state
      const pool = new Map<string, PaymentArrival>()
      for (const arrival of [...(state.catchUp?.items ?? []), ...state.arrivals, ...action.accepted]) {
        pool.set(arrival.key, arrival)
      }
      const combined = [...pool.values()]
      if (!state.catchUp && state.arrivals.length === 0 && action.accepted.length === 1 && combined.length === 1) {
        return { arrivals: combined.slice(-MAX_VISIBLE_ARRIVALS), catchUp: null }
      }
      return { arrivals: [], catchUp: summarizeArrivals(combined) }
    }
    case 'dismiss':
      if (!state.arrivals.some((arrival) => arrival.key === action.key)) return state
      return { ...state, arrivals: state.arrivals.filter((arrival) => arrival.key !== action.key) }
    case 'dismiss-summary':
      return state.catchUp ? { ...state, catchUp: null } : state
    case 'reset':
      return EMPTY_NOTICES
  }
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
 * the active scope, fetched successfully. Earlier history is ignored, never
 * queued, so a cold load cannot turn stored rows into new-payment alerts.
 * Presented payments persist as device-local receipts, so a reload or a
 * staged hydration replays nothing. Clearing local data reseeds quietly from
 * whatever history loads first. Several newly verified payments in one
 * observation collapse into a single catch-up summary instead of a burst.
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

/**
 * Browsing history loaded beyond the recent window never feeds arrival
 * observation: older receipts are marked seen without bannering, so paging
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
      // banner stays suppressed, but removing the exclusion later must not
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
  // legacy baselines, partial snapshots, and restored data can all omit old
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

const MAX_VISIBLE_ARRIVALS = 3
const EMPTY_EXCLUDED: ReadonlySet<string> = new Set()

export interface ArrivalDeliveryPrefs {
  /** In-app banners. Off hides banners while detection and dedup continue. */
  bannersEnabled: boolean
  /** Haptic pulse with a banner. Visual and spoken feedback never depend on it. */
  hapticsEnabled: boolean
}

const DEFAULT_DELIVERY: ArrivalDeliveryPrefs = { bannersEnabled: true, hapticsEnabled: true }

export function usePaymentArrivals(
  history: readonly VaultHistoryItem[],
  scope: PaymentScope,
  paused: boolean,
  ready: boolean,
  excludedKeys: ReadonlySet<string> = EMPTY_EXCLUDED,
  delivery: ArrivalDeliveryPrefs = DEFAULT_DELIVERY,
): {
  arrivals: PaymentArrival[]
  catchUp: PaymentCatchUp | null
  dismissArrival: (key: string) => void
  dismissCatchUp: () => void
  openArrivalKey: (key: string) => VaultHistoryItem | null
} {
  const [notices, dispatchNotices] = useReducer(noticesReducer, EMPTY_NOTICES)
  const seenRef = useRef<Map<string, boolean> | null>(null)
  const pendingRef = useRef<PaymentArrival[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const deliveryRef = useRef(delivery)
  deliveryRef.current = delivery
  const aliveRef = useRef(true)
  const generationRef = useRef(0)
  // Delivery generation: disabling banners invalidates in-flight
  // announcements without touching detection baseline. A claim that resolves
  // after disable-then-re-enable belongs to the older generation and stays
  // silent, while genuinely new payments announce normally.
  const deliveryGenRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const scopeKey = `${scope.network}:${scope.vaultId}`
  const scopeRef = useRef(scopeKey)
  if (scopeRef.current !== scopeKey) {
    generationRef.current += 1
    scopeRef.current = scopeKey
    seenRef.current = null
    pendingRef.current = []
    dispatchNotices({ type: 'reset' })
  }

  useEffect(() => {
    if (!ready) return
    if (!seenRef.current) {
      // The first post-readiness history merges into the stored baseline.
      // With no stored baseline this seeds quietly, so a fresh load never
      // replays old payments. Subsequent snapshots detect new available keys.
      seenRef.current = seedArrivalBaseline(history, scope)
    } else {
      // Another tab may have presented arrivals since this tab's last run.
      // Merge observed keys; the atomic delivery receipt below arbitrates
      // simultaneous detections from separate tabs.
      for (const [key, available] of loadArrivalBaseline(scope)) {
        if (!seenRef.current.has(key)) seenRef.current.set(key, available)
      }
    }
    const { arrivals: fresh, seen } = detectPaymentArrivals(seenRef.current, history, scope, excludedKeys)
    seenRef.current = seen
    saveArrivalBaseline(scope, seen, new Set(history.map((row) => paymentIdentityForItem(row, scope).key)))
    if (fresh.length === 0) return
    if (!delivery.bannersEnabled) {
      // Delivery disabled hides banners only: baseline and dedup above keep
      // running, other tabs arbitrate their own announcements, and
      // re-enabling replays nothing. Pending notices from before the toggle
      // are dropped with the same guarantee.
      pendingRef.current = []
      return
    }
    const generation = generationRef.current
    const deliveryGen = deliveryGenRef.current
    void claimArrivalDelivery(fresh.map((arrival) => arrival.key))
      .then((keys) => {
        if (!aliveRef.current || generationRef.current !== generation) return
        // Read delivery preferences at delivery time: a toggle while the
        // claim was pending invalidates the announcement. A disable and
        // re-enable before resolution still drops the old notice because the
        // delivery generation advanced.
        if (deliveryGenRef.current !== deliveryGen) return
        const live = deliveryRef.current
        if (!live.bannersEnabled) return
        const accepted = fresh.filter((arrival) => keys.includes(arrival.key))
        if (!accepted.length) return
        if (pausedRef.current) {
          const queued = new Map(pendingRef.current.map((arrival) => [arrival.key, arrival]))
          for (const arrival of accepted) queued.set(arrival.key, arrival)
          pendingRef.current = [...queued.values()]
          return
        }
        // The reducer merges atomically, so two claims resolving before
        // React renders union instead of overwriting.
        if (live.hapticsEnabled) hapticSubtle()
        dispatchNotices({ type: 'present', accepted })
      })
      .catch(() => {
        // Delivery storage failure suppresses an optional banner; payment
        // history and lifecycle processing remain available.
      })
    // paused intentionally gates delivery without reseeding the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, ready, excludedKeys, delivery.bannersEnabled, delivery.hapticsEnabled])

  useEffect(() => {
    if (paused || pendingRef.current.length === 0) return
    if (!deliveryRef.current.bannersEnabled) {
      pendingRef.current = []
      return
    }
    const flushed = pendingRef.current
    pendingRef.current = []
    // Buffered arrivals flush through the same at-most-one-notice rule, so
    // unlocking after several landed while approval was in flight produces
    // one summary rather than a burst.
    if (deliveryRef.current.hapticsEnabled) hapticSubtle()
    dispatchNotices({ type: 'present', accepted: flushed })
  }, [paused])

  // Disabling banners invalidates pending and visible notices immediately,
  // even when no fresh history arrives. Detection, baseline, and dedup above
  // keep running, so re-enabling replays nothing.
  const bannersOn = delivery.bannersEnabled
  useEffect(() => {
    if (bannersOn) return
    deliveryGenRef.current += 1
    pendingRef.current = []
    dispatchNotices({ type: 'reset' })
  }, [bannersOn])

  const dismissCatchUp = useCallback(() => {
    dispatchNotices({ type: 'dismiss-summary' })
  }, [])

  const dismissArrival = useCallback((key: string) => {
    pendingRef.current = pendingRef.current.filter((arrival) => arrival.key !== key)
    dispatchNotices({ type: 'dismiss', key })
  }, [])

  const openArrivalKey = useCallback(
    (key: string) => {
      const arrival = [...pendingRef.current, ...notices.arrivals].find((candidate) => candidate.key === key)
      return arrival?.item || null
    },
    [notices.arrivals],
  )

  return { arrivals: notices.arrivals, catchUp: notices.catchUp, dismissArrival, dismissCatchUp, openArrivalKey }
}
