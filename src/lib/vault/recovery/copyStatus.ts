import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import type { ExitArchive } from './exitArchive'
import { publicExitArchive } from './portable'

export type RecoveryCopyKind = 'local' | 'service' | 'downloaded' | 'checked'
export type RecoveryCopies = Partial<Record<RecoveryCopyKind, { digest: string; at: string }>>
export const recoveryCopiesEvent = 'vaulted-recovery-copies'
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  return value
}
/** Saved Spending paths only; this identity establishes neither key access nor all-account coverage. */
export function recoveryPathDigest(archive: ExitArchive) {
  const data = { ...publicExitArchive(archive), capturedAt: undefined }
  return hex.encode(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(
          canonical({
            ...data,
            coins: (JSON.parse(data.coins) as { txid: string; vout: number }[]).sort((a, b) =>
              `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`),
            ),
            info: JSON.parse(data.info),
          }),
        ),
      ),
    ),
  )
}
const keyFor = (vaultId: string, network: string) => `${network}:${vaultId}`
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vaulted-recovery-copies', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('copies')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function readRecoveryCopies(vaultId: string, network: string): Promise<RecoveryCopies> {
  const database = await db()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('copies').objectStore('copies').get(keyFor(vaultId, network))
      request.onsuccess = () => resolve(request.result ?? {})
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}
export async function recordRecoveryCopy(
  vaultId: string,
  network: string,
  kind: RecoveryCopyKind,
  archive: ExitArchive,
) {
  const digest = recoveryPathDigest(archive),
    database = await db()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('copies', 'readwrite'),
        store = tx.objectStore('copies'),
        key = keyFor(vaultId, network)
      const get = store.get(key)
      get.onsuccess = () => {
        const copies: RecoveryCopies = get.result ?? {}
        copies[kind] = { digest, at: new Date().toISOString() }
        store.put(copies, key)
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error)
    })
  } finally {
    database.close()
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(recoveryCopiesEvent))
}
export function recoveryCopyDescription(copies: RecoveryCopies, kind: RecoveryCopyKind) {
  const copy = copies[kind]
  if (!copy) return kind === 'checked' ? 'No file checked on this device' : 'No recorded copy on this device'
  const date = new Date(copy.at).toLocaleString()
  if (kind === 'local') return `Saved ${date}`
  if (!copies.local) return `Recorded ${date}; current paths have not been checked`
  return copy.digest === copies.local.digest
    ? `Matches the locally saved Spending paths · ${date}`
    : `Differs from the locally saved Spending paths · ${date}`
}
