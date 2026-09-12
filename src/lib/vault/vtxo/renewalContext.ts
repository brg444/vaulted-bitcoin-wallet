import { LEDGER_NATIVE_TEMPLATE } from '../program/ledgerNativeKeys'
import { SPENDING_ONLY_TEMPLATE } from '../spendingEnrollment'
import { renewalSigningJson } from './renewalJson'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../constants'
import { networkPins } from '../networkPins'
import { requireProtectionTierMatchesRecovery, type ProtectionTier } from '../protectionTier'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import type { VaultStatus } from '../types'
import { vaultPolicyV1ScriptFromStatus } from './spend'

export interface GuardianRenewalContext {
  program: SpendingPolicy['program']
  network: VaultNetwork
  vaultId: string
  protectionTier: ProtectionTier | 'light'
  ownerPub: string
  cosignerPub: string
  operatorPub: string
  scriptPubKey: string
  spendingPolicy: SpendingPolicy
}

/** The caller must first verify status against its saved enrollment/recovery pin. */
export function guardianRenewalContext(status: VaultStatus): GuardianRenewalContext {
  const network = requireSupportedVaultNetwork(status.network)
  // Existing Vault IDs are opaque enrolled strings, not descriptor hashes.
  if (
    typeof status.vaultId !== 'string' ||
    !status.vaultId ||
    status.vaultId !== status.vaultId.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  )
    throw new Error('Renewal vault identity is invalid')
  if (status.templateVersion !== SPENDING_ONLY_TEMPLATE && status.templateVersion !== LEDGER_NATIVE_TEMPLATE)
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
      new TextEncoder().encode(`vaulted-vtxo/renewal-context/v1:${renewalSigningJson(guardianRenewalContext(status))}`),
    ),
  )
}
