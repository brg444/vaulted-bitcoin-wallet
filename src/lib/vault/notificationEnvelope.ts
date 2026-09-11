import { isSupportedVaultNetwork } from './network'

/**
 * Opaque native-notification envelope contract. The push worker accepts only
 * this shape after the browser decrypts the web-push payload with the
 * subscription keys it keeps:
 * `{ v: 1, sub: <64-hex handle>, event: <64-hex handle>, exp: <unix seconds> }`
 *
 * Handles are opaque random references minted by the notification service.
 * No amounts, accounts, senders, vault identities, or payment references
 * travel in the payload: the visible notice is always the fixed generic
 * text, and a tap opens the app to refreshed Activity after unlock. Delivery
 * ownership is split by route (server push for covered Spending receipts,
 * foreground hook for Savings), so the envelope carries no dedup identity.
 * A handle grants no scope by itself.
 *
 * Reviewed from the dormant foundation: the strict parser, handle format,
 * expiry/TTL policy, screen-token allowlist, and scope validation are kept;
 * the window-only staged-navigation store was dropped because the generic
 * tap flow resolves nothing per event.
 */
export const NOTIFICATION_ENVELOPE_VERSION = 1
const HANDLE_PATTERN = /^[0-9a-f]{64}$/
/** Hard bound on the serialized envelope; anything larger is rejected. */
const MAX_ENVELOPE_CHARS = 512
/** Handles older than this are stale; expiry beyond this is a malformed clock. */
const MAX_ENVELOPE_TTL_SECONDS = 7 * 24 * 60 * 60

const ENVELOPE_FIELDS = ['event', 'exp', 'sub', 'v'] as const

export interface NotificationEnvelope {
  version: 1
  subscription: string
  event: string
  expiresAt: number
}

function isLiveExpiry(expiresAt: unknown, nowSeconds: number): expiresAt is number {
  return (
    typeof expiresAt === 'number' &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > nowSeconds &&
    expiresAt - nowSeconds <= MAX_ENVELOPE_TTL_SECONDS
  )
}

function exactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  return keys.length === fields.length && keys.every((key, index) => key === fields[index])
}

/** Strict versioned parse of a decrypted push payload. Unknown versions, shapes, and extras fail. */
export function parseNotificationEnvelope(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): NotificationEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!exactFields(record, ENVELOPE_FIELDS)) return null
  if (record.v !== NOTIFICATION_ENVELOPE_VERSION) return null
  if (typeof record.sub !== 'string' || !HANDLE_PATTERN.test(record.sub)) return null
  if (typeof record.event !== 'string' || !HANDLE_PATTERN.test(record.event)) return null
  if (!isLiveExpiry(record.exp, nowSeconds)) return null
  return { version: 1, subscription: record.sub, event: record.event, expiresAt: record.exp as number }
}

/** Parse a serialized envelope with the hard size bound applied first. */
export function parseNotificationEnvelopeJson(raw: string): NotificationEnvelope | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENVELOPE_CHARS) return null
  try {
    return parseNotificationEnvelope(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export type PushNavScreen = 'home' | 'activity' | 'tx'

const PUSH_NAV_SCREENS: readonly PushNavScreen[] = ['home', 'activity', 'tx']

/**
 * Allowlisted in-app screen tokens only. This is not URL validation: it
 * accepts three exact screen names and rejects absolute, external, and
 * unknown targets, so a tap target can never navigate outside the app. The
 * push worker only ever sends `activity`.
 */
export function parsePushNavScreen(value: unknown): PushNavScreen | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if ((PUSH_NAV_SCREENS as readonly string[]).includes(trimmed)) return trimmed as PushNavScreen
  return null
}

export interface PushNavScope {
  network: string
  vaultId: string
}

/**
 * Scope validity: a supported network plus a nonempty vault identity. Empty
 * values previously collapsed into shared `unknown` buckets; they fail now.
 */
export function isValidPushScope(scope: PushNavScope): boolean {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    isSupportedVaultNetwork(scope.network) &&
    typeof scope.vaultId === 'string' &&
    scope.vaultId.trim().length > 0 &&
    scope.vaultId.length <= 128
  )
}
