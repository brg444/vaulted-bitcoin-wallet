import { IndexedDBVirtualTxRepository } from '@arkade-os/sdk'
import { validateLightDescriptor, type LightDescriptor } from './contract'

/** The SDK requires a dedicated DB; its exit-store schema differs from wallet state. */
export function lightExitRepository(descriptor: LightDescriptor) {
  const valid = validateLightDescriptor(descriptor)
  return new IndexedDBVirtualTxRepository(`vaulted-light:${valid.vaultId}:exit-paths`)
}
export const lightExitCapture = { mode: 'full' as const, minExitWorthSats: 0 }
