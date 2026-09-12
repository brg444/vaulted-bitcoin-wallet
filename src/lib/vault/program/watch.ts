import type { EsploraUtxo } from '../esplora'
import { familyKeysFor, type FamilyKey } from './constants'
import type { LedgerRecoveryDescriptor } from './ledgerRecoveryDescriptor'

const WATCH_SEEN_STORE = 'vaulted-ledger-recovery-watch-v1'

export type RecoveryWatchScope = Pick<LedgerRecoveryDescriptor, 'vaultId' | 'network'> & { descriptorHash: string }

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

function storeKey(scope: RecoveryWatchScope) {
  return `${WATCH_SEEN_STORE}:${scope.network}:${scope.vaultId}:${scope.descriptorHash}`
}

export function loadSeenOutpoints(scope: RecoveryWatchScope, storage: Storage = localStorage): Set<string> {
  const raw = storage.getItem(storeKey(scope))
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as string[]
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

export function saveSeenOutpoints(scope: RecoveryWatchScope, seen: Iterable<string>, storage: Storage = localStorage) {
  storage.setItem(storeKey(scope), JSON.stringify([...seen]))
}

export async function pollPendingInitiates(input: {
  descriptor: Pick<LedgerRecoveryDescriptor, 'keys' | 'pending'>
  fetchUtxos: (address: string, signal?: AbortSignal) => Promise<EsploraUtxo[]>
  seen: Set<string>
  signal?: AbortSignal
}): Promise<{ alerts: InitiateAlert[]; seen: Set<string> }> {
  const next = new Set(input.seen)
  const alerts: InitiateAlert[] = []
  const now = new Date().toISOString()
  for (const key of familyKeysFor(Boolean(input.descriptor.keys.recovery))) {
    input.signal?.throwIfAborted()
    const address = input.descriptor.pending[key].address
    const utxos = await input.fetchUtxos(address, input.signal)
    input.signal?.throwIfAborted()
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
