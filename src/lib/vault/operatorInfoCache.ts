import { RestArkProvider, type ArkInfo } from '@arkade-os/sdk'

/**
 * Short, bounded in-memory session cache for public Operator information.
 *
 * Only successful, validated reads are cached. Concurrent callers for the same
 * Operator origin share one in-flight read. Entries expire after a documented
 * TTL so live fee, expiry and signing validations that require fresh state can
 * still refresh; a failed read is never cached and retries on the next call.
 *
 * Scope is the Operator origin within a generation. A connection, network,
 * Operator or account change bumps the generation (or clears one origin), so a
 * late result from an old connection can never populate the new session.
 */
export const OPERATOR_INFO_TTL_MS = 30_000

interface CacheEntry {
  generation: number
  value: ArkInfo
  expiresAt: number
}

const entries = new Map<string, CacheEntry>()
const inflight = new Map<string, { generation: number; promise: Promise<ArkInfo> }>()
let generation = 0

export interface OperatorInfoReader {
  getInfo(): Promise<ArkInfo>
}

function readerFor(origin: string): OperatorInfoReader {
  return new RestArkProvider(origin)
}

export async function getOperatorInfo(
  origin: string,
  reader: OperatorInfoReader = readerFor(origin),
  now: number = Date.now(),
): Promise<ArkInfo> {
  const cached = entries.get(origin)
  if (cached && cached.generation === generation && cached.expiresAt > now) return cached.value
  const pending = inflight.get(origin)
  if (pending && pending.generation === generation) return pending.promise
  const startGeneration = generation
  const promise = reader.getInfo().then(
    (value) => {
      if (inflight.get(origin)?.promise === promise) inflight.delete(origin)
      if (startGeneration === generation) {
        entries.set(origin, { generation, value, expiresAt: Date.now() + OPERATOR_INFO_TTL_MS })
      }
      return value
    },
    (error) => {
      if (inflight.get(origin)?.promise === promise) inflight.delete(origin)
      throw error
    },
  )
  inflight.set(origin, { generation, promise })
  return promise
}

/** Invalidate one Operator origin, or the whole session on connection/account change. */
export function invalidateOperatorInfo(origin?: string): void {
  if (origin === undefined) {
    generation += 1
    entries.clear()
    inflight.clear()
    return
  }
  entries.delete(origin)
  inflight.delete(origin)
}

/** Test/qualification helper; the cache is otherwise private. */
export function operatorInfoCacheState(): { generation: number; entries: number; inflight: number } {
  return { generation, entries: entries.size, inflight: inflight.size }
}
