import type { RfqSwapRecord } from '@arkade-os/swap'
import { vaultAccountRuntime } from './accountRuntime'
import { subscribeVaultWalletEvents, withVaultWalletState } from './vtxo/walletWorker'
import type { VaultStatus } from './types'

export interface LightningReceiveSnapshot {
  record?: RfqSwapRecord
  error: string
}

/** Read the saved invoice while the account owner performs reconciliation. */
export function observeVaultLightningReceive(
  status: VaultStatus,
  rfqId: string,
  publish: (snapshot: LightningReceiveSnapshot) => void,
): () => void {
  const account = vaultAccountRuntime(status)
  let stopped = false
  let reading = false
  let dirty = false
  const active = () => !stopped && !account.disposed
  const read = async () => {
    if (!active()) return
    if (reading) {
      dirty = true
      return
    }
    reading = true
    dirty = false
    try {
      const snapshot = await withVaultWalletState(status, async ({ swapRepository, lightningReceiveError }) => ({
        record: await swapRepository.getRfqSwap(rfqId),
        error: lightningReceiveError,
      }))
      if (active()) publish(snapshot)
    } catch (error) {
      if (active())
        publish({
          error: error instanceof Error ? error.message : 'Waiting for payment status. Keep this wallet open.',
        })
    } finally {
      reading = false
      if (dirty && active()) void read()
    }
  }
  const releaseCadence = account.maintenance.requestCadence('lightning-observer', 5000)
  const unsubscribe = subscribeVaultWalletEvents(status, () => void read())
  void read()
  return () => {
    stopped = true
    unsubscribe()
    releaseCadence()
  }
}
