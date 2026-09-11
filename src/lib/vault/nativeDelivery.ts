/**
 * Atomic native-delivery receipts for foreground OS notifications. Only
 * opaque payment-identity keys are stored; no payment or signing data enters
 * this ledger. This is a separate claim domain from the legacy banner
 * receipts (`vaulted-arrival-delivery-v1`): banner claims must never suppress
 * a native notice, and native claims never suppress a banner.
 *
 * At-most-once per device: the claim arbitrates tabs, and a crash between
 * claim and show can lose one notice. Activity remains the source of truth.
 */
export async function claimNativeDelivery(keys: readonly string[], factory: IDBFactory = indexedDB): Promise<string[]> {
  if (!keys.length) return []
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('vaulted-native-delivery-v1', 1)
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
      transaction.onabort = () => reject(transaction.error || new Error('Native delivery storage unavailable'))
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
