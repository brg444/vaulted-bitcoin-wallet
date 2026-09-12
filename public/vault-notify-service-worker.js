/**
 * Vaulted native payment notifications worker.
 *
 * Dedicated narrow scope (`/__vault-notify/`): no wallet state, no keys, no
 * signing capability, and no fetch handler. Delivery ownership is split by
 * route: the server emits pushes only for covered Spending receipts, and
 * this worker renders every valid one — amounts, accounts, senders, and
 * vault identities never reach the lock screen. A tap opens the app to
 * refreshed Activity after unlock.
 *
 * Replacement, not exactly-once: each event carries a stable tag
 * (`vaulted-payment:<event>`) with renotify false, so a retried delivery
 * replaces its own notice instead of stacking. The worker keeps no delivery
 * ledger: if the platform reports the push, the notice renders. Activity
 * remains the source of truth.
 */
'use strict'

const TITLE = 'Payment received'
const BODY = 'Open Vaulted to view your activity'
const TAG_PREFIX = 'vaulted-payment:'
const ICON = '/vaulted-icon-192.png'
const TAP_PATH = '/?notify=activity'
const HANDLE_PATTERN = /^[0-9a-f]{64}$/
const MAX_ENVELOPE_CHARS = 512
const MAX_ENVELOPE_TTL_SECONDS = 7 * 24 * 60 * 60

function parseEnvelope(value, nowSeconds) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== 4 || keys[0] !== 'event' || keys[1] !== 'exp' || keys[2] !== 'sub' || keys[3] !== 'v') {
    return null
  }
  if (value.v !== 1) return null
  if (typeof value.sub !== 'string' || !HANDLE_PATTERN.test(value.sub)) return null
  if (typeof value.event !== 'string' || !HANDLE_PATTERN.test(value.event)) return null
  if (
    typeof value.exp !== 'number' ||
    !Number.isSafeInteger(value.exp) ||
    value.exp <= nowSeconds ||
    value.exp - nowSeconds > MAX_ENVELOPE_TTL_SECONDS
  ) {
    return null
  }
  return { subscription: value.sub, event: value.event, expiresAt: value.exp }
}

async function handlePush(eventData) {
  let raw = null
  try {
    raw = eventData ? eventData.json() : null
  } catch {
    return false
  }
  if (typeof raw === 'string') {
    if (raw.length === 0 || raw.length > MAX_ENVELOPE_CHARS) return false
    try {
      raw = JSON.parse(raw)
    } catch {
      return false
    }
  }
  const envelope = parseEnvelope(raw, Math.floor(Date.now() / 1000))
  if (!envelope) return false
  // Every valid push renders: silent push violates userVisibleOnly and risks
  // the platform revoking permission. Retries replace via the stable tag.
  await self.registration.showNotification(TITLE, {
    body: BODY,
    tag: TAG_PREFIX + envelope.event,
    icon: ICON,
    renotify: false,
  })
  return true
}

async function handleClick() {
  const url = new URL(TAP_PATH, self.location.origin).toString()
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    try {
      const current = new URL(client.url)
      if (current.origin !== self.location.origin) continue
      await client.focus()
      await client.navigate(url)
      return
    } catch {
      // Try the next client, then fall back to opening a window.
    }
  }
  await self.clients.openWindow(url)
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data).catch(() => false))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(handleClick().catch(() => undefined))
})

// The browser fires this when it rotates push keys. The worker holds no
// wallet credential to resubscribe with, so it stays silent; the app refreshes
// the subscription on its next Settings visit instead.
self.addEventListener('pushsubscriptionchange', () => {})
