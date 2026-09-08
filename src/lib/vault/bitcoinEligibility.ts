import type { VirtualCoin } from '@arkade-os/sdk'
import { bitcoinPaymentWait } from './bitcoinPaymentError'

type Wait = { txid: string; vout: number; expiresAt: number; retryAt: number; observedAt: number }
const key = (scope: string) => `vaulted:bitcoin-eligibility:${scope}`
const day = 86400000

// The public Operator info endpoint does not advertise settlementMinExpiryGap.
// Remember only an explicit rejection of this exact input, never an assumed age
// rule for the network. This hint cannot authorize, reserve or release funds.
function read(scope: string): Wait[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope)) || '[]')
    if (!Array.isArray(value)) return []
    return value
      .filter(
        (w) =>
          w &&
          /^[a-f0-9]{64}$/.test(w.txid) &&
          Number.isSafeInteger(w.vout) &&
          w.vout >= 0 &&
          [w.expiresAt, w.retryAt, w.observedAt].every(Number.isSafeInteger) &&
          w.retryAt > Date.now() &&
          w.retryAt <= w.expiresAt &&
          w.observedAt <= Date.now() &&
          w.observedAt > Date.now() - day,
      )
      .slice(-50)
  } catch {
    return []
  }
}

export function rememberBitcoinEligibility(
  scope: string,
  coin: Pick<VirtualCoin, 'txid' | 'vout' | 'expiresAt'>,
  reason?: string,
): number | undefined {
  if (!reason?.includes('expires after')) return
  const match = /\(minExpiryGap: (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?\)/.exec(reason)
  if (!match || !match.slice(1).some(Boolean)) return
  const gap = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000
  const expiresAt = coin.expiresAt?.getTime()
  if (!expiresAt || !Number.isFinite(gap) || gap <= 0) return
  // Round up with a small clock-skew margin; the Operator remains authoritative.
  const retryAt = Math.ceil((expiresAt - gap) / 60000) * 60000 + 60000
  if (!Number.isSafeInteger(retryAt) || retryAt <= Date.now() || retryAt > expiresAt) return
  try {
    const waits = read(scope).filter((w) => w.txid !== coin.txid || w.vout !== coin.vout)
    waits.push({ txid: coin.txid, vout: coin.vout, expiresAt, retryAt, observedAt: Date.now() })
    localStorage.setItem(key(scope), JSON.stringify(waits.slice(-50)))
  } catch {
    /* A storage failure must not replace a definite payment outcome. */
  }
  return retryAt
}

export function chooseBitcoinInput(scope: string, coins: VirtualCoin[], amount: number): VirtualCoin | undefined {
  const waits = read(scope)
  const waitFor = (coin: VirtualCoin) =>
    waits.find((w) => w.txid === coin.txid && w.vout === coin.vout && w.expiresAt === coin.expiresAt?.getTime())
  const sufficient = coins.filter((coin) => coin.value > amount).sort((a, b) => b.value - a.value)
  const available = sufficient.find((coin) => !waitFor(coin))
  if (available) return available
  const blocked = sufficient.map(waitFor).filter((w): w is Wait => !!w)
  if (blocked.length) {
    const retryAt = Math.min(...blocked.map((w) => w.retryAt))
    throw bitcoinPaymentWait(retryAt)
  }
  return coins.filter((coin) => !waitFor(coin)).sort((a, b) => b.value - a.value)[0]
}
