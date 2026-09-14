import { useEffect, useRef } from 'react'
import type { VaultHistoryItem } from '../lib/vault/history'
import { describePayment, paymentIdentityForItem, type PaymentScope } from '../lib/vault/payments'
import { loadArrivalBaseline, saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import { claimNativeDelivery } from '../lib/vault/nativeDelivery'
import { showForegroundPaymentNotice } from '../lib/vault/nativeNotifications'
import { vaultLatency } from '../lib/vault/latency'
import { detectPaymentArrivals, seedArrivalBaseline } from '../lib/vault/arrivalDetection'

export interface NativeForegroundDeps {
  /** Narrow-scope notify registration for showNotification; falls back to window Notification. */
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>
  idbFactory?: IDBFactory
  enabled?: boolean
}

/**
 * Foreground OS notifications for verified receipts the server cannot see.
 * Delivery ownership is split by route, never raced:
 * - Covered Spending receipts (direct Arkade, Lightning, destination rail)
 *   notify exclusively through server push — even with the app open — so
 *   this hook stays silent for them.
 * - Uncovered verified receipts (confirmed Savings deposits) announce here
 *   through the Notification API.
 *
 * Detection reuses the shared arrival edge logic (first-sync baseline,
 * reconnect merging, older-history exclusion) with its own native claim
 * domain; delivery shows the fixed generic text — never an in-app banner,
 * never amounts or accounts.
 *
 * At-most-once per device: the native claim arbitrates tabs, and a crash
 * between claim and show can lose one notice. Activity remains the source
 * of truth; the OS tag backstop only replaces visible entries.
 */
export function useNativePaymentNotifications(
  history: readonly VaultHistoryItem[],
  scope: PaymentScope,
  paused: boolean,
  ready: boolean,
  excludedKeys: ReadonlySet<string> = new Set(),
  deps: NativeForegroundDeps,
): void {
  const seenRef = useRef<Map<string, boolean> | null>(null)
  const pendingRef = useRef<string[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const depsRef = useRef(deps)
  depsRef.current = deps
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const scopeKey = `${scope.network}:${scope.vaultId}`
  const scopeRef = useRef(scopeKey)
  const generationRef = useRef(0)
  const enabled = deps.enabled !== false
  const enabledRef = useRef(enabled)
  if (scopeRef.current !== scopeKey) {
    generationRef.current += 1
    scopeRef.current = scopeKey
    seenRef.current = null
    pendingRef.current = []
  }

  if (enabledRef.current !== enabled) {
    generationRef.current += 1
    enabledRef.current = enabled
    pendingRef.current = []
  }

  useEffect(() => {
    if (!ready) return
    const generation = generationRef.current
    if (!seenRef.current) {
      seenRef.current = seedArrivalBaseline(history, scope)
    } else {
      for (const [key, available] of loadArrivalBaseline(scope)) {
        if (!seenRef.current.has(key)) seenRef.current.set(key, available)
      }
    }
    const { arrivals: fresh, seen } = detectPaymentArrivals(seenRef.current, history, scope, excludedKeys)
    seenRef.current = seen
    saveArrivalBaseline(scope, seen, new Set(history.map((row) => paymentIdentityForItem(row, scope).key)))
    if (fresh.length === 0) return
    const current = depsRef.current
    if (current.enabled === false) {
      pendingRef.current = []
      return
    }
    void (async () => {
      // Claim every fresh arrival so a burst cannot replay, but coalesce the
      // visible notice: one generic entry replaces itself regardless of how
      // many verified receipts arrived in this pass.
      const accepted: string[] = []
      for (const arrival of fresh) {
        // Stale scope work (A-B-A, unmount, lock transitions) never shows.
        if (!aliveRef.current || generationRef.current !== generation) return
        // Server-owned routes stay silent here under every subscription state.
        if (isServerCovered(arrival.item, scope)) continue
        const payKey = paymentIdentityForItem(arrival.item, scope).key
        try {
          const claimed = await claimNativeDelivery([payKey], current.idbFactory)
          if (!aliveRef.current || generationRef.current !== generation) return
          if (!claimed.includes(payKey)) continue
          if (!accepted.includes(payKey)) accepted.push(payKey)
        } catch {
          // A foreground notice is advisory; history and lifecycle continue.
        }
      }
      if (!accepted.length) return
      if (pausedRef.current) {
        for (const payKey of accepted) if (!pendingRef.current.includes(payKey)) pendingRef.current.push(payKey)
        return
      }
      let registration: ServiceWorkerRegistration | undefined
      try {
        registration = await current.getRegistration()
      } catch {
        registration = undefined
      }
      if (!aliveRef.current || generationRef.current !== generation) return
      if (pausedRef.current) {
        for (const payKey of accepted) if (!pendingRef.current.includes(payKey)) pendingRef.current.push(payKey)
        return
      }
      try {
        await vaultLatency.measure('notification-delivery', () =>
          showForegroundPaymentNotice(registration ?? undefined),
        )
      } catch {
        // An advisory notice must never reject the detached task or interrupt
        // the payment state; Activity and history remain authoritative.
      }
    })()
    // paused intentionally gates delivery without reseeding the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, ready, excludedKeys, scopeKey, enabled])

  useEffect(() => {
    if (depsRef.current.enabled === false) {
      pendingRef.current = []
      return
    }
    if (paused || pendingRef.current.length === 0) return
    const generation = generationRef.current
    const current = depsRef.current
    const flushed = pendingRef.current
    pendingRef.current = []
    void (async () => {
      let registration: ServiceWorkerRegistration | undefined
      try {
        registration = await current.getRegistration()
      } catch {
        registration = undefined
      }
      if (!flushed.length) return
      if (!aliveRef.current || generationRef.current !== generation) return
      if (pausedRef.current) {
        pendingRef.current.push(...flushed)
        return
      }
      try {
        await vaultLatency.measure('notification-delivery', () =>
          showForegroundPaymentNotice(registration ?? undefined),
        )
      } catch {
        // Advisory only.
      }
    })()
  }, [paused, scopeKey, enabled])
}

/**
 * True when the server notification pipeline owns this receipt: Lightning
 * receipts (settlement flips) and Spending Arkade receipts (direct watcher
 * and destination rail). Savings deposits and other verified routes have no
 * server observer and announce in the foreground.
 */
export function isServerCovered(item: VaultHistoryItem, scope: PaymentScope): boolean {
  const described = describePayment(item)
  if (described.origin !== 'verified-external' || !described.complete || described.suppressArrival) return false
  const key = paymentIdentityForItem(item, scope).key
  if (key.startsWith('lightning:')) return true
  if (key.startsWith('tx:') && key.includes(':spend:') && key.endsWith(':received')) return true
  return false
}
