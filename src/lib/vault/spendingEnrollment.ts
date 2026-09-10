import { ArkAddress } from '@arkade-os/sdk'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { requireSupportedVaultNetwork, type VaultNetwork } from './constants'
import { networkPins } from './networkPins'
import { validateSpendingPolicy, spendingPolicyDigest, type SpendingPolicy } from './spendingPolicy'
import { requireBoardingDescriptor, requireBoardingStatus } from './vtxo/board'
import { VaultPolicyV1Script } from './vtxo/script'
import type { VaultStatus, BoardingDescriptor } from './types'

export const SPENDING_ONLY_TEMPLATE = 'vaulted-spending-v1' as const
export const SPENDING_ENROLLMENT_SCHEMA = 'arkade-vault/spending-enrollment-v1' as const
export interface SpendingEnrollmentDescriptor {
  schema: typeof SPENDING_ENROLLMENT_SCHEMA
  template: typeof SPENDING_ONLY_TEMPLATE
  vaultId: string
  network: VaultNetwork
  protectionTier: 'light'
  phonePub: string
  phoneDirectP256: string
  cosignerPub: string
  operatorPub: string
  delegatePub: string
  exitMode: 'device'
  exitDelay: number
  exitDelayUnit: 'seconds'
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
  script: string
  address: string
  boarding: BoardingDescriptor
}

function publicKey(value: unknown, curve: typeof secp256k1 | typeof p256 = secp256k1): string {
  if (
    typeof value !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(value) ||
    !curve.utils.isValidPublicKey(hex.decode(value))
  ) {
    throw new Error('Spending enrollment requires canonical compressed public keys')
  }
  return value
}

function exactKeys(input: object, canonical: object) {
  if (
    Object.keys(input).length !== Object.keys(canonical).length ||
    Object.keys(canonical).some((key) => !Object.hasOwn(input, key))
  ) {
    throw new Error('Spending enrollment contains unsupported fields')
  }
}

export function validateSpendingEnrollment(value: unknown): SpendingEnrollmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Spending enrollment descriptor required')
  const d = value as SpendingEnrollmentDescriptor
  const network = requireSupportedVaultNetwork(d.network)
  const pins = networkPins(network)
  if (
    d.schema !== SPENDING_ENROLLMENT_SCHEMA ||
    d.template !== SPENDING_ONLY_TEMPLATE ||
    d.protectionTier !== 'light' ||
    d.exitMode !== 'device' ||
    d.exitDelayUnit !== 'seconds' ||
    d.exitDelay !== pins.policyExitDelay ||
    !/^[0-9a-f]{32}$/.test(d.vaultId)
  ) {
    throw new Error('Spending enrollment configuration does not match this release')
  }
  const phonePub = publicKey(d.phonePub),
    phoneDirectP256 = publicKey(d.phoneDirectP256, p256)
  const cosignerPub = publicKey(d.cosignerPub),
    operatorPub = publicKey(d.operatorPub),
    delegatePub = publicKey(d.delegatePub)
  if (
    operatorPub !== pins.operatorSignerPub ||
    delegatePub !== pins.delegatePub ||
    new Set([phonePub, cosignerPub, operatorPub, delegatePub].map((key) => key.slice(2))).size !== 4
  ) {
    throw new Error('Spending enrollment signer configuration changed')
  }
  const policy = validateSpendingPolicy(d.spendingPolicy, network)
  const digest = spendingPolicyDigest(policy, network)
  if (d.spendingPolicyDigest !== digest) throw new Error('Spending enrollment policy digest changed')
  const script = new VaultPolicyV1Script({
    userPub: hex.decode(phonePub.slice(2)),
    vtxoVaultCosignerPub: hex.decode(cosignerPub.slice(2)),
    arkdServerPub: hex.decode(operatorPub.slice(2)),
    delegatePub: hex.decode(delegatePub.slice(2)),
    exitDevicePub: hex.decode(phonePub.slice(2)),
    exitMode: 'device',
    network,
    exitDelay: BigInt(d.exitDelay),
    exitDelayUnit: 'seconds',
  })
  const address = new ArkAddress(hex.decode(operatorPub.slice(2)), script.tweakedPublicKey, pins.arkHrp).encode()
  if (hex.encode(script.pkScript) !== d.script || address !== d.address)
    throw new Error('Spending enrollment script or address changed')
  const b = requireBoardingDescriptor(d.boarding, {
    vaultId: d.vaultId,
    network,
    phonePub,
    boardingPub: d.boarding?.boardingPub,
  })
  const boarding: BoardingDescriptor = {
    schema: b.schema,
    program: b.program,
    template: b.template,
    network: b.network,
    boardingPub: b.boardingPub,
    recoveryPhonePub: b.recoveryPhonePub,
    vaultBoardCosignerPub: b.vaultBoardCosignerPub,
    operatorPub: b.operatorPub,
    exitDelay: b.exitDelay,
    exitDelayUnit: b.exitDelayUnit,
    script: b.script,
    address: b.address,
  }
  exactKeys(b, boarding)
  // Field order is the canonical Go enrollment descriptor order.
  const canonical: SpendingEnrollmentDescriptor = {
    schema: d.schema,
    template: d.template,
    vaultId: d.vaultId,
    network,
    protectionTier: 'light',
    phonePub,
    phoneDirectP256,
    cosignerPub,
    operatorPub,
    delegatePub,
    exitMode: 'device',
    exitDelay: d.exitDelay,
    exitDelayUnit: 'seconds',
    spendingPolicy: policy,
    spendingPolicyDigest: digest,
    script: d.script,
    address,
    boarding,
  }
  exactKeys(d, canonical)
  return canonical
}

export function spendingEnrollmentHash(value: unknown): string {
  return hex.encode(sha256(new TextEncoder().encode(JSON.stringify(validateSpendingEnrollment(value)))))
}

export function requireSpendingEnrollmentStatus(status: VaultStatus): SpendingEnrollmentDescriptor {
  const d = validateSpendingEnrollment(status.spendingDescriptor)
  if (
    !status.enrolled ||
    status.templateVersion !== d.template ||
    status.protectionTier !== d.protectionTier ||
    status.vaultId !== d.vaultId ||
    status.network !== d.network ||
    status.phoneBip340Pub !== d.phonePub ||
    status.phoneDirectP256 !== d.phoneDirectP256 ||
    status.vtxoVaultCosignerPub !== d.cosignerPub ||
    status.vtxoDelegatePub !== d.delegatePub ||
    status.spendingArkScript !== d.script ||
    status.spendingArkAddress !== d.address ||
    status.spendingPolicyDigest !== d.spendingPolicyDigest ||
    spendingPolicyDigest(validateSpendingPolicy(status.spendingPolicy, d.network), d.network) !==
      d.spendingPolicyDigest ||
    status.externalOwnerWalletPub ||
    status.recoveryKeyPub ||
    status.recoveryPub ||
    status.savingsAddress ||
    status.savingsScript ||
    status.vtxoExitDelay !== d.exitDelay ||
    status.vtxoExitDelayUnit !== d.exitDelayUnit ||
    status.vtxoBoardingDescriptorHash !== spendingEnrollmentHash(d)
  ) {
    throw new Error('Spending status does not match its enrollment')
  }
  requireBoardingStatus(status, d.boarding.boardingPub)
  return d
}
