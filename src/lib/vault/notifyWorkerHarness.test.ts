import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKER_SOURCE = readFileSync(join(root, 'public/vault-notify-service-worker.js'), 'utf8')
const envelope = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  sub: 'ab'.repeat(32),
  event: 'cd'.repeat(32),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
})

interface Harness {
  listeners: Record<string, (event: Record<string, unknown>) => void>
  showNotification: ReturnType<typeof vi.fn>
  openWindow: ReturnType<typeof vi.fn>
  clients: { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }[]
}

function harness(existingWindows: string[] = []): Harness {
  const listeners: Harness['listeners'] = {}
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const openWindow = vi.fn().mockResolvedValue(undefined)
  const clients = existingWindows.map((url) => ({
    url,
    focus: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
  }))
  const sandbox = {
    self: {
      addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => {
        listeners[name] = fn
      },
      registration: { showNotification },
      clients: {
        matchAll: () => Promise.resolve(clients),
        openWindow,
      },
      location: new URL('https://vaulted.example/'),
    },
    URL,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(WORKER_SOURCE, sandbox)
  return { listeners, showNotification, openWindow, clients }
}

const pushEvent = (data: unknown) => {
  let settled!: (value: unknown) => void
  const promise = new Promise((resolve) => {
    settled = resolve
  })
  return {
    event: {
      data: data === undefined ? undefined : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
      waitUntil: (value: Promise<unknown>) => {
        void value.then(settled, settled)
      },
    },
    settled: () => promise,
  }
}

const clickEvent = () => {
  let settled!: (value: unknown) => void
  const promise = new Promise((resolve) => {
    settled = resolve
  })
  return {
    event: {
      notification: { close: vi.fn() },
      waitUntil: (value: Promise<unknown>) => {
        void value.then(settled, settled)
      },
    },
    settled: () => promise,
  }
}

describe('notify worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders every valid push with a stable per-event tag', async () => {
    const h = harness()
    const first = pushEvent(envelope())
    h.listeners.push!(first.event)
    await first.settled()
    expect(h.showNotification).toHaveBeenCalledTimes(1)
    const [title, options] = h.showNotification.mock.calls[0] as [string, Record<string, unknown>]
    expect(title).toBe('Payment received')
    expect(options).toMatchObject({
      body: 'Open Vaulted to view your activity',
      tag: `vaulted-payment:${'cd'.repeat(32)}`,
      renotify: false,
    })
    expect(JSON.stringify(options)).not.toContain('ab'.repeat(8))
  })

  it('replaces retries of the same event instead of stacking', async () => {
    const h = harness()
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = pushEvent(envelope())
      h.listeners.push!(retry.event)
      await retry.settled()
    }
    expect(h.showNotification).toHaveBeenCalledTimes(3)
    const tags = h.showNotification.mock.calls.map((call) => (call[1] as Record<string, unknown>).tag)
    expect(new Set(tags).size).toBe(1)
    // A different event is a different notice.
    const other = pushEvent(envelope({ event: 'ef'.repeat(32) }))
    h.listeners.push!(other.event)
    await other.settled()
    expect(h.showNotification).toHaveBeenCalledTimes(4)
    expect((h.showNotification.mock.calls[3]![1] as Record<string, unknown>).tag).toBe(
      `vaulted-payment:${'ef'.repeat(32)}`,
    )
  })

  it('stays silent only for malformed, expired, and oversized payloads', async () => {
    const h = harness()
    for (const bad of [
      undefined,
      { v: 2, sub: 'ab'.repeat(32), event: 'cd'.repeat(32), exp: Math.floor(Date.now() / 1000) + 10 },
      { v: 1, sub: 'short', event: 'cd'.repeat(32), exp: Math.floor(Date.now() / 1000) + 10 },
      { v: 1, sub: 'ab'.repeat(32), event: 'cd'.repeat(32), exp: Math.floor(Date.now() / 1000) - 5 },
      { v: 1, sub: 'ab'.repeat(32), event: 'cd'.repeat(32), exp: Math.floor(Date.now() / 1000) + 10, extra: 1 },
      { v: 1, sub: 'ab'.repeat(32), event: 'cd'.repeat(32), exp: Math.floor(Date.now() / 1000) + 10, pay: 'anything' },
    ]) {
      const pushed = pushEvent(bad)
      h.listeners.push!(pushed.event)
      await pushed.settled()
    }
    const huge = pushEvent(
      JSON.stringify({
        v: 1,
        sub: 'ab'.repeat(32),
        event: 'cd'.repeat(32),
        exp: Math.floor(Date.now() / 1000) + 10,
        pad: 'x'.repeat(600),
      }),
    )
    h.listeners.push!(huge.event)
    await huge.settled()
    expect(h.showNotification).not.toHaveBeenCalled()
  })

  it('opens the fixed same-origin tap target and prefers focusing', async () => {
    const h = harness()
    const clicked = clickEvent()
    h.listeners.notificationclick!(clicked.event)
    await clicked.settled()
    expect(h.openWindow).toHaveBeenCalledWith('https://vaulted.example/?notify=activity')
    // Existing window: focus and navigate instead of opening.
    const withWindow = harness(['https://vaulted.example/home'])
    const clickedAgain = clickEvent()
    withWindow.listeners.notificationclick!(clickedAgain.event)
    await clickedAgain.settled()
    expect(withWindow.openWindow).not.toHaveBeenCalled()
    expect(withWindow.clients[0]!.focus).toHaveBeenCalled()
    expect(withWindow.clients[0]!.navigate).toHaveBeenCalledWith('https://vaulted.example/?notify=activity')
  })

  it('exposes no fetch handler or wallet capability', () => {
    const h = harness()
    expect(Object.keys(h.listeners).sort()).toEqual(['notificationclick', 'push', 'pushsubscriptionchange'])
    expect(WORKER_SOURCE).not.toMatch(/fetch\(|importScripts|privateKey|prf|passkey|indexedDB/i)
  })
})
