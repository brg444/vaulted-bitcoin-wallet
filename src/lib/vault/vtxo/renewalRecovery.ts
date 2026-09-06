import type { ArkInfo, IndexerProvider, VirtualCoin } from '@arkade-os/sdk'
import type { VaultStatus } from '../types'
import { LIGHT_PROFILE } from '../light/contract'
import { lightExitRepository } from '../light/exitRepository'
import { requireLightStatus } from '../light/status'
import { requireDelegationInputAncestryForBinding } from '../light/delegationEligibility'
import { importDelegationReplacementForBinding } from '../light/delegationRecovery'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'
import { vaultExitRepository } from './exitRepository'
import type { SpendingRenewalStatus } from './renewalClient'

function repository(status: VaultStatus) {
  return status.templateVersion === LIGHT_PROFILE
    ? lightExitRepository(requireLightStatus(status).lightDescriptor!)
    : vaultExitRepository(status.vaultId, status.network)
}
function binding(status: VaultStatus) {
  const context = guardianRenewalContext(status)
  return {
    ...context,
    descriptorHash: guardianRenewalContextDigest(status),
    absoluteFeeCapSats: context.spendingPolicy.absoluteFeeCapSats,
  }
}
export function requireSpendingRenewalAncestry(
  status: VaultStatus,
  coin: VirtualCoin,
  info: ArkInfo,
  indexer: IndexerProvider,
) {
  return requireDelegationInputAncestryForBinding(binding(status), coin, info, indexer, () => repository(status))
}
export function importSpendingRenewalReplacement(
  status: VaultStatus,
  result: SpendingRenewalStatus,
  info: ArkInfo,
  coin: VirtualCoin,
) {
  return importDelegationReplacementForBinding(binding(status), result, info, coin, () => repository(status))
}
