import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backgroundPushState,
  clearStoredPushSubscription,
  disableBackgroundPush,
  enableBackgroundPush,
  isPushSubscribed,
  reconcilePushState,
  refreshBackgroundPush,
} from './pushSubscription'
import type { VaultStatus } from './types'

vi.mock('./lnurl', () => ({
  LNURL_ORIGIN: 'https://ln.getvaulted.xyz',
  loadLightningAddress: vi.fn(),
  configureLightningAddress: vi.fn(),
}))

import { configureLightningAddress, loadLightningAddress } from './lnurl'

const loadMock = loadLightningAddress as unknown as ReturnType<typeof vi.fn>
const configureMock = configureLightningAddress as unknown as ReturnType<typeof vi.fn>

const status = { network: 'mainnet', vaultId: 'vault-1' } as VaultStatus
const storageKey = 'vaulted:push:v1:mainnet:vault-1'
const VAPID = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url')
const VAPID_AB = new Uint8Array(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)])).buffer as ArrayBuffer
const ROTATED_AB = new Uint8Array(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 8)])).buffer as ArrayBuffer
const address = { readToken: 'ab'.repeat(32), id: 'v1234567890abcdef' }

function fakeSubscription(options: { applicationServerKey?: ArrayBuffer | null } = {}) {
  const bytes = (n: number, fill: number) => new Uint8Array(Array.from({ length: n }, () => fill)).buffer as ArrayBuffer
  return {
    endpoint: 'https://fcm.googleapis.com/push/test-endpoint',
    getKey: (name: string) => (name === 'p256dh' ? bytes(65, 4) : bytes(16, 9)),
    options: { applicationServerKey: options.applicationServerKey ?? null },
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

function jsonResponse(body: unknown, statusCode = 200) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('push subscription client', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    localStorage.clear()
    loadMock.mockReturnValue(address)
    configureMock.mockResolvedValue(address)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('refuses to touch the network before permission is granted', async () => {
    vi.stubGlobal('Notification', { permission: 'default' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(enableBackgroundPush(status)).rejects.toThrow('Allow notifications first')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('enrolls namelessly through the Guardian flow when no receiver exists', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    loadMock.mockReturnValueOnce(undefined)
    const subscription = fakeSubscription()
    const subscribe = vi.fn().mockResolvedValue(subscription)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({
          active: { state: 'activated' },
          pushManager: { getSubscription: () => Promise.resolve(null), subscribe },
        }),
      },
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 1000 }))
    vi.stubGlobal('fetch', fetchSpy)
    const created = await enableBackgroundPush(status)
    expect(configureMock).toHaveBeenCalledWith(status, 'register', '')
    expect(created.subHandle).toBe('cd'.repeat(32))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${address.readToken}`)
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
  })

  it('refreshes a stored handle and falls back to create on unknown handles', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 1000 }))
    const subscription = fakeSubscription()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({
          active: { state: 'activated' },
          pushManager: { getSubscription: () => Promise.resolve(subscription) },
        }),
      },
    })
    const fetchSpy = vi.fn()
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expiresAt: Date.now() + 2000 }))
    vi.stubGlobal('fetch', fetchSpy)
    const refreshed = await enableBackgroundPush(status)
    expect(refreshed.subHandle).toBe('ef'.repeat(32))
    expect(fetchSpy.mock.calls[0]![0]).toContain('/v1/vaulted/push/subscriptions/efef')
    // Unknown handle: PUT 404 then POST create.
    fetchSpy.mockReset()
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 404))
    fetchSpy.mockResolvedValueOnce(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 1000 }))
    const recreated = await enableBackgroundPush(status)
    expect(recreated.subHandle).toBe('cd'.repeat(32))
  })

  it('revokes only this wallet and preserves the shared browser subscription', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000 }))
    localStorage.setItem(
      'vaulted:push:v1:mainnet:vault-2',
      JSON.stringify({ subHandle: 'aa'.repeat(32), expiresAt: Date.now() + 100000 }),
    )
    const subscription = fakeSubscription()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }),
      },
    })
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    await disableBackgroundPush(status)
    expect(localStorage.getItem(storageKey)).toBeNull()
    expect(localStorage.getItem('vaulted:push:v1:mainnet:vault-2')).not.toBeNull()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retains the handle when revocation fails so Settings can retry', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000 }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(disableBackgroundPush(status)).rejects.toThrow('offline')
    expect(isPushSubscribed(status)).toBe(true)
  })

  it('reconciles missing server handles without tearing down another wallet endpoint', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000 }))
    const subscription = fakeSubscription()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }),
      },
    })
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ subscriptions: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(reconcilePushState(status)).resolves.toEqual({ subscribed: false, expiresAt: null })
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(storageKey)).toBeNull()
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000 }))
    fetchSpy.mockRejectedValueOnce(new Error('offline'))
    await expect(reconcilePushState(status)).rejects.toThrow('Could not check')
    expect(localStorage.getItem(storageKey)).not.toBeNull()
  })

  it('does not report enabled when the actual browser subscription is gone', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    localStorage.setItem(storageKey, JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000 }))
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) } })
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(reconcilePushState(status)).resolves.toEqual({ subscribed: false, expiresAt: null })
    expect(fetchSpy.mock.calls[0]?.[1].method).toBe('DELETE')
  })

  it('stops an enable operation after the wallet changes during worker activation', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    let current = true
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockImplementation(async () => {
          current = false
          return { active: { state: 'activated' } }
        }),
      },
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(enableBackgroundPush(status, () => current)).rejects.toThrow('Wallet changed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renews an existing device lease on unlock without prompting', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission })
    const subscription = fakeSubscription()
    localStorage.setItem(
      storageKey,
      JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 1000, endpoint: subscription.endpoint }),
    )
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }),
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 30 * 86400000 })),
    )
    await refreshBackgroundPush(status)
    expect(JSON.parse(localStorage.getItem(storageKey)!).expiresAt).toBeGreaterThan(Date.now() + 29 * 86400000)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('recycles a VAPID-rotated browser binding on unlock instead of leaving it stale', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const stale = fakeSubscription({ applicationServerKey: ROTATED_AB })
    const fresh = fakeSubscription({ applicationServerKey: VAPID_AB })
    const subscribe = vi.fn().mockResolvedValue(fresh)
    localStorage.setItem(
      storageKey,
      JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 30 * 86400000, endpoint: stale.endpoint }),
    )
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: () => Promise.resolve(stale), subscribe },
        }),
      },
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 30 * 86400000 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    await refreshBackgroundPush(status)
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
    expect(JSON.parse(localStorage.getItem(storageKey)!).subHandle).toBe('cd'.repeat(32))
    // Fresh handle created, then the dead old handle retired.
    expect(fetchSpy.mock.calls[0]![1].method).toBe('POST')
    expect(fetchSpy.mock.calls[1]![0]).toContain(`/v1/vaulted/push/subscriptions/${'ef'.repeat(32)}`)
    expect(fetchSpy.mock.calls[1]![1].method).toBe('DELETE')
  })

  it('recovers a browser-dropped subscription on unlock (pushsubscriptionchange fallback)', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const fresh = fakeSubscription({ applicationServerKey: VAPID_AB })
    const subscribe = vi.fn().mockResolvedValue(fresh)
    localStorage.setItem(
      storageKey,
      JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 30 * 86400000, endpoint: fresh.endpoint }),
    )
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: () => Promise.resolve(null), subscribe },
        }),
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 30 * 86400000 })),
    )
    await refreshBackgroundPush(status)
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
    expect(JSON.parse(localStorage.getItem(storageKey)!).subHandle).toBe('cd'.repeat(32))
  })

  it('rebuilds an authorized registration when the server lost the record', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const subscription = fakeSubscription({ applicationServerKey: VAPID_AB })
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        subHandle: 'ef'.repeat(32),
        expiresAt: Date.now() + 30 * 86400000,
        endpoint: subscription.endpoint,
      }),
    )
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ subscriptions: [] })) // server record gone
      .mockResolvedValueOnce(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 30 * 86400000 })) // rebuild
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }),
      },
    })
    await refreshBackgroundPush(status)
    expect(fetchSpy.mock.calls[0]?.[1].method).toBe('GET')
    expect(fetchSpy.mock.calls[1]?.[1].method).toBe('POST')
    expect(JSON.parse(localStorage.getItem(storageKey)!).subHandle).toBe('cd'.repeat(32))
    // The user's opt-in survives: only the dead handle is replaced.
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('keeps a healthy server record without rewriting it on unlock', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const subscription = fakeSubscription({ applicationServerKey: VAPID_AB })
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        subHandle: 'ef'.repeat(32),
        expiresAt: Date.now() + 30 * 86400000,
        endpoint: subscription.endpoint,
      }),
    )
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ subscriptions: [{ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 40 * 86400000 }] }),
      )
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(subscription) } }),
      },
    })
    await refreshBackgroundPush(status)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1].method).toBe('GET')
    expect(JSON.parse(localStorage.getItem(storageKey)!).expiresAt).toBeGreaterThan(Date.now() + 39 * 86400000)
  })

  it('preserves opt-in when a resubscription attempt fails', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const stale = fakeSubscription({ applicationServerKey: ROTATED_AB })
    localStorage.setItem(
      storageKey,
      JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 30 * 86400000, endpoint: stale.endpoint }),
    )
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: () => Promise.resolve(stale),
            subscribe: vi.fn().mockRejectedValue(new Error('denied')),
          },
        }),
      },
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(refreshBackgroundPush(status)).resolves.toBeUndefined()
    // No network and no teardown: Settings reconcile reports the truthful state.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(storageKey)!).subHandle).toBe('ef'.repeat(32))
  })

  it('recycles a VAPID-rotated existing subscription when enabling', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const stale = fakeSubscription({ applicationServerKey: ROTATED_AB })
    const fresh = fakeSubscription({ applicationServerKey: VAPID_AB })
    const subscribe = vi.fn().mockResolvedValue(fresh)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({
          active: { state: 'activated' },
          pushManager: { getSubscription: () => Promise.resolve(stale), subscribe },
        }),
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ subHandle: 'cd'.repeat(32), expiresAt: Date.now() + 1000 })),
    )
    const created = await enableBackgroundPush(status)
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
    expect(created.subHandle).toBe('cd'.repeat(32))
  })

  it('does not report enabled after a VAPID key rotation', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const stale = fakeSubscription({ applicationServerKey: ROTATED_AB })
    localStorage.setItem(
      storageKey,
      JSON.stringify({ subHandle: 'ef'.repeat(32), expiresAt: Date.now() + 100000, endpoint: stale.endpoint }),
    )
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription: () => Promise.resolve(stale) } }),
      },
    })
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(reconcilePushState(status)).resolves.toEqual({ subscribed: false, expiresAt: null })
    expect(fetchSpy.mock.calls[0]?.[1].method).toBe('DELETE')
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('reads settings state without prompting or networking', () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const state = backgroundPushState(status)
    expect(state).toMatchObject({ capable: false, permission: 'default', enrolled: true, subscribed: false })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    clearStoredPushSubscription(status)
  })
})
