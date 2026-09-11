import { LNURL_ORIGIN, configureLightningAddress, loadLightningAddress } from './lnurl'
import {
  NOTIFY_WORKER_SCOPE,
  NOTIFY_WORKER_URL,
  awaitNotifyWorkerActive,
  pushVapidPublicKey,
  vapidKeyBytes,
} from './nativeNotifications'
import { readBounded } from './bounded'
import type { VaultStatus } from './types'

/**
 * Authenticated push subscription management. Authorization reuses the
 * Guardian/LNURL wallet credential: the readToken issued by the
 * Guardian-bridged receiving registration (obtained through the existing
 * passkey-authenticated Lightning-address flow). Subscriptions pin to the
 * enrolled receiver server-side; the client never supplies an address or
 * script, so enabling notifications cannot watch an arbitrary feed.
 *
 * The subscription lives on the dedicated narrow-scope worker
 * (`/__vault-notify/`), never on a per-vault wallet worker. Permission is
 * granted by the OS; this module only runs from explicit user gestures.
 */

const SUBSCRIPTION_TIMEOUT_MS = 15_000

interface StoredPushSubscription {
  subHandle: string
  expiresAt: number
  endpoint?: string
}

function storageKey(status: VaultStatus): string {
  return `vaulted:push:v1:${status.network}:${status.vaultId}`
}

function loadStored(status: VaultStatus): StoredPushSubscription | null {
  try {
    const raw = localStorage.getItem(storageKey(status))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredPushSubscription>
    if (typeof parsed.subHandle !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.subHandle)) return null
    if (typeof parsed.expiresAt !== 'number' || !Number.isSafeInteger(parsed.expiresAt)) return null
    return {
      subHandle: parsed.subHandle,
      expiresAt: parsed.expiresAt,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : undefined,
    }
  } catch {
    return null
  }
}

function saveStored(status: VaultStatus, value: StoredPushSubscription): void {
  localStorage.setItem(storageKey(status), JSON.stringify(value))
}

export function clearStoredPushSubscription(status: VaultStatus): void {
  localStorage.removeItem(storageKey(status))
}

/** True while a stored subscription handle is present and unexpired. */
export function isPushSubscribed(status: VaultStatus): boolean {
  const stored = loadStored(status)
  return stored !== null && stored.expiresAt > Date.now()
}

/**
 * Reconcile the client Enabled state with the server. Drops stored handles
 * the server no longer knows (swept, revoked, or foreign), so Settings can
 * never strand the user in a false Enabled state. Network failures leave
 * local state untouched.
 */
export async function reconcilePushState(
  status: VaultStatus,
): Promise<{ subscribed: boolean; expiresAt: number | null }> {
  const stored = loadStored(status)
  if (!stored) return { subscribed: false, expiresAt: null }
  try {
    const registration = await navigator.serviceWorker.getRegistration(NOTIFY_WORKER_SCOPE)
    const subscription = await registration?.pushManager.getSubscription()
    if (
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted' ||
      !subscription ||
      (stored.endpoint && stored.endpoint !== subscription.endpoint)
    ) {
      await disableBackgroundPush(status)
      return { subscribed: false, expiresAt: null }
    }
    const listed = (await receiverFetch(status, '/v1/vaulted/push/subscriptions', { method: 'GET' })) as {
      subscriptions: { subHandle: string; expiresAt: number }[]
    }
    const match = Array.isArray(listed.subscriptions)
      ? listed.subscriptions.find((s) => s.subHandle === stored.subHandle)
      : undefined
    if (!match) {
      clearStoredPushSubscription(status)
      return { subscribed: false, expiresAt: null }
    }
    saveStored(status, {
      ...stored,
      subHandle: match.subHandle,
      expiresAt: match.expiresAt,
      endpoint: subscription.endpoint,
    })
    return { subscribed: match.expiresAt > Date.now(), expiresAt: match.expiresAt }
  } catch {
    // Keep the handle for a retry, but never report an unverified device as enabled.
    throw new Error('Could not check device notifications. Please try again when connected.')
  }
}

function keyToBase64url(buffer: ArrayBuffer | null): string {
  if (!buffer) throw new Error('Push subscription keys are unavailable.')
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function receiverFetch(status: VaultStatus, path: string, init: RequestInit): Promise<unknown> {
  let address = null
  try {
    address = loadLightningAddress(status)
  } catch {
    address = null
  }
  if (!address) {
    throw new Error(
      'Background notifications need the receiver enrollment. Set up your Lightning address first, then enable notifications.',
    )
  }
  const response = await fetch(`${LNURL_ORIGIN}${path}`, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${address.readToken}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const raw = await readBounded(response, 16_384)
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('This device is no longer authorized for background notifications. Sign out and sign in again.')
    }
    throw new Error('Background notifications are temporarily unavailable. Payments are unaffected.')
  }
  return JSON.parse(raw) as unknown
}

export async function notifyWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('Push notifications are not supported in this browser.')
  // Narrow scope: this registration never sees wallet worker traffic, and the
  // per-vault wallet workers never see push traffic. Await THIS
  // registration's activation: a cold install has active === null until the
  // worker activates, and the page-scope ready promise does not cover it.
  const registration = await navigator.serviceWorker.register(NOTIFY_WORKER_URL, { scope: NOTIFY_WORKER_SCOPE })
  await awaitNotifyWorkerActive(registration)
  return registration
}

/** Subscribe (or refresh) background push for this vault. Gesture-only.
 *
 *  Permission must already be granted: Settings requests it directly in the
 *  click handler before any network or passkey await, and this function
 *  throws before touching the network when it is not granted. If the
 *  Guardian-bridged receiver enrollment is missing, it performs the existing
 *  passkey-authenticated nameless registration (no public Lightning address
 *  is claimed); a Guardian that requires a name surfaces its exact error and
 *  Settings falls back to address-setup guidance.
 */
