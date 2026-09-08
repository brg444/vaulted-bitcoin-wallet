import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VirtualCoin } from '@arkade-os/sdk'
import { chooseBitcoinInput, rememberBitcoinEligibility } from './bitcoinEligibility'
import { bitcoinPaymentRejected } from './bitcoinPaymentError'

const now = Date.UTC(2026, 8, 8, 12)
const day = 86400000
const coin = { txid: 'ab'.repeat(32), vout: 0, value: 25000, expiresAt: new Date(now + 30 * day) } as VirtualCoin
const reason =
  'INVALID_PSBT_INPUT (5): vtxo [redacted] expires after 2026-10-07 12:18:19.47932425 +0000 UTC m=+2519147.005463777 (minExpiryGap: 695h53m36s)'
beforeEach(() => {
  localStorage.clear()
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => vi.restoreAllMocks())

it('derives the wait from the input expiry and observed gap, never the printed cutoff or creation time', () => {
  const retry = rememberBitcoinEligibility('mainnet:vault', coin, reason)!
  expect(retry).toBe(now + day + 8 * 60000)
  expect(() => chooseBitcoinInput('mainnet:vault', [coin], 1000)).toThrow('Expected availability')
  const message = bitcoinPaymentRejected(reason, retry)
  expect(message.details).toBe(reason)
  expect(message.message).not.toMatch(/INVALID_PSBT|October|UTC m=|695h/)
  expect(message.message).toContain('Nothing was sent')
})

it('prefers an eligible input and isolates hints by vault, Operator and exact expiry', () => {
  rememberBitcoinEligibility('mainnet:vault', coin, reason)
  const older = { ...coin, txid: 'cd'.repeat(32), value: 10000 }
  expect(chooseBitcoinInput('mainnet:vault', [coin, older], 1000)).toEqual(older)
  expect(chooseBitcoinInput('other:vault', [coin], 1000)).toEqual(coin)
  expect(chooseBitcoinInput('mainnet:vault', [{ ...coin, expiresAt: new Date(now + day) }], 1000)).toBeDefined()
  expect(() => chooseBitcoinInput('mainnet:vault', [coin, older], 20000)).toThrow('Expected availability')
})

it('expires hints, permits rechecking changed policy, and tolerates malformed storage', () => {
  rememberBitcoinEligibility('scope', coin, reason)
  vi.spyOn(Date, 'now').mockReturnValue(now + day + 8 * 60000)
  expect(chooseBitcoinInput('scope', [coin], 1000)).toEqual(coin)
  localStorage.setItem('vaulted:bitcoin-eligibility:scope', '{')
  expect(chooseBitcoinInput('scope', [coin], 1000)).toEqual(coin)
})

it.each([
  '',
  'expires after (minExpiryGap: 0s)',
  'expires after (minExpiryGap: NaNs)',
  'expires after (minExpiryGap: 999999999999999999h)',
  'input already spent',
])('does not invent availability from %s', (message) => {
  expect(rememberBitcoinEligibility('scope', coin, message)).toBeUndefined()
  expect(chooseBitcoinInput('scope', [coin], 1000)).toEqual(coin)
})

it('keeps unknown rejections out of primary copy without discarding support details', () => {
  const error = bitcoinPaymentRejected('INTERNAL_ERROR: unexpected server failure')
  expect(error.message).toContain('not sent')
  expect(error.message).not.toContain('INTERNAL_ERROR')
  expect(error.details).toContain('INTERNAL_ERROR')
})
