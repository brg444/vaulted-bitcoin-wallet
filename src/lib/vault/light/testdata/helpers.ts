import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { p256 } from '@noble/curves/nist.js'
import { LightScript, lightDescriptorDigest, type LightDescriptor } from '../contract'
import { wrapLightOwnerKey } from '../keyBackup'
import type { VaultStatusWire } from '../../types'
import type { LightEnrollment } from '../enrollment'
import { networkPins } from '../../networkPins'
import vectors from './contracts.json'

export const testOwner = hex.decode('00'.repeat(31) + '01')
export const testSecret = new Uint8Array(32).fill(7)
export const testPRF = new Uint8Array(32).fill(8)
export const testDescriptor = vectors[0].descriptor as LightDescriptor
export function lightTestStatus(descriptor: LightDescriptor = testDescriptor): VaultStatusWire {
  const p = descriptor.spendingPolicy
  const script = new LightScript(descriptor)
  return {
    enrolled: true,
    network: descriptor.network,
    clientOrigin: 'http://localhost:3003',
    rpId: 'localhost',
    vaultId: descriptor.vaultId,
    templateVersion: descriptor.profile,
    policyVersion: p.schema,
    protectionTier: 'light',
    vaultCosignerBasePub: `02${descriptor.cosignerPub}`,
    arkadeCosignerOrigin: '',
    arkadeCosignerVersion: '',
    savingsAddress: '',
    savingsScript: '',
    passkeyLoginAvailable: false,
    enrollmentMode: 'closed',
    periodAllowance: p.periodAllowanceSats,
    periodSpent: 0,
    periodRemaining: p.periodAllowanceSats,
    txCap: p.txRecipientCapSats,
    absoluteFeeCap: p.absoluteFeeCapSats,
    feerateCapSatVb: p.feerateCapSatPerV,
    spendingPolicy: p,
    spendingPolicyDigest: descriptor.spendingPolicyDigest,
    phoneBip340Pub: `02${descriptor.ownerPub}`,
    phoneDirectP256: hex.encode(p256.getPublicKey(testSecret, true)),
    vtxoVaultCosignerPub: `02${descriptor.cosignerPub}`,
    vtxoExitDelay: descriptor.exitDelaySeconds,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: new ArkAddress(
      hex.decode(descriptor.operatorPub),
      script.tweakedPublicKey,
      networkPins(descriptor.network).arkHrp,
    ).encode(),
    spendingArkScript: descriptor.scriptPubKey,
    vtxoDelegatePub: '',
    vtxoBoardingActive: false,
    vtxoBoardingProgram: '',
    vtxoBoardingAddress: '',
    vtxoBoardingScript: '',
    vtxoBoardingExitDelay: 0,
    vtxoBoardingExitDelayUnit: '',
    lightDescriptor: descriptor,
    lightDescriptorHash: lightDescriptorDigest(descriptor),
  }
}
export async function lightTestEnrollment(): Promise<LightEnrollment> {
  const lightKeyBackup = await wrapLightOwnerKey(testOwner, testPRF, 'passkey-prf', testDescriptor)
  const recoveryBackup = await wrapLightOwnerKey(testOwner, testSecret, 'recovery-secret', testDescriptor)
  return {
    descriptor: testDescriptor,
    enrollment: {
      vaultId: testDescriptor.vaultId,
      credId: '010203',
      webauthnP256: hex.encode(p256.getPublicKey(testPRF, true)),
      phoneDirectP256: hex.encode(p256.getPublicKey(testSecret, true)),
      phoneBip340Pub: `02${testDescriptor.ownerPub}`,
      nonce: lightKeyBackup.nonce,
      ciphertext: lightKeyBackup.ciphertext,
      lightKeyBackup,
    },
    recoveryBackup,
  }
}
