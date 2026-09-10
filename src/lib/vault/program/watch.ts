import type { EsploraUtxo } from '../esplora'
import { familyKeysFor, type FamilyKey } from './constants'
import type { VaultProgramDescriptor } from './descriptor'

export const WATCH_SEEN_STORE = 'arkade-vault-savings-v1-watch-seen-v1'

export interface InitiateAlert {
  familyKey: FamilyKey
  address: string
  txid: string
  vout: number
  value: number
  seenAt: string
}

export function outpointId(txid: string, vout: number): string {
  return `${txid.trim().toLowerCase()}:${vout}`
}

export function loadSeenOutpoints(vaultId: string, storage: Storage = localStorage): Set<string> {
  const id = vaultId.trim()
  if (!id) return new Set()
  const raw = storage.getItem(`${WATCH_SEEN_STORE}:${id}`)
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as string[]
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

export function saveSeenOutpoints(vaultId: string, seen: Iterable<string>, storage: Storage = localStorage) {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  storage.setItem(`${WATCH_SEEN_STORE}:${id}`, JSON.stringify([...seen]))
}

export async function pollPendingInitiates(input: {
  descriptor: Pick<VaultProgramDescriptor, 'keys' | 'pending'>
  fetchUtxos: (address: string) => Promise<EsploraUtxo[]>
  seen: Set<string>
}): Promise<{ alerts: InitiateAlert[]; seen: Set<string> }> {
  const next = new Set(input.seen)
  const alerts: InitiateAlert[] = []
  const now = new Date().toISOString()
  for (const key of familyKeysFor(Boolean(input.descriptor.keys.recovery))) {
    const address = input.descriptor.pending[key].address
    const utxos = await input.fetchUtxos(address)
    for (const coin of utxos) {
      const id = outpointId(coin.txid, coin.vout)
      if (next.has(id)) continue
      next.add(id)
      alerts.push({
        familyKey: key,
        address,
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        seenAt: now,
      })
    }
  }
  return { alerts, seen: next }
}

export function alertCopy(alert: InitiateAlert): string {
  const [, claimant] = alert.familyKey.split('-')
  const key = claimant === 'phone' ? 'this device' : claimant === 'hardware' ? 'hardware' : 'recovery'
  return `Someone started recovery on Savings with ${key}. If this wasn’t you, cancel it.`
}
