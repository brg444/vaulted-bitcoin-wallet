/** Atomically claim foreground announcements across tabs on this device.
 * Only opaque event keys are stored; no payment or signing data enters this ledger.
 */
export async function claimArrivalDelivery(
  keys: readonly string[],
  factory: IDBFactory = indexedDB,
): Promise<string[]> {
  if (!keys.length) return []
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('vaulted-arrival-delivery-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('delivered')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const transaction = db.transaction('delivered', 'readwrite')
      const store = transaction.objectStore('delivered')
      const accepted: string[] = []
      transaction.oncomplete = () => resolve(accepted)
      transaction.onabort = () => reject(transaction.error || new Error('Arrival delivery storage unavailable'))
      for (const key of new Set(keys)) {
        const request = store.get(key)
        request.onsuccess = () => {
          if (request.result === true) return
          store.put(true, key)
          accepted.push(key)
        }
      }
    })
  } finally {
    db.close()
  }
}
