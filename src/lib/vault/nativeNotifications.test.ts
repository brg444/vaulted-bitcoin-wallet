import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_PAYMENT_BODY,
  NATIVE_PAYMENT_TAG,
  NATIVE_PAYMENT_TITLE,
  awaitNotifyWorkerActive,
  isPushCapable,
  needsInstallForPush,
  readNotificationPermission,
  requestNativePermission,
  showForegroundPaymentNotice,
  vapidKeyBytes,
} from './nativeNotifications'

describe('native notification primitives', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the visible notice generic', () => {
    expect(NATIVE_PAYMENT_TITLE).toBe('Payment received')
    expect(NATIVE_PAYMENT_BODY).toBe('Open Vaulted to view your activity')
    expect(`${NATIVE_PAYMENT_TITLE} ${NATIVE_PAYMENT_BODY}`).not.toMatch(/[0-9]/)
  })

  it('detects capability without prompting', () => {
    expect(isPushCapable({})).toBe(false)
    expect(
      isPushCapable({ Notification: { permission: 'default' }, serviceWorker: {}, PushManager: {} }),
    ).toBe(true)
    expect(readNotificationPermission({})).toBe('unsupported')
    expect(readNotificationPermission({ Notification: { permission: 'granted' } })).toBe('granted')
    expect(readNotificationPermission({ Notification: { permission: 'denied' } })).toBe('denied')
    expect(readNotificationPermission({ Notification: { permission: 'default' } })).toBe('default')
  })

  it('requires the installed app on iPhone', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    expect(needsInstallForPush(iphone, false)).toBe(true)
    expect(needsInstallForPush(iphone, true)).toBe(false)
    expect(
      needsInstallForPush('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', false),
    ).toBe(false)
  })

  it('validates the VAPID key before subscribing', () => {
    const valid = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url')
    expect(vapidKeyBytes(valid)).toHaveLength(65)
    expect(vapidKeyBytes('')).toBeNull()
    expect(vapidKeyBytes('not-key')).toBeNull()
    expect(vapidKeyBytes(Buffer.alloc(65, 1).toString('base64url'))).toBeNull()
  })

  it('awaits this registration activation, not the page ready promise', async () => {
    await expect(awaitNotifyWorkerActive({ active: { state: 'activated' } }, 10)).resolves.toBeUndefined()
    const listeners: Record<string, () => void> = {}
    const installing = { state: 'installing', addEventListener: (name: string, fn: () => void) => { listeners[name] = fn } }
    const pending = awaitNotifyWorkerActive({ active: null, installing }, 1000)
    installing.state = 'activated'
    listeners.statechange!()
    await expect(pending).resolves.toBeUndefined()
    await expect(awaitNotifyWorkerActive({ active: null, installing: null, waiting: null }, 5)).rejects.toThrow(
      'did not activate',
    )
  })

  it('requests permission only when called, never on import', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    expect(requestPermission).not.toHaveBeenCalled()
    await expect(requestNativePermission()).resolves.toBe('granted')
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('skips foreground notices without granted permission', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    const showNotification = vi.fn()
    await expect(showForegroundPaymentNotice({ showNotification })).resolves.toBe('skipped')
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('shows one tagged generic notice through the registration', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const showNotification = vi.fn().mockResolvedValue(undefined)
    await expect(showForegroundPaymentNotice({ showNotification })).resolves.toBe('shown')
    expect(showNotification).toHaveBeenCalledWith(
      NATIVE_PAYMENT_TITLE,
      expect.objectContaining({ body: NATIVE_PAYMENT_BODY, tag: NATIVE_PAYMENT_TAG, renotify: false }),
    )
    const options = showNotification.mock.calls[0]![1] as Record<string, unknown>
    expect(options.body).toBe('Open Vaulted to view your activity')
    expect(Object.keys(options).sort()).toEqual(['body', 'icon', 'renotify', 'tag'])
  })
})
