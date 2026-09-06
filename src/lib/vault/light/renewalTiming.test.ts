import { describe, expect, it } from 'vitest'
import type { VirtualCoin } from '@arkade-os/sdk'
import { lightRenewalTiming } from './renewalTiming'

const now = Date.parse('2026-09-05T00:00:00Z')
const day = 24 * 60 * 60 * 1000
const coin = (days: number, extra = {}) => ({ expiresAt: new Date(now + days * day), ...extra }) as VirtualCoin

describe('Light renewal reminders', () => {
  it('uses the next live expiry and warns three days ahead', () => {
    expect(lightRenewalTiming([coin(20), coin(3), coin(-1, { isSpent: true })], now)).toEqual({
      expiresAt: now + 3 * day,
      incomplete: false,
      due: true,
      expired: false,
    })
    expect(lightRenewalTiming([coin(4)], now).due).toBe(false)
  })
  it('distinguishes expiry and missing metadata from an empty wallet', () => {
    expect(lightRenewalTiming([coin(0)], now).expired).toBe(true)
    expect(lightRenewalTiming([coin(NaN)], now)).toEqual({
      expiresAt: null,
      incomplete: true,
      due: false,
      expired: false,
    })
    expect(lightRenewalTiming([coin(-1, { isSwept: true })], now)).toEqual({
      expiresAt: null,
      incomplete: false,
      due: false,
      expired: false,
    })
  })
})
