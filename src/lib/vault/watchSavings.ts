import { isVaultBitcoinAddress } from './bitcoin'
import type { VaultNetwork } from './constants'

export interface WatchedSavingsAddress {
  address: string
  network: VaultNetwork
  label: string
}
const PREFIX = 'vaulted:watch-savings:'
export function validateWatchedSavingsAddress(value: unknown, network: VaultNetwork): WatchedSavingsAddress {
  if (!value || typeof value !== 'object') throw new Error('Savings address required')
  const rec = value as WatchedSavingsAddress
  if (
    rec.network !== network ||
    typeof rec.address !== 'string' ||
    !isVaultBitcoinAddress(rec.address, network) ||
    rec.address !== rec.address.trim() ||
    typeof rec.label !== 'string' ||
    rec.label.length > 80
  )
    throw new Error('Enter a Bitcoin receiving address for this network')
  return { address: rec.address, network, label: rec.label.trim() || 'External savings' }
}
export function loadWatchedSavings(vaultId: string, network: VaultNetwork): WatchedSavingsAddress | null {
  const raw = localStorage.getItem(PREFIX + vaultId)
  return raw ? validateWatchedSavingsAddress(JSON.parse(raw), network) : null
}
export function saveWatchedSavings(vaultId: string, value: WatchedSavingsAddress, network: VaultNetwork) {
  const valid = validateWatchedSavingsAddress(value, network)
  localStorage.setItem(PREFIX + vaultId, JSON.stringify(valid))
  return valid
}
