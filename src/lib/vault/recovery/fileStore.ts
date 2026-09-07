import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

/** Current and previous complete copies commit together; existing readers keep the same key. */
export async function recoveryFileStore<T>(key: string, next?: T): Promise<T | null> {
  return store(key, next, false)
}

/** Imported evidence is retained separately and never replaces the current local generation. */
export async function storeRecoveryImport<T>(key: string, file: T): Promise<T | null> {
  return store(key, file, true)
}

async function store<T>(key: string, next: T | undefined, importing: boolean): Promise<T | null> {
  const importKey = importing
    ? `import:${key}:${hex.encode(sha256(new TextEncoder().encode(JSON.stringify(next))))}`
    : null
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vaulted-complete-recovery', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction('files', next === undefined ? 'readonly' : 'readwrite')
      const files = tx.objectStore('files')
      let result: T | null = null
      let failure: unknown
      const request = files.get(key)
      request.onsuccess = () => {
        try {
          const previous = request.result as T | undefined
          result = previous ?? null
          if (next === undefined) return
          if (importKey) files.put(next, importKey)
          if (importing && previous !== undefined) return
          if (previous !== undefined) files.put(previous, `previous:${key}`)
          files.put(next, key)
          result = next
        } catch (error) {
          failure = error
          tx.abort()
        }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(failure ?? tx.error)
      tx.onabort = () => reject(failure ?? tx.error)
    })
  } finally {
    db.close()
  }
}
