import type { PaymentScope } from './payments'

/**
 * Device-local arrival baseline, scoped to one network and vault. It records
 * every observed payment key with whether it already counted as available,
 * so a reload or a staged history hydration replays nothing: known keys
 * resume their state, genuinely new available keys banner once, and a first
 * observation with no stored baseline seeds quietly. Entries grant nothing;
 * they carry payment keys only, and clearing local data reseeds quietly from
 * whatever history loads first.
 */
const MAX_BASELINE_ENTRIES = 200

function baselineKey(scope: PaymentScope): string {
  return `vaulted:payment-arrivals:${scope.network || 'unknown'}:${scope.vaultId || 'unknown'}`
}

type BaselineStorage = Pick<Storage, 'getItem' | 'setItem'>

function activeStorage(overridden?: BaselineStorage): BaselineStorage | null {
  if (overridden) return overridden
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function loadArrivalBaseline(scope: PaymentScope, storage?: BaselineStorage): Map<string, boolean> {
  const active = activeStorage(storage)
  const baseline = new Map<string, boolean>()
  if (!active) return baseline
  try {
    const raw = active.getItem(baselineKey(scope))
    if (!raw) return baseline
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return baseline
    for (const entry of parsed.slice(0, MAX_BASELINE_ENTRIES)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') {
        baseline.set(entry[0], entry[1])
      }
    }
  } catch {
    // A lost baseline reseeds quietly; it never blocks history rendering.
  }
  return baseline
}

export function saveArrivalBaseline(
  scope: PaymentScope,
  seen: ReadonlyMap<string, boolean>,
  currentKeys?: ReadonlySet<string>,
  storage?: BaselineStorage,
): void {
  const active = activeStorage(storage)
  if (!active) return
  try {
    // Visible history always survives truncation: current keys sort first so
    // the cap can only evict rows that already left the history window, and
    // those re-seed from current history rather than replaying as arrivals.
    const entries = [...seen]
    if (currentKeys) {
      entries.sort((a, b) => Number(currentKeys.has(a[0])) - Number(currentKeys.has(b[0])))
    }
    active.setItem(baselineKey(scope), JSON.stringify(entries.slice(-MAX_BASELINE_ENTRIES)))
  } catch {
    // Baseline persistence is advisory deduplication. Losing it reseeds
    // quietly; it never affects payment processing or history rendering.
  }
}
