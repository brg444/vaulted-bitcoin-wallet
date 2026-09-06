import type { VirtualCoin } from '@arkade-os/sdk'

/** Earliest live expiry determines when this wallet needs attention. */
export function lightRenewalTiming(coins: VirtualCoin[], now = Date.now()) {
  const active = coins.filter((coin) => !coin.isSpent && !coin.isSwept)
  const times = active.map((coin) => coin.expiresAt?.getTime())
  const known = times.filter((time): time is number => time !== undefined && Number.isFinite(time))
  const expiresAt = known.length ? Math.min(...known) : null
  return {
    expiresAt,
    incomplete: known.length !== active.length,
    due: expiresAt !== null && expiresAt - now <= 3 * 24 * 60 * 60 * 1000,
    expired: expiresAt !== null && expiresAt <= now,
  }
}
