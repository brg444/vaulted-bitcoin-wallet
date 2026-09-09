import { parseRecoveryKit, type RecoveryKit } from './kit'

export const LOCAL_KIT_STORE = 'arkade-vault-v2:kit'

export function localKitStoreKey(vaultId: string): string {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  return `${LOCAL_KIT_STORE}:${id}`
}

export function saveLocalKit(kit: RecoveryKit, storage: Storage = localStorage): RecoveryKit {
  const built = parseRecoveryKit(kit)
  storage.setItem(localKitStoreKey(built.descriptor.vaultId), JSON.stringify(built))
  return built
}

export function loadLocalKit(vaultId: string, storage: Storage = localStorage): RecoveryKit | null {
  const raw = storage.getItem(localKitStoreKey(vaultId))
  if (!raw) return null
  return parseRecoveryKit(JSON.parse(raw))
}

export function findLocalKit(storage: Storage = localStorage): RecoveryKit | null {
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(`${LOCAL_KIT_STORE}:`)) continue
    const raw = storage.getItem(key)
    if (!raw) continue
    try {
      return parseRecoveryKit(JSON.parse(raw))
    } catch {
      continue
    }
  }
  return null
}

export function clearLocalKit(vaultId: string, storage: Storage = localStorage) {
  storage.removeItem(localKitStoreKey(vaultId))
}
