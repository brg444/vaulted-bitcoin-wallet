import { useEffect, useRef } from 'react'
import { parsePushNavScreen } from '../lib/vault/notificationEnvelope'

export interface NativeTapNavigationOptions {
  /** True while locked, unscoped, or before a verified snapshot is ready. */
  blocked: boolean
  /** network:vaultId; a change is an account switch and invalidates pending work. */
  scopeKey: string
  navigate: (screen: 'activity') => void
  refresh: () => Promise<unknown>
  getSearch?: () => string
  getHref?: () => string
  replaceUrl?: (url: string) => void
}

function defaultSearch(): string {
  try {
    return window.location.search
  } catch {
    return ''
  }
}

function defaultHref(): string {
  try {
    return window.location.href
  } catch {
    return ''
  }
}

function defaultReplace(url: string): void {
  try {
    window.history.replaceState(null, '', url)
  } catch {
    // The marker stays in the URL but is inert; navigation still proceeds.
  }
}

/** Read and strip the worker's `notify` marker from a URL's query string. */
export function stripNativeTapMarker(href: string): string {
  try {
    const url = new URL(href)
    url.searchParams.delete('notify')
    return url.toString()
  } catch {
    return href
  }
}

/**
 * Consume a worker notification tap. The push worker opens
 * `/?notify=activity`; this runs once the wallet is unlocked and a fresh
 * snapshot is ready, removes the marker before any await so a repeated tap or
 * remount cannot replay it, retains the Activity destination, then requests a
 * refreshed verified snapshot. A refresh failure still leaves the user on
 * Activity (history remains the source of truth) and never rejects. An
 * account switch mid-refresh abandons the stale work.
 */
export function useNativeTapNavigation(opts: NativeTapNavigationOptions): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const generationRef = useRef(0)
  const scopeRef = useRef(opts.scopeKey)
  if (scopeRef.current !== opts.scopeKey) {
    scopeRef.current = opts.scopeKey
    generationRef.current += 1
  }
  const { blocked, scopeKey } = opts
  useEffect(() => {
    if (blocked) return
    const current = optsRef.current
    const generation = generationRef.current
    const search = current.getSearch?.() ?? defaultSearch()
    let marker: string | null = null
    try {
      marker = new URLSearchParams(search).get('notify')
    } catch {
      return
    }
    if (parsePushNavScreen(marker) !== 'activity') return
    const href = current.getHref?.() ?? defaultHref()
    ;(current.replaceUrl ?? defaultReplace)(stripNativeTapMarker(href))
    // Retain the destination before any await: the user is on Activity even if
    // the network refresh is slow or fails.
    current.navigate('activity')
    void Promise.resolve()
      .then(() => current.refresh())
      .catch(() => undefined)
      .then(() => {
        // A scope change abandons this stale tap; the new scope re-evaluates.
        if (generationRef.current !== generation) return
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, scopeKey])
}
