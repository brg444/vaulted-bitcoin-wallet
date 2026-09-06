import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { VaultStatus, VaultStatusWire } from '../types'
import { networkPins } from '../networkPins'
import {
  LIGHT_PROFILE,
  LIGHT_POLICY_SCHEMA,
  lightDescriptorDigest,
  lightPolicyDigest,
  validateLightDescriptor,
  validateLightPolicy,
  LightScript,
} from './contract'

/** Verify every advertised signing, address and allowance fact against the named descriptor. */
export function requireLightStatus(status: VaultStatusWire | VaultStatus): VaultStatus {
  const descriptor = validateLightDescriptor(status.lightDescriptor)
  const pins = networkPins(descriptor.network)
  if (
    !status.enrolled ||
    status.vaultId !== descriptor.vaultId ||
    status.network !== descriptor.network ||
    status.templateVersion !== LIGHT_PROFILE ||
    status.policyVersion !== LIGHT_POLICY_SCHEMA ||
    status.protectionTier !== 'light'
  )
    throw new Error('Light status identity mismatch')
  if (status.lightDescriptorHash !== lightDescriptorDigest(descriptor))
    throw new Error('Light descriptor digest mismatch')
  const policy = validateLightPolicy(status.spendingPolicy, descriptor.network)
  if (
    lightPolicyDigest(policy, descriptor.network) !== descriptor.spendingPolicyDigest ||
    status.spendingPolicyDigest !== descriptor.spendingPolicyDigest
  )
    throw new Error('Light policy mismatch')
  if (
    policy.txRecipientCapSats !== status.txCap ||
    policy.periodAllowanceSats !== status.periodAllowance ||
    policy.absoluteFeeCapSats !== status.absoluteFeeCap ||
    policy.feerateCapSatPerV !== status.feerateCapSatVb
  )
    throw new Error('Light limit fields mismatch')
  if (
    ![status.periodSpent, status.periodRemaining].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    status.periodRemaining !== Math.max(0, status.periodAllowance - status.periodSpent)
  )
    throw new Error('Light allowance state invalid')
  if (
    status.savingsAddress ||
    status.savingsScript ||
    status.externalOwnerWalletPub ||
    status.recoveryKeyPub ||
    ('recoveryPub' in status && status.recoveryPub) ||
    status.arkadeCosignerBasePub ||
    status.arkadeCosignerOrigin ||
    status.arkadeCosignerVersion ||
    status.vtxoDelegatePub ||
    status.vtxoBoardingActive ||
    status.vtxoBoardingAddress ||
    status.vtxoBoardingScript ||
    status.vtxoBoardingDescriptor
  )
    throw new Error('Light status contains another profile')
  if (
    status.phoneBip340Pub !== `02${descriptor.ownerPub}` ||
    status.vtxoVaultCosignerPub !== `02${descriptor.cosignerPub}` ||
    status.vaultCosignerBasePub !== status.vtxoVaultCosignerPub ||
    status.vtxoExitDelay !== descriptor.exitDelaySeconds ||
    status.vtxoExitDelayUnit !== 'seconds'
  )
    throw new Error('Light signing keys or exit delay mismatch')
  const address = ArkAddress.decode(String(status.spendingArkAddress || ''))
  const script = new LightScript(descriptor)
  if (
    address.hrp !== pins.arkHrp ||
    hex.encode(address.serverPubKey) !== descriptor.operatorPub ||
    hex.encode(address.pkScript) !== descriptor.scriptPubKey ||
    hex.encode(script.pkScript) !== status.spendingArkScript
  )
    throw new Error('Light receiving address mismatch')
  return { ...status, savingsScript: '', lightDescriptor: descriptor } as VaultStatus
}

export function lightStatusMatchesDescriptor(status: VaultStatus, expected: unknown) {
  const valid = requireLightStatus(status)
  if (lightDescriptorDigest(validateLightDescriptor(expected)) !== valid.lightDescriptorHash)
    throw new Error('Light identity changed from its saved descriptor')
  return valid
}
