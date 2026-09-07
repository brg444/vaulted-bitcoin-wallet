import { createVtxoSpendUnlocker } from '../vtxo/spend'
import type { LightDescriptor } from './contract'
import { authorizeGuardianRenewals } from './guardianDelegation'

/** Reuses the reviewed payment's passkey ceremony; dispose still wipes both keys. */
export function guardianRenewalSpendUnlocker(d: LightDescriptor): typeof createVtxoSpendUnlocker {
  return (...args) => {
    const inner = createVtxoSpendUnlocker(...args)
    let checked = false
    return {
      async unlock() {
        const auth = await inner.unlock()
        if (!checked) {
          checked = true
          await authorizeGuardianRenewals(d, auth.phoneSecret)
        }
        return auth
      },
      dispose() {
        inner.dispose()
      },
    }
  }
}
