import { fromSatoshis, prettyFiatAmount, prettyNumber } from '../format'
import { Decimal } from 'decimal.js'
import type { Fiats } from '../types'

export type VaultBalanceUnit = 'sats' | 'usd'

export interface VaultFiatDisplayRate {
  currency: Fiats
  pricePerBtc: number
}

export function usdFromSats(sats: number, usdPerBtc: number): number {
  if (!Number.isFinite(sats) || !Number.isFinite(usdPerBtc) || usdPerBtc <= 0) return 0
  // Decimal division first: binary floating point turns 25 sats at $100k/BTC
  // into 0.024999999999999998 and misprices the cent.
  return new Decimal(sats).div(100_000_000).mul(usdPerBtc).toNumber()
}

export function satsFromUsd(usd: number, usdPerBtc: number): number {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(usdPerBtc) || usdPerBtc <= 0) return 0
  return new Decimal(usd).div(usdPerBtc).mul(100_000_000).round().toNumber()
}

export function hasUsdRate(rate?: VaultFiatDisplayRate | null): rate is VaultFiatDisplayRate {
  return Boolean(rate && Number.isFinite(rate.pricePerBtc) && rate.pricePerBtc > 0)
}

export interface MoneyDenomination {
  unit: VaultBalanceUnit
  rate?: VaultFiatDisplayRate | null
}

/** Canonical sats rendered in the active display unit. Falls back to sats when no rate is available. */
export function formatMoney(sats: number, denomination: MoneyDenomination): string {
  if (denomination.unit === 'usd' && hasUsdRate(denomination.rate)) {
    return prettyFiatAmount(usdFromSats(sats, denomination.rate.pricePerBtc), denomination.rate.currency)
  }
  return `₿${prettyNumber(sats)}`
}

/** True when USD is selected but no usable rate is available, so sats are shown as a fallback. */
export function isRateUnavailable(denomination: MoneyDenomination): boolean {
  return denomination.unit === 'usd' && !hasUsdRate(denomination.rate)
}

/** Signed amounts keep their sign outside the currency symbol (`−$1.00`, `+₿1,000`). */
export function formatSignedMoney(sats: number, denomination: MoneyDenomination, incoming: boolean): string {
  const sign = incoming ? '+' : '−'
  if (sats === 0) return formatMoney(0, denomination)
  return `${sign}${formatMoney(Math.abs(sats), denomination)}`
}

/** USD text for amount inputs. Returns '' when no rate is available so callers never invent a value. */
export function usdInputFromSats(sats: number, rate?: VaultFiatDisplayRate | null): string {
  if (!hasUsdRate(rate)) return ''
  // Decimal two-decimal formatting rounds the exact value (0.025 -> '0.03');
  // binary toFixed can round a representation artifact instead.
  return new Decimal(sats).div(100_000_000).mul(rate.pricePerBtc).toFixed(2)
}

export function homeBalanceDisplay(
  sats: number,
  unit: VaultBalanceUnit,
  rate?: VaultFiatDisplayRate | null,
): { amount: string; unit: string; label: string } {
  if (unit === 'usd' && rate && Number.isFinite(rate.pricePerBtc) && rate.pricePerBtc > 0) {
    const amount = prettyFiatAmount(usdFromSats(sats, rate.pricePerBtc), rate.currency)
    return { amount, unit: '', label: amount }
  }
  const amount = `₿${prettyNumber(sats)}`
  return { amount, unit: '', label: amount }
}

export function approximateFiatLabel(sats: number, rate?: VaultFiatDisplayRate | null): string {
  if (!rate || !Number.isFinite(rate.pricePerBtc) || rate.pricePerBtc <= 0) return ''
  return `approximately ${prettyFiatAmount(fromSatoshis(sats) * rate.pricePerBtc, rate.currency)}`
}
