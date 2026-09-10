import type { VaultHistoryItem } from './history'

export const BALANCE_STORE = 'arkade-vault-v2:balance-snapshot'

export type StoredBalanceSnapshot = {
  boardingBalance: number
  boardingError?: string
  history: VaultHistoryItem[]
  savingsSats: number
  savingsSpendableSats: number
  vtxoSpendingSats: number
  vtxoPendingSats?: number
}

export function balanceStoreKey(vaultId: string): string {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  return `${BALANCE_STORE}:${id}`
}

function isFiniteSats(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseSnapshot(raw: string | null): StoredBalanceSnapshot | null {
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as StoredBalanceSnapshot
    if (
      !isFiniteSats(rec.boardingBalance) ||
      (rec.boardingError !== undefined && typeof rec.boardingError !== 'string') ||
      !isFiniteSats(rec.savingsSats) ||
      !isFiniteSats(rec.savingsSpendableSats) ||
      !isFiniteSats(rec.vtxoSpendingSats) ||
      (rec.vtxoPendingSats !== undefined && !isFiniteSats(rec.vtxoPendingSats)) ||
      !Array.isArray(rec.history)
    ) {
      return null
    }
    return rec
  } catch {
    return null
  }
}

export function loadBalanceSnapshot(vaultId: string, storage: Storage = localStorage): StoredBalanceSnapshot | null {
  const id = vaultId.trim()
  if (!id) return null
  try {
    return parseSnapshot(storage.getItem(balanceStoreKey(id)))
  } catch {
    return null
  }
}

export function saveBalanceSnapshot(
  vaultId: string,
  snapshot: StoredBalanceSnapshot,
  storage: Storage = localStorage,
): void {
  const id = vaultId.trim()
  if (!id) return
  try {
    storage.setItem(balanceStoreKey(id), JSON.stringify(snapshot))
  } catch {
    // Private or embedded browsers may refuse durable writes.
  }
}
