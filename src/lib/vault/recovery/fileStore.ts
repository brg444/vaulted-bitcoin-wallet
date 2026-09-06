/** Local complete snapshots; write only after every program archive has validated. */
export async function recoveryFileStore<T>(key: string, next?: T): Promise<T | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vaulted-complete-recovery', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction('files', next === undefined ? 'readonly' : 'readwrite')
      let result: T | null = null
      if (next === undefined) {
        const request = tx.objectStore('files').get(key)
        request.onsuccess = () => {
          result = request.result ?? null
        }
      } else {
        tx.objectStore('files').put(next, key)
        result = next
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
