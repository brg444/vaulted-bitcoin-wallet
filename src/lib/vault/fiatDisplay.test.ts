import { describe, expect, it } from 'vitest'
import { Fiats } from '../types'
import {
  approximateFiatLabel,
  formatMoney,
  homeBalanceDisplay,
  satsFromUsd,
  usdFromSats,
  usdInputFromSats,
} from './fiatDisplay'

describe('vault fiat display', () => {
  it('formats an approximate display value without changing satoshi amounts', () => {
    expect(approximateFiatLabel(50_000, { currency: Fiats.USD, pricePerBtc: 100_000 })).toBe('approximately $50.00')
    expect(approximateFiatLabel(50_000, null)).toBe('')
    expect(approximateFiatLabel(50_000, { currency: Fiats.USD, pricePerBtc: Number.NaN })).toBe('')
  })

  it('converts sats using the supplied USD price', () => {
    expect(usdFromSats(100_000_000, 125_000)).toBe(125_000)
    expect(usdFromSats(50_000, 125_000)).toBe(62.5)
    expect(usdFromSats(1_000, 125_000)).toBe(1.25)
  })

  it('converts USD input back to whole satoshis', () => {
    expect(satsFromUsd(62.5, 125_000)).toBe(50_000)
    expect(satsFromUsd(0.01, 100_000)).toBe(10)
    expect(satsFromUsd(1, 0)).toBe(0)
  })

  it('keeps dust conversions exact through decimal arithmetic', () => {
    // Division-first floating point prices 25 sats at $0.024999999999999998.
    expect(usdFromSats(25, 100_000)).toBe(0.025)
    expect(usdInputFromSats(25, { currency: Fiats.USD, pricePerBtc: 100_000 })).toBe('0.03')
    expect(usdInputFromSats(331, { currency: Fiats.USD, pricePerBtc: 100_000 })).toBe('0.33')
    expect(formatMoney(25, { unit: 'usd', rate: { currency: Fiats.USD, pricePerBtc: 100_000 } })).toBe('$0.03')
  })

  it('rounds half-cent values away from a representation artifact', () => {
    expect(usdInputFromSats(5, { currency: Fiats.USD, pricePerBtc: 100_000 })).toBe('0.01')
    expect(satsFromUsd(0.03, 100_000)).toBe(30)
  })

  it('formats the Home hero as bitcoin or USD using the live display rate', () => {
    expect(homeBalanceDisplay(10_000, 'sats')).toEqual({
      amount: '₿10,000',
      unit: '',
      label: '₿10,000',
    })
    expect(homeBalanceDisplay(128_000, 'sats')).toEqual({
      amount: '₿128,000',
      unit: '',
      label: '₿128,000',
    })
    expect(homeBalanceDisplay(128_000, 'usd', { currency: Fiats.USD, pricePerBtc: 125_000 })).toEqual({
      amount: '$160.00',
      unit: '',
      label: '$160.00',
    })
    expect(homeBalanceDisplay(100_000_000, 'usd', { currency: Fiats.USD, pricePerBtc: 125_000 }).amount).toBe(
      '$125,000.00',
    )
  })

  it('falls back to sats when a USD rate is unavailable or invalid', () => {
    expect(homeBalanceDisplay(128_000, 'usd', null).label).toBe('₿128,000')
    expect(homeBalanceDisplay(128_000, 'usd', { currency: Fiats.USD, pricePerBtc: Number.NaN }).label).toBe('₿128,000')
  })
})