export async function enableBackgroundPush(
  status: VaultStatus,
  isCurrent: () => boolean = () => true,
): Promise<StoredPushSubscription> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Wallet changed. Reopen notification settings to continue.')
  }
  const finish = async (next: StoredPushSubscription): Promise<StoredPushSubscription> => {
    if (!isCurrent()) {
      await receiverFetch(status, `/v1/vaulted/push/subscriptions/${next.subHandle}`, { method: 'DELETE' })
      assertCurrent()
    }
    saveStored(status, next)
    return next
  }
  assertCurrent()
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    throw new Error('Allow notifications first, then enable background alerts.')
  }
  const vapidKey = vapidKeyBytes(pushVapidPublicKey())
  if (!vapidKey) throw new Error('Background notifications are not configured for this release yet.')
  let address = null
  try {
    address = loadLightningAddress(status)
  } catch {
    address = null
  }
  if (!address) {
    address = await configureLightningAddress(status, 'register', '')
  }
  void address
  assertCurrent()
  const registration = await notifyWorkerRegistration()
  assertCurrent()
  if (!registration.pushManager) throw new Error('Push notifications are not supported in this browser.')
  const existing = await registration.pushManager.getSubscription()
  const stored = loadStored(status)
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(vapidKey),
    }))
  assertCurrent()
  const body = {
    endpoint: subscription.endpoint,
    p256dh: keyToBase64url(subscription.getKey('p256dh')),
    auth: keyToBase64url(subscription.getKey('auth')),
    encoding: 'aes128gcm',
  }
  if (stored) {
    try {
      const refreshed = (await receiverFetch(status, `/v1/vaulted/push/subscriptions/${stored.subHandle}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })) as { expiresAt: number }
      const next = { subHandle: stored.subHandle, expiresAt: refreshed.expiresAt, endpoint: subscription.endpoint }
      return await finish(next)
    } catch {
      // Unknown or expired server handle: fall through and create fresh.
    }
  }
  assertCurrent()
  const created = (await receiverFetch(status, '/v1/vaulted/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { subHandle: string; expiresAt: number }
  if (typeof created.subHandle !== 'string' || !/^[0-9a-f]{64}$/.test(created.subHandle)) {
    throw new Error('Background notifications are temporarily unavailable. Payments are unaffected.')
  }
  const next = { subHandle: created.subHandle, expiresAt: created.expiresAt, endpoint: subscription.endpoint }
  return finish(next)
}

/** Revoke this wallet's server handle. The device endpoint may serve other wallets. */
export async function disableBackgroundPush(status: VaultStatus): Promise<void> {
  const stored = loadStored(status)
  if (!stored) return
  await receiverFetch(status, `/v1/vaulted/push/subscriptions/${stored.subHandle}`, { method: 'DELETE' })
  clearStoredPushSubscription(status)
  // Never unsubscribe the origin-wide PushSubscription here: another wallet
  // or tab may still use it. A revoked handle has no future server deliveries.
}

/** Refresh an already-authorized endpoint on unlock; never prompts or enrolls. */
export async function refreshBackgroundPush(status: VaultStatus): Promise<void> {
  const stored = loadStored(status)
  if (!stored || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker.getRegistration(NOTIFY_WORKER_SCOPE)
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  // Renew before the server lease expires; keep endpoint rotation in sync.
  if (stored.endpoint === subscription.endpoint && stored.expiresAt > Date.now() + 7 * 86400000) return
  const body = JSON.stringify({
    endpoint: subscription.endpoint,
    p256dh: keyToBase64url(subscription.getKey('p256dh')),
    auth: keyToBase64url(subscription.getKey('auth')),
    encoding: 'aes128gcm',
  })
  const updated = (await receiverFetch(status, '/v1/vaulted/push/subscriptions', {
    method: 'POST',
    body,
  })) as StoredPushSubscription
  if (loadStored(status)?.subHandle !== stored.subHandle) {
    if (/^[0-9a-f]{64}$/.test(updated.subHandle))
      await receiverFetch(status, `/v1/vaulted/push/subscriptions/${updated.subHandle}`, { method: 'DELETE' })
    return
  }
  if (/^[0-9a-f]{64}$/.test(updated.subHandle) && Number.isSafeInteger(updated.expiresAt))
    saveStored(status, { ...updated, endpoint: subscription.endpoint })
}

export interface BackgroundPushState {
  capable: boolean
  permission: 'default' | 'granted' | 'denied' | 'unsupported'
  vapidConfigured: boolean
  enrolled: boolean
  subscribed: boolean
  expiresAt: number | null
}

/** Synchronous settings state. Never prompts, never touches the network. */
export function backgroundPushState(status: VaultStatus | null): BackgroundPushState {
  const capable = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  const permission: BackgroundPushState['permission'] =
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission === 'granted' || Notification.permission === 'denied'
        ? Notification.permission
        : 'default'
  if (!status) {
    return {
      capable,
      permission,
      vapidConfigured: vapidKeyBytes(pushVapidPublicKey()) !== null,
      enrolled: false,
      subscribed: false,
      expiresAt: null,
    }
  }
  let enrolled = false
  try {
    enrolled = loadLightningAddress(status) !== undefined
  } catch {
    enrolled = false
  }
  const stored = loadStored(status)
  return {
    capable,
    permission,
    vapidConfigured: vapidKeyBytes(pushVapidPublicKey()) !== null,
    enrolled,
    subscribed: stored !== null && stored.expiresAt > Date.now(),
    expiresAt: stored?.expiresAt ?? null,
  }
}
