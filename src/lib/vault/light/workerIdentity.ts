import { ReadonlySingleKey, type Identity } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { validateLightDescriptor, type LightDescriptor } from './contract'
import { vaultWalletNamespace } from '../vtxo/walletWorkerNames'

// Only public descriptor data crosses into the worker. Its signing methods
// fail closed; each payment unlocks an owner key in the foreground ceremony.
export function lightObserverIdentity(descriptor: LightDescriptor): Identity {
  const valid = validateLightDescriptor(descriptor)
  const identity = ReadonlySingleKey.fromPublicKey(hex.decode(`02${valid.ownerPub}`))
  const denied = (): never => {
    throw new Error('Light signing requires a foreground passkey approval')
  }
  return {
    compressedPublicKey: () => identity.compressedPublicKey(),
    xOnlyPublicKey: () => identity.xOnlyPublicKey(),
    signerSession: denied,
    sign: denied,
    signMessage: denied,
  }
}

function descriptorDatabase(namespace: string): Promise<IDBDatabase> {
  if (!/^[0-9a-f]{32}$/.test(namespace)) throw new Error('Invalid Light namespace')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`vaulted-light:${namespace}:identity`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('descriptor')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function storeLightWorkerDescriptor(descriptor: LightDescriptor) {
  const valid = validateLightDescriptor(descriptor)
  const db = await descriptorDatabase(vaultWalletNamespace(valid.vaultId))
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('descriptor', 'readwrite')
      tx.objectStore('descriptor').put(valid, 'active')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
export async function loadLightWorkerDescriptor(namespace: string): Promise<LightDescriptor | null> {
  const db = await descriptorDatabase(namespace)
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('descriptor').objectStore('descriptor').get('active')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        try {
          if (!request.result) {
            resolve(null)
            return
          }
          const d = validateLightDescriptor(request.result)
          if (vaultWalletNamespace(d.vaultId) !== namespace) throw new Error('Light worker identity mismatch')
          resolve(d)
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    db.close()
  }
}
