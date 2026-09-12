import { describe, expect, it } from 'vitest'
import { satPerVFromFeeEstimates } from './onchainFee'

describe('onchain confirmation estimate selection', () => {
  it('picks the first estimate at or above the confirmation target', () => {
    expect(satPerVFromFeeEstimates({ 1: 8, 3: 2.2, 6: 1 })).toBe(2.2)
    expect(satPerVFromFeeEstimates({ 1: 8, 2: 5 })).toBe(5)
    expect(satPerVFromFeeEstimates({ 1: 8, 3: 2.2, 6: 1 }, 6)).toBe(1)
  })

  it('ignores invalid confirmation targets and rejects unusable estimates', () => {
    expect(satPerVFromFeeEstimates({ '-1': 100, '0': 100, '1.5': 100, '3': 2.2 })).toBe(2.2)
    expect(() => satPerVFromFeeEstimates({})).toThrow('missing')
    for (const value of [NaN, Infinity, 0, -1]) expect(() => satPerVFromFeeEstimates({ '3': value })).toThrow('invalid')
  })
})
