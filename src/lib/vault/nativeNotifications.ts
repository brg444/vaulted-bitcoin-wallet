/**
 * Native device notification primitives. The visible notice is always the
 * fixed generic text below — amounts, accounts, senders, and vault identities
 * never reach the lock screen. Native OS controls govern haptics and sounds;
 * this module never vibrates or plays audio, and ordinary interaction
 * haptics stay untouched.
 *
 * Permission is requested only from an explicit user gesture (the Settings
 * enable button calls `requestNativePermission`). Nothing in this module
 * prompts on page load.
 */
export const NATIVE_PAYMENT_TITLE = 'Payment received'
export const NATIVE_PAYMENT_BODY = 'Open Vaulted to view your activity'
export const NATIVE_PAYMENT_TAG = 'vaulted-payment'
/** Dedicated narrow-scope worker: no wallet state, keys, or signing. */
export const NOTIFY_WORKER_URL = '/vault-notify-service-worker.js'
export const NOTIFY_WORKER_SCOPE = '/__vault-notify/'
/** Tap target opened by the worker; the app allow-lists it before navigating. */
export const NOTIFY_NAV_SCREEN = 'activity'

export type NativePermission = 'default' | 'granted' | 'denied'

interface PushEnv {
  Notification?: { permission?: unknown } | undefined
  serviceWorker?: unknown
  PushManager?: unknown
}

function activeEnv(overridden?: PushEnv): PushEnv {
  if (overridden) return overridden
  return {
    Notification: typeof Notification === 'undefined' ? undefined : Notification,
    serviceWorker: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
    PushManager: typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>).PushManager,
  }
}

/** True when this browser can do OS notifications with background push. */
export function isPushCapable(env?: PushEnv): boolean {
  const active = activeEnv(env)
  return (
    typeof active.Notification !== 'undefined' &&
    typeof active.serviceWorker !== 'undefined' &&
    typeof active.PushManager !== 'undefined'
  )
}

/** Current OS permission, or `unsupported` when the APIs are absent. Never prompts. */
export function readNotificationPermission(env?: PushEnv): NativePermission | 'unsupported' {
  const active = activeEnv(env)
  if (typeof active.Notification === 'undefined') return 'unsupported'
  const permission = (active.Notification as { permission?: unknown }).permission
  return permission === 'granted' || permission === 'denied' ? permission : 'default'
}

/**
 * iPhone supports web push only in the installed Home Screen app. A browser
 * tab must show install guidance instead of pretending notifications work.
 */
export function needsInstallForPush(userAgent: string, standalone: boolean): boolean {
  if (standalone) return false
  return /iphone|ipad|ipod/i.test(userAgent)
}

/** Decode the VAPID public key (base64url uncompressed P-256) for PushManager. */
export function vapidKeyBytes(key: unknown): Uint8Array | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 128) return null
  try {
    const binary = atob(key.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    if (bytes.length !== 65 || bytes[0] !== 0x04) return null
    return bytes
  } catch {
    return null
  }
}

export function pushVapidPublicKey(): string {
  return String(import.meta.env.VITE_PUSH_VAPID_PUBLIC_KEY || '').trim()
}

/**
 * Gesture-only permission request. Call exclusively from a user-activated
 * button; never on load, navigation, or render.
 */
export async function requestNativePermission(): Promise<NativePermission> {
  if (typeof Notification === 'undefined') throw new Error('Notifications are not supported in this browser.')
  const result = await Notification.requestPermission()
  if (result !== 'granted' && result !== 'denied') return 'default'
  return result
}

/** Bound for first-time worker activation waits. */
export const NOTIFY_WORKER_ACTIVE_TIMEOUT_MS = 10_000

interface ActivatableRegistration {
  active?: { addEventListener?: (name: string, fn: () => void) => void; state?: string } | null
  installing?: { addEventListener?: (name: string, fn: () => void) => void; state?: string } | null
  waiting?: { addEventListener?: (name: string, fn: () => void) => void; state?: string } | null
}

/**
 * Await THIS registration becoming active. A fresh install has
 * `active === null` until the worker activates; subscribing or showing
 * through it first fails on some browsers. `navigator.serviceWorker.ready`
 * resolves for the page scope and is wrong for this narrow scope.
 */
export async function awaitNotifyWorkerActive(
  registration: ActivatableRegistration,
  timeoutMs = NOTIFY_WORKER_ACTIVE_TIMEOUT_MS,
): Promise<void> {
  if (registration.active?.state === 'activated') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification worker did not activate. Please reopen the app and try again.')), timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const watch = (worker: ActivatableRegistration['installing']) => {
      if (!worker || typeof worker.addEventListener !== 'function') return
      if (worker.state === 'activated') {
        done()
        return
      }
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || (registration.active?.state === 'activated')) done()
      })
    }
    watch(registration.installing)
    watch(registration.waiting)
    watch(registration.active)
    // Already flipped between the first check and the listeners.
    if (registration.active?.state === 'activated') done()
  })
}

interface NoticeRegistration {
  showNotification: (title: string, options: Record<string, unknown>) => Promise<void>
}

/**
 * Show one generic foreground notice for verified receipts. Foreground and
 * background pushes have separate route ownership; repeated foreground
 * notices replace the existing generic foreground entry.
 */
export async function showForegroundPaymentNotice(
  registration?: NoticeRegistration | null,
): Promise<'shown' | 'skipped'> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'skipped'
  if (registration) {
    try {
      await registration.showNotification(NATIVE_PAYMENT_TITLE, {
        body: NATIVE_PAYMENT_BODY,
        tag: NATIVE_PAYMENT_TAG,
        icon: '/vaulted-icon-192.png',
        renotify: false,
      })
      return 'shown'
    } catch {
      // Fall through to the window Notification below.
    }
  }
  try {
    const notice = new Notification(NATIVE_PAYMENT_TITLE, { body: NATIVE_PAYMENT_BODY, tag: NATIVE_PAYMENT_TAG })
    notice.onclick = () => { window.focus(); window.location.assign('/?notify=activity'); notice.close() }
    return 'shown'
  } catch {
    return 'skipped'
  }
}
