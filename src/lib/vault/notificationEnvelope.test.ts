import { describe, expect, it } from 'vitest'
import {
  isValidPushScope,
  parseNotificationEnvelope,
  parseNotificationEnvelopeJson,
  parsePushNavScreen,
} from './notificationEnvelope'

const sub = 'ab'.repeat(32)
const event = 'cd'.repeat(32)
const live = () => Math.floor(Date.now() / 1000) + 3600

describe('native notification envelope', () => {
  it('accepts the exact versioned shape', () => {
    expect(parseNotificationEnvelope({ v: 1, sub, event, exp: live() })).toEqual({
      version: 1,
      subscription: sub,
      event,
      expiresAt: expect.any(Number),
    })
    // The minimal contract carries no dedup identity: extras fail.
    expect(parseNotificationEnvelope({ v: 1, sub, event, exp: live(), pay: 'lightning:x' })).toBeNull()
  })

  it('rejects unknown versions, extras, and malformed handles', () => {
    const base = { v: 1, sub, event, exp: live() }
    expect(parseNotificationEnvelope({ ...base, v: 2 })).toBeNull()
    expect(parseNotificationEnvelope({ ...base, extra: 1 })).toBeNull()
    expect(parseNotificationEnvelope({ ...base, sub: 'xyz' })).toBeNull()
    expect(parseNotificationEnvelope({ ...base, event: 'AB'.repeat(32) })).toBeNull()
    expect(parseNotificationEnvelope({ ...base, exp: 'soon' })).toBeNull()
    expect(parseNotificationEnvelope(null)).toBeNull()
    expect(parseNotificationEnvelope([1])).toBeNull()
  })

  it('rejects expired and far-future expiries', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(parseNotificationEnvelope({ v: 1, sub, event, exp: now - 1 }, now)).toBeNull()
    expect(parseNotificationEnvelope({ v: 1, sub, event, exp: now + 8 * 24 * 60 * 60 }, now)).toBeNull()
  })

  it('bounds serialized envelopes before parsing', () => {
    expect(parseNotificationEnvelopeJson(JSON.stringify({ v: 1, sub, event, exp: live() }))).not.toBeNull()
    expect(parseNotificationEnvelopeJson('')).toBeNull()
    expect(parseNotificationEnvelopeJson('x'.repeat(513))).toBeNull()
    expect(parseNotificationEnvelopeJson('{invalid')).toBeNull()
  })

  it('never leaks payment content: the envelope carries handles only', () => {
    const parsed = parseNotificationEnvelopeJson(JSON.stringify({ v: 1, sub, event, exp: live() }))!
    expect(Object.keys(parsed).sort()).toEqual(['event', 'expiresAt', 'subscription', 'version'])
  })

  it('allow-lists tap screens and rejects external targets', () => {
    expect(parsePushNavScreen('activity')).toBe('activity')
    expect(parsePushNavScreen(' home ')).toBe('home')
    expect(parsePushNavScreen('https://evil.example')).toBeNull()
    expect(parsePushNavScreen('/activity')).toBeNull()
    expect(parsePushNavScreen('settings')).toBeNull()
    expect(parsePushNavScreen(42)).toBeNull()
  })

  it('validates push scopes by supported network and owner', () => {
    expect(isValidPushScope({ network: 'mainnet', vaultId: 'abc' })).toBe(true)
    expect(isValidPushScope({ network: 'mutinynet', vaultId: 'abc' })).toBe(true)
    expect(isValidPushScope({ network: 'regtest', vaultId: 'abc' })).toBe(false)
    expect(isValidPushScope({ network: 'mainnet', vaultId: '' })).toBe(false)
    expect(isValidPushScope({ network: 'mainnet', vaultId: 'x'.repeat(129) })).toBe(false)
  })
})
