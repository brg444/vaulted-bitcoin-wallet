import {
  captureExitArchive,
  exitArchiveProviders,
  validateExitArchive,
  normalizeRecoveryChain,
  type ExitArchive,
} from '../recovery/exitArchive'
import { lightExitRepository } from './exitRepository'
import { lightDescriptorDigest, validateLightDescriptor, type LightDescriptor } from './contract'

export type LightRecoveryArchive = ExitArchive
export const normalizeLightRecoveryChain = normalizeRecoveryChain
function binding(descriptor: LightDescriptor) {
  const d = validateLightDescriptor(descriptor)
  return { ...d, descriptorHash: lightDescriptorDigest(d) }
}
export function validateLightRecoveryArchive(value: LightRecoveryArchive, d: LightDescriptor) {
  return validateExitArchive(value, binding(d))
}

function database(d: LightDescriptor): Promise<IDBDatabase> {
  validateLightDescriptor(d)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`vaulted-light:${d.vaultId}:recovery`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('archive')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function loadLightRecoveryArchive(d: LightDescriptor): Promise<LightRecoveryArchive | null> {
  const db = await database(d)
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('archive').objectStore('archive').get('current')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        try {
          resolve(request.result ? validateLightRecoveryArchive(request.result, d).archive : null)
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    db.close()
  }
}
export async function storeLightRecoveryArchive(archive: LightRecoveryArchive, d: LightDescriptor) {
  validateLightRecoveryArchive(archive, d)
  const db = await database(d)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('archive', 'readwrite')
      tx.objectStore('archive').put(archive, 'current')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
const activeCaptures = new Map<string, Promise<LightRecoveryArchive>>()
export function captureLightRecoveryArchive(
  d: LightDescriptor,
  expected?: { txid: string; vout: number; value: number; script: string }[],
): Promise<LightRecoveryArchive> {
  validateLightDescriptor(d)
  const hash = lightDescriptorDigest(d)
  const active = activeCaptures.get(hash)
  if (active)
    return active.then((archive) => {
      assertLightArchiveMatchesVtxos(archive, d, expected)
      return archive
    })
  const run = () => capture(d, expected)
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const pending = (async () =>
    locks ? await locks.request(`vaulted-light:recovery:${d.vaultId}`, run) : await run())().finally(() =>
    activeCaptures.delete(hash),
  )
  activeCaptures.set(hash, pending)
  return pending
}
async function capture(
  d: LightDescriptor,
  expected?: { txid: string; vout: number; value: number; script: string }[],
): Promise<LightRecoveryArchive> {
  const repository = lightExitRepository(d)
  try {
    const archive = await captureExitArchive(
      binding(d),
      repository,
      await loadLightRecoveryArchive(d).catch(() => null),
    )
    assertLightArchiveMatchesVtxos(archive, d, expected)
    await storeLightRecoveryArchive(archive, d)
    return archive
  } finally {
    await repository[Symbol.asyncDispose]()
  }
}

export function lightArchiveProviders(archive: LightRecoveryArchive, d: LightDescriptor) {
  return exitArchiveProviders(archive, binding(d))
}

/** Match outpoints as well as value: an equal-balance payment still changes its exit path. */
export function assertLightArchiveMatchesVtxos(
  archive: LightRecoveryArchive,
  d: LightDescriptor,
  expected?: { txid: string; vout: number; value: number; script: string }[],
) {
  if (!expected) return
  const { coins } = validateLightRecoveryArchive(archive, d)
  const fingerprint = (values: { txid: string; vout: number; value: number; script: string }[]) =>
    values
      .map((v) => `${v.txid}:${v.vout}:${v.value}:${v.script}`)
      .sort()
      .join('|')
  if (fingerprint(expected) !== fingerprint(coins))
    throw new Error('Transaction paths are catching up with your wallet. The previous backup is retained.')
}
