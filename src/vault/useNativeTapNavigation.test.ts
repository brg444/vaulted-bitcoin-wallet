import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { stripNativeTapMarker, useNativeTapNavigation } from './useNativeTapNavigation'

const TAP_SEARCH = '?notify=activity'
const TAP_HREF = 'https://vaulted.example/?notify=activity&other=1'

interface Fixture {
  navigate: ReturnType<typeof vi.fn>
  replaceUrl: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  search: string
}

function fixture(search = TAP_SEARCH, refreshImpl?: () => Promise<unknown>): Fixture {
  return {
    navigate: vi.fn(),
    replaceUrl: vi.fn(),
    refresh: vi.fn(refreshImpl ?? (() => Promise.resolve())),
    search,
  }
}

function renderTap(f: Fixture, blocked = false, scopeKey = 'mainnet:vault-1') {
  return renderHook(
    ({ blocked: b, scopeKey: s }) =>
      useNativeTapNavigation({
        blocked: b,
        scopeKey: s,
        navigate: f.navigate,
        refresh: f.refresh,
        getSearch: () => f.search,
        getHref: () => TAP_HREF,
        replaceUrl: f.replaceUrl,
      }),
    { initialProps: { blocked, scopeKey } },
  )
}

describe('notification tap navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('strips the unit marker without touching other params', () => {
    expect(stripNativeTapMarker(TAP_HREF)).toBe('https://vaulted.example/?other=1')
    expect(stripNativeTapMarker('https://vaulted.example/home')).toBe('https://vaulted.example/home')
    expect(stripNativeTapMarker('not a url')).toBe('not a url')
  })

  it('stays silent while locked and navigates once on unlock', async () => {
    const f = fixture()
    const hook = renderTap(f, true)
    await act(() => Promise.resolve())
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.replaceUrl).not.toHaveBeenCalled()
    hook.rerender({ blocked: false, scopeKey: 'mainnet:vault-1' })
    await act(() => Promise.resolve())
    expect(f.navigate).toHaveBeenCalledTimes(1)
    expect(f.navigate).toHaveBeenCalledWith('activity')
    // Marker removed (other params retained) before any await, so a repeated
    // tap or remount on the same URL state cannot replay navigation.
    expect(f.replaceUrl).toHaveBeenCalledTimes(1)
    expect(f.replaceUrl).toHaveBeenCalledWith('https://vaulted.example/?other=1')
    // A newly refreshed verified snapshot is requested after the tap; a
    // previous fresh snapshot alone does not satisfy the sequence.
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it('retains the Activity destination when refresh is delayed', async () => {
    let resolveRefresh!: (value: unknown) => void
    const gate = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve
    })
    const f = fixture(TAP_SEARCH, () => gate)
    renderTap(f, true).rerender({ blocked: false, scopeKey: 'mainnet:vault-1' })
    await act(() => Promise.resolve())
    expect(f.navigate).toHaveBeenCalledWith('activity')
    expect(f.refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRefresh(undefined)
      await gate
    })
    expect(f.navigate).toHaveBeenCalledTimes(1)
  })

  it('still leaves the user on Activity when the refresh fails', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const f = fixture(TAP_SEARCH, () => Promise.reject(new Error('offline')))
      renderTap(f, true).rerender({ blocked: false, scopeKey: 'mainnet:vault-1' })
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(f.navigate).toHaveBeenCalledTimes(1)
      expect(f.navigate).toHaveBeenCalledWith('activity')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not replay navigation on rerender, and handles an account switch', async () => {
    const f = fixture()
    const hook = renderTap(f, false)
    await act(() => Promise.resolve())
    expect(f.navigate).toHaveBeenCalledTimes(1)
    // Same unlock-ready state: no replay.
    hook.rerender({ blocked: false, scopeKey: 'mainnet:vault-1' })
    await act(() => Promise.resolve())
    expect(f.navigate).toHaveBeenCalledTimes(1)
    // Account switch is a new scope: it re-evaluates the still-present marker
    // for the new account rather than acting on the stale one.
    hook.rerender({ blocked: false, scopeKey: 'mainnet:vault-2' })
    await act(() => Promise.resolve())
    expect(f.navigate).toHaveBeenCalledTimes(2)
    expect(f.refresh).toHaveBeenCalledTimes(2)
  })

  it('ignores missing, invalid, and non-activity markers', async () => {
    for (const search of ['', '?notify=settings', '?notify=https://evil.example', '?other=1']) {
      const f = fixture(search)
      renderTap(f, false)
      await act(() => Promise.resolve())
      expect(f.navigate).not.toHaveBeenCalled()
      expect(f.refresh).not.toHaveBeenCalled()
      expect(f.replaceUrl).not.toHaveBeenCalled()
    }
  })

  it('never prompts or reads payment data to consume a tap', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const f = fixture()
    renderTap(f, false)
    await act(() => Promise.resolve())
    expect(requestPermission).not.toHaveBeenCalled()
    expect(f.navigate).toHaveBeenCalledWith('activity')
  })
})
