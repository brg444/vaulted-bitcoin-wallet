import { p256 } from '@noble/curves/nist.js'
import { hex } from '@scure/base'
import { ArkAddress, createBoardingProgramScript, getNetwork } from '@arkade-os/sdk'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { networkPins } from '../../networkPins'
import { VaultPolicyV1Script } from '../script'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../../spendingPolicy'
import { POLICY_VERSION } from '../../constants'
import {
  validateSpendingEnrollment,
  spendingEnrollmentHash,
  type SpendingEnrollmentDescriptor,
} from '../../spendingEnrollment'
import type { VaultStatus } from '../../types'
import type { EnrollmentSecrets } from '../../tenantEnrollment'
import vector from './shared-spending-enrollment.json'

export const sharedSpendingDescriptor = validateSpendingEnrollment(vector.descriptor)
export function sharedSpendingStatus(d = sharedSpendingDescriptor): VaultStatus {
  const b = d.boarding,
    p = d.spendingPolicy
  return {
    enrolled: true,
    network: d.network,
    vaultId: d.vaultId,
    clientOrigin: 'http://localhost:3000',
    rpId: 'localhost',
    templateVersion: d.template,
    policyVersion: POLICY_VERSION,
    protectionTier: 'light',
    savingsAddress: '',
    savingsScript: '',
    spendingDescriptor: d,
    phoneBip340Pub: d.phonePub,
    phoneDirectP256: d.phoneDirectP256,
    periodAllowance: p.periodAllowanceSats,
    periodRemaining: p.periodAllowanceSats,
    periodSpent: 0,
    txCap: p.txRecipientCapSats,
    absoluteFeeCap: p.absoluteFeeCapSats,
    feerateCapSatVb: p.feerateCapSatPerV,
    spendingPolicy: p,
    spendingPolicyDigest: d.spendingPolicyDigest,
    vtxoVaultCosignerPub: d.cosignerPub,
    vtxoDelegatePub: d.delegatePub,
    vtxoExitDelay: d.exitDelay,
    vtxoExitDelayUnit: d.exitDelayUnit,
    spendingArkAddress: d.address,
    spendingArkScript: d.script,
    vtxoBoardingActive: true,
    vtxoBoardingProgram: b.program,
    vtxoBoardingAddress: b.address,
    vtxoBoardingScript: b.script,
    vtxoBoardingExitDelay: b.exitDelay,
    vtxoBoardingExitDelayUnit: b.exitDelayUnit,
    vtxoBoardingDescriptor: b,
    vtxoBoardingDescriptorHash: spendingEnrollmentHash(d),
    passkeyLoginAvailable: true,
    enrollmentMode: 'open',
  }
}
// UI-only identity: these placeholder encrypted bytes never authorize payments.
export function sharedSpendingEnrollment(): EnrollmentSecrets {
  const d = sharedSpendingDescriptor
  return {
    vaultId: d.vaultId,
    credId: '010203',
    webauthnP256: hex.encode(p256.getPublicKey(new Uint8Array(32).fill(8), true)),
    phoneDirectP256: d.phoneDirectP256,
    phoneBip340Pub: d.phonePub,
    nonce: '00',
    ciphertext: '00',
  }
}

// Current enrollment variants for lifecycle tests; fixed cross-language expectations
// remain in shared-spending-enrollment.json and are never regenerated here.
export function sharedSpendingStatusForNetwork(
  network: 'mainnet' | 'mutinynet',
  options: { phoneSecret?: Uint8Array; cosignerSecret?: Uint8Array; directScalar?: Uint8Array; vaultId?: string } = {},
): VaultStatus {
  const d: SpendingEnrollmentDescriptor = structuredClone(sharedSpendingDescriptor)
  const pins = networkPins(network)
  Object.assign(d, {
    network,
    vaultId: options.vaultId ?? d.vaultId,
    phonePub: options.phoneSecret ? hex.encode(secp256k1.getPublicKey(options.phoneSecret, true)) : d.phonePub,
    cosignerPub: options.cosignerSecret
      ? hex.encode(secp256k1.getPublicKey(options.cosignerSecret, true))
      : d.cosignerPub,
    phoneDirectP256: options.directScalar
      ? hex.encode(p256.getPublicKey(options.directScalar, true))
      : d.phoneDirectP256,
    operatorPub: pins.operatorSignerPub,
    delegatePub: pins.delegatePub,
    exitDelay: pins.policyExitDelay,
    spendingPolicy: defaultSpendingPolicy(network),
  })
  d.spendingPolicyDigest = spendingPolicyDigest(d.spendingPolicy, network)
  const script = new VaultPolicyV1Script({
    network,
    userPub: hex.decode(d.phonePub.slice(2)),
    vtxoVaultCosignerPub: hex.decode(d.cosignerPub.slice(2)),
    arkdServerPub: hex.decode(d.operatorPub.slice(2)),
    delegatePub: hex.decode(d.delegatePub.slice(2)),
    exitDevicePub: hex.decode(d.phonePub.slice(2)),
    exitMode: 'device',
    exitDelay: BigInt(d.exitDelay),
    exitDelayUnit: 'seconds',
  })
  d.script = hex.encode(script.pkScript)
  d.address = new ArkAddress(script.params.arkdServerPub, script.tweakedPublicKey, pins.arkHrp).encode()
  Object.assign(d.boarding, {
    network,
    recoveryPhonePub: d.phonePub,
    operatorPub: pins.operatorSignerPub,
    exitDelay: pins.boardExitDelay,
  })
  const b = d.boarding
  const board = createBoardingProgramScript(
    {
      name: 'vault-board-v1',
      boardingPubKey: hex.decode(b.boardingPub.slice(2)),
      cosignerPubKey: hex.decode(b.vaultBoardCosignerPub.slice(2)),
      recoveryPubKey: hex.decode(b.recoveryPhonePub.slice(2)),
    },
    hex.decode(b.operatorPub.slice(2)),
    { type: 'seconds', value: BigInt(b.exitDelay) },
  )
  b.script = hex.encode(board.pkScript)
  b.address = board.onchainAddress(getNetwork(pins.sdkNetwork))
  return sharedSpendingStatus(validateSpendingEnrollment(d))
}
