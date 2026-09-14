import { discoverVaultLightningSolver } from './lightning'
import { getOperatorInfo, invalidateOperatorInfo } from './operatorInfoCache'
import { networkPins } from './networkPins'
import { ensureVaultWalletWorker } from './vtxo/walletWorker'
import type { VaultStatus } from './types'

/**
 * Read-only receive setup warmed when an enrolled Receive screen mounts:
 * wallet worker readiness, local solver discovery and the public Operator
 * information. No invoice, RFQ, signing, reservation or passkey is started,
 * and no long-lived Nostr transport is held (the transport stays per request).
 *
 * Repeated mounts for the same vault/network share one warming promise; a
 * failure clears the entry so the next mount or the explicit click retries.
 * Callers must attach a rejection handler; this function never rejects the
 * caller's mount path on its own.
 */
const warming = new Map<string, Promise<void>>()

function scopeKey(status: VaultStatus): string {
  return `${status.vaultId}:${status.network}`
}

export function prewarmLightningReceive(status: VaultStatus): Promise<void> {
  const key = scopeKey(status)
  const existing = warming.get(key)
  if (existing) return existing
  const pins = networkPins(status.network)
  const work = Promise.all([
    ensureVaultWalletWorker(status),
    discoverVaultLightningSolver(status.network),
    getOperatorInfo(pins.operatorOrigin),
  ]).then(() => undefined)
  warming.set(key, work)
  work.catch(() => {
    // Errors are never cached; clear the entry so the next mount or the
    // explicit click retries the failed read.
    if (warming.get(key) === work) warming.delete(key)
  })
  return work
}

/** Drop warm state on lock, account switch or disconnect. */
export function forgetLightningReceivePrewarm(status?: VaultStatus): void {
  if (!status) {
    warming.clear()
    invalidateOperatorInfo()
    return
  }
  const key = scopeKey(status)
  warming.delete(key)
  invalidateOperatorInfo(networkPins(status.network).operatorOrigin)
}

/** Test/qualification helper. */
export function lightningReceivePrewarmState(): { warming: number } {
  return { warming: warming.size }
}
