import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../constants'
import { LIGHT_PROFILE, LIGHT_PROGRAM, validateLightPolicy, type LightPolicy } from '../light/contract'
import { requireLightStatus } from '../light/status'
import { networkPins } from '../networkPins'
import { CONNECTOR_TEMPLATE } from '../program/connector'
import { isSavingsTemplate } from '../program/constants'
import { requireProtectionTierMatchesRecovery, type ProtectionTier } from '../protectionTier'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import type { VaultStatus } from '../types'
import { vaultPolicyV1ScriptFromStatus } from './spend'

export interface GuardianRenewalContext {
  program: SpendingPolicy['program'] | typeof LIGHT_PROGRAM
  network: VaultNetwork
  vaultId: string
  protectionTier: ProtectionTier | 'light'
  ownerPub: string
  cosignerPub: string
  operatorPub: string
  scriptPubKey: string
  spendingPolicy: SpendingPolicy | LightPolicy
}

/** The caller must first verify status against its saved enrollment/recovery pin. */
export function guardianRenewalContext(status: VaultStatus): GuardianRenewalContext {
  const network = requireSupportedVaultNetwork(status.network)
  // Enrollment uses 16-byte opaque IDs; existing 32-byte IDs remain valid.
  // Light's descriptor validator below retains its separate 32-byte requirement.
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(status.vaultId)) throw new Error('Renewal vault identity is invalid')
  if (status.templateVersion === LIGHT_PROFILE) {
    const d = requireLightStatus(status).lightDescriptor!
    return {
      program: LIGHT_PROGRAM,
      network,
      vaultId: d.vaultId,
      protectionTier: 'light',
      ownerPub: d.ownerPub,
      cosignerPub: d.cosignerPub,
      operatorPub: d.operatorPub,
      scriptPubKey: d.scriptPubKey,
      spendingPolicy: validateLightPolicy(d.spendingPolicy, network),
    }
  }
  if (!isSavingsTemplate(status.templateVersion) && status.templateVersion !== CONNECTOR_TEMPLATE)
    throw new Error('Unsupported renewal program')
  const protectionTier = requireProtectionTierMatchesRecovery(
    status.protectionTier,
    status.recoveryKeyPub || status.recoveryPub,
  )
  const script = vaultPolicyV1ScriptFromStatus(status)
  const spendingPolicy = validateSpendingPolicy(status.spendingPolicy, network)
  if (
    spendingPolicyDigest(spendingPolicy, network) !== status.spendingPolicyDigest ||
    spendingPolicy.periodAllowanceSats !== status.periodAllowance ||
    spendingPolicy.txRecipientCapSats !== status.txCap ||
    spendingPolicy.absoluteFeeCapSats !== status.absoluteFeeCap ||
    spendingPolicy.feerateCapSatPerV !== status.feerateCapSatVb
  )
    throw new Error('Renewal Spending policy changed')
  const operatorPub = hex.encode(script.params.arkdServerPub)
  if (operatorPub !== networkPins(network).operatorSignerPub.slice(2)) throw new Error('Renewal Operator key changed')
  return {
    program: spendingPolicy.program,
    network,
    vaultId: status.vaultId,
    protectionTier,
    ownerPub: hex.encode(script.params.userPub),
    cosignerPub: hex.encode(script.params.vtxoVaultCosignerPub),
    operatorPub,
    scriptPubKey: hex.encode(script.pkScript),
    spendingPolicy,
  }
}

/** Reconstruct before hashing; never hash a capability response as wallet authority. */
export function guardianRenewalContextDigest(status: VaultStatus): string {
  return hex.encode(
    sha256(
      new TextEncoder().encode(`vaulted-vtxo/renewal-context/v1:${JSON.stringify(guardianRenewalContext(status))}`),
    ),
  )
}
