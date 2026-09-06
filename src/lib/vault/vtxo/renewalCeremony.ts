import { RestIndexerProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import { networkPins } from '../networkPins'
import { LIGHT_PROFILE } from '../light/contract'
import { guardianRenewalContext } from './renewalContext'
import { authorizeSpendingRenewals } from './guardianRenewal'
import { createVtxoSpendUnlocker, type VtxoSpendPasskey } from './spend'
import { loadSpendingRenewals, saveSpendingRenewals } from './renewalStore'
import { spendingRenewalInfo, guardianDelegationTerminal } from './renewalClient'
import { browserVaultLockManager, requireVaultLockManager } from './lock'

async function recordFailure(status: VaultStatus, error: unknown) {
  try {
    await requireVaultLockManager(browserVaultLockManager()).request(
      `vaulted:renewal:${status.vaultId}`,
      { mode: 'exclusive' },
      async () => {
        const journal = await loadSpendingRenewals(status)
        journal.error = error instanceof Error ? error.message : 'Automatic renewal setup could not be completed'
        await saveSpendingRenewals(status, journal)
      },
    )
  } catch {
    /* Optional renewal failure must not undo a successful wallet unlock. */
  }
}

export async function renewFromLocalUnlock(
  status: VaultStatus,
  enrollment: EnrollmentSecrets,
  auth: VtxoSpendPasskey,
  canAuthorizeNew = true,
) {
  try {
    await authorizeSpendingRenewals(status, enrollment, auth, canAuthorizeNew)
  } catch (error) {
    await recordFailure(status, error)
  }
}

/** Fresh/connector restore has already consumed its login assertion; use a separate bounded ceremony. */
export async function setupSpendingRenewals(status: VaultStatus, enrollment: EnrollmentSecrets) {
  if (status.templateVersion === LIGHT_PROFILE) return
  try {
    const context = guardianRenewalContext(status)
    await spendingRenewalInfo(status)
    const { vtxos } = await new RestIndexerProvider(networkPins(status.network).operatorOrigin).getVtxos({
      scripts: [context.scriptPubKey],
      renewableOnly: true,
    })
    const journal = await loadSpendingRenewals(status)
    const needsAuthorization = vtxos.some(
      (coin) =>
        !coin.isSpent &&
        !coin.isSwept &&
        !coin.isUnrolled &&
        !coin.assets?.length &&
        coin.commitmentTxIds?.length &&
        coin.expiresAt &&
        coin.expiresAt.getTime() >= Date.now() + 300000 &&
        !Object.values(journal.operations).some((saved) => {
          const input = saved.plan || saved.status
          return (
            input?.txid === coin.txid &&
            input.vout === coin.vout &&
            (!saved.status || !guardianDelegationTerminal(saved.status.state) || saved.status.state === 'confirmed')
          )
        }),
    )
    if (!needsAuthorization) return
    const unlocker = createVtxoSpendUnlocker(enrollment, status, hex.encode(crypto.getRandomValues(new Uint8Array(32))))
    try {
      await authorizeSpendingRenewals(status, enrollment, await unlocker.unlock())
    } finally {
      unlocker.dispose()
    }
  } catch (error) {
    await recordFailure(status, error)
  }
}
