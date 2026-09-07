import { validateExitArchive, type ExitArchive, type ExitArchiveBinding } from './exitArchive'

export type RecoveryOutput = { txid: string; vout: number; value: number; script: string }
export type SpendingCoverage = {
  scope: 'spending-paths'
  state: 'missing' | 'invalid' | 'unknown' | 'incomplete' | 'current'
  capturedAt: string | null
  archivedSats: number
  coveredSats: number | null
  missing: string[]
  mismatched: string[]
  stale: string[]
}
const point = (coin: RecoveryOutput) => `${coin.txid}:${coin.vout}`

/** Structural coverage of a supplied output set, not proof of current Bitcoin eligibility. */
export function spendingRecoveryCoverage(
  archive: ExitArchive | null,
  binding: ExitArchiveBinding,
  expected: readonly RecoveryOutput[] | null,
): SpendingCoverage {
  const known = new Map<string, RecoveryOutput>()
  if (expected !== null) {
    if (expected.length > 512) throw new Error('Recovery output limit exceeded')
    for (const coin of expected) {
      if (
        !/^[0-9a-f]{64}$/.test(coin.txid) ||
        !Number.isSafeInteger(coin.vout) ||
        coin.vout < 0 ||
        coin.vout > 0xffffffff ||
        !Number.isSafeInteger(coin.value) ||
        coin.value <= 0 ||
        coin.value > 21e14 ||
        coin.script !== binding.scriptPubKey
      )
        throw new Error('Known recovery output does not match this wallet')
      const prior = known.get(point(coin))
      if (prior && prior.value !== coin.value) throw new Error('Known recovery outputs disagree')
      known.set(point(coin), coin)
    }
  }
  const result: SpendingCoverage = {
    scope: 'spending-paths',
    state: 'missing',
    capturedAt: null,
    archivedSats: 0,
    coveredSats: expected === null ? null : 0,
    missing: [...known.keys()].sort(),
    mismatched: [],
    stale: [],
  }
  if (!archive) return result
  let saved: RecoveryOutput[]
  try {
    saved = validateExitArchive(archive, binding).coins
  } catch {
    return { ...result, state: 'invalid' }
  }
  result.capturedAt = archive.capturedAt
  result.archivedSats = saved.reduce((total, coin) => total + coin.value, 0)
  if (expected === null) return { ...result, state: 'unknown' }
  const byPoint = new Map(saved.map((coin) => [point(coin), coin]))
  result.missing = []
  for (const [id, coin] of known) {
    const match = byPoint.get(id)
    if (!match) result.missing.push(id)
    else if (match.value !== coin.value || match.script !== coin.script) result.mismatched.push(id)
    else result.coveredSats! += coin.value
  }
  result.stale = saved
    .filter((coin) => !known.has(point(coin)))
    .map(point)
    .sort()
  result.missing.sort()
  result.mismatched.sort()
  result.state = result.missing.length || result.mismatched.length || result.stale.length ? 'incomplete' : 'current'
  return result
}

export function requireSpendingRecoveryCoverage(
  archive: ExitArchive,
  binding: ExitArchiveBinding,
  expected: readonly RecoveryOutput[],
) {
  if (spendingRecoveryCoverage(archive, binding, expected).state !== 'current')
    throw new Error('Transaction paths are catching up with your wallet. The previous backup is retained.')
}
