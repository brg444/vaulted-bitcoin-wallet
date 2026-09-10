import { p256 } from '@noble/curves/nist.js'
import { hex } from '@scure/base'
import { POLICY_VERSION } from '../../constants'
import { validateSpendingEnrollment } from '../../spendingEnrollment'
import type { VaultStatus } from '../../types'
import type { EnrollmentSecrets } from '../../tenantEnrollment'
import vector from './shared-spending-enrollment.json'

export const sharedSpendingDescriptor = validateSpendingEnrollment(vector.descriptor)
export function sharedSpendingStatus(): VaultStatus {
  const d = sharedSpendingDescriptor,
    b = d.boarding,
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
    vtxoBoardingDescriptorHash: vector.hash,
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
