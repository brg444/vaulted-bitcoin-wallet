import type { LightDescriptor, LightPolicy } from './light/contract'
import type { VaultNetwork } from './constants'
import type { SpendingPolicy } from './spendingPolicy'
import type { ProtectionTier } from './protectionTier'

// Exact JSON object emitted by GET /v1/status?vault=... . Keep normalized
// compatibility aliases out of this type; they belong to VaultStatus below.
export interface VaultStatusWire {
  lightDescriptor?: LightDescriptor
  lightDescriptorHash?: string
  enrolled: boolean
  network: string
  clientOrigin: string
  rpId: string
  vaultId: string
  templateVersion: string
  policyVersion: string
  protectionTier: ProtectionTier | 'light'
  externalOwnerWalletPub?: string
  recoveryKeyPub?: string
  vaultCosignerBasePub?: string
  arkadeCosignerBasePub?: string
  arkadeCosignerOrigin: string
  arkadeCosignerVersion: string
  savingsAddress: string
  savingsScript?: string
  passkeyLoginAvailable: boolean
  enrollmentMode: string
  enrollmentExpiresAt?: string
  periodAllowance: number
  periodSpent: number
  periodRemaining: number
  txCap: number
  absoluteFeeCap: number
  feerateCapSatVb: number
  spendingPolicy: SpendingPolicy | LightPolicy
  spendingPolicyDigest: string
  phoneBip340Pub?: string
  phoneDirectP256?: string
  warnings?: string[]
  vtxoVaultCosignerPub: string
  vtxoExitDelay: number
  vtxoExitDelayUnit: string
  spendingArkAddress: string
  spendingArkScript: string
  vtxoDelegatePub: string
  vtxoBoardingActive: boolean
  vtxoBoardingProgram: string
  vtxoBoardingAddress: string
  vtxoBoardingScript: string
  vtxoBoardingExitDelay: number
  vtxoBoardingExitDelayUnit: string
  // Enrollment-bound facts used to reconstruct the worker wallet in a fresh
  // browser without trusting mutable client configuration.
  vtxoBoardingDescriptor?: BoardingDescriptor
  vtxoBoardingDescriptorHash?: string
}

// Wallet domain view. recoveryPub is a normalized compatibility alias and is
// never represented as a server wire field.
export interface VaultStatus {
  lightDescriptor?: LightDescriptor
  lightDescriptorHash?: string
  enrolled: boolean
  network: string
  clientOrigin: string
  rpId: string
  vaultId: string
  templateVersion: string
  policyVersion: string
  protectionTier: ProtectionTier | 'light'
  externalOwnerWalletPub?: string
  vaultCosignerBasePub?: string
  arkadeCosignerBasePub?: string
  arkadeCosignerOrigin?: string
  arkadeCosignerVersion?: string
  savingsAddress: string
  savingsScript: string
  periodAllowance: number
  periodSpent: number
  periodRemaining: number
  txCap: number
  absoluteFeeCap: number
  feerateCapSatVb: number
  spendingPolicy?: SpendingPolicy | LightPolicy
  spendingPolicyDigest?: string
  phoneBip340Pub?: string
  phoneDirectP256?: string
  enrollmentMode?: string
  enrollmentExpiresAt?: string
  passkeyLoginAvailable?: boolean
  recoveryPub?: string
  recoveryKeyPub?: string
  warnings?: string[]
  vtxoVaultCosignerPub?: string
  vtxoExitDelay?: number
  vtxoExitDelayUnit?: string
  spendingArkAddress?: string
  spendingArkScript?: string
  vtxoDelegatePub?: string
  vtxoBoardingActive?: boolean
  vtxoBoardingProgram?: string
  vtxoBoardingAddress?: string
  vtxoBoardingScript?: string
  vtxoBoardingExitDelay?: number
  vtxoBoardingExitDelayUnit?: string
  vtxoBoardingDescriptor?: BoardingDescriptor
  vtxoBoardingDescriptorHash?: string
}

export interface BoardingDescriptor {
  schema: 'arkade-vault/board-v1'
  program: 'vault-board-v1'
  template: 'vault-board-v1-boarding-vault-and-operator'
  network: VaultNetwork
  boardingPub: string
  recoveryPhonePub: string
  vaultBoardCosignerPub: string
  operatorPub: string
  exitDelay: number
  exitDelayUnit: 'seconds'
  script: string
  address: string
}
