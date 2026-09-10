import { RetainedExitRepository } from '../recovery/retainedRepository'
import { requireSupportedVaultNetwork } from '../constants'
import { vaultWalletDatabase } from './walletWorkerNames'

/** Exit paths use the SDK's dedicated schema, separate from wallet balances. */
export function vaultExitRepository(vaultId: string, network: string) {
  return new RetainedExitRepository(
    `${vaultWalletDatabase(vaultId)}:${requireSupportedVaultNetwork(network)}:exit-paths`,
  )
}

export const vaultExitCapture = { mode: 'full' as const, minExitWorthSats: 0 }
