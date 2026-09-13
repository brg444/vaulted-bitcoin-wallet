import { SPENDING_ONLY_TEMPLATE, type SpendingEnrollmentDescriptor } from './spendingEnrollment'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import type { VaultNetwork } from './constants'
import type { SpendingPolicy } from './spendingPolicy'
import type { ProtectionTier } from './protectionTier'
import type { LedgerSavingsContract } from './ledgerSavings'

export interface LedgerSavingsStatus extends LedgerSavingsContract {
  descriptorHash: string
}

// Exact JSON object emitted by GET /v1/status?vault=... . Keep normalized
// compatibility aliases out of this type; they belong to VaultStatus below.
export interface VaultStatusWire {
  spendingDescriptor?: SpendingEnrollmentDescriptor
  ledgerSavings?: LedgerSavingsStatus
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
  spendingPolicy: SpendingPolicy
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
// never represented as a server wire field. The admitted account keeps shared
// Spending facts required by existing admission validation and an explicit
// Savings alternative: absent, Ledger Standard or Ledger Advanced. The Ledger
// cases own their required origins, registration and protection facts.
export interface VaultStatusCore {
  enrolled: boolean
  network: string
  clientOrigin: string
  rpId: string
  vaultId: string
  policyVersion: string
  protectionTier: ProtectionTier | 'light'
  savingsAddress: string
  savingsScript: string
  periodAllowance: number
  periodSpent: number
  periodRemaining: number
  txCap: number
  absoluteFeeCap: number
  feerateCapSatVb: number
  phoneBip340Pub: string
  phoneDirectP256: string
  vtxoVaultCosignerPub: string
  vtxoDelegatePub: string
  vtxoExitDelay: number
  vtxoExitDelayUnit: string
  spendingArkAddress: string
  spendingArkScript: string
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
  vtxoBoardingActive: boolean
  vtxoBoardingProgram: string
  vtxoBoardingAddress: string
  vtxoBoardingScript: string
  vtxoBoardingExitDelay: number
  vtxoBoardingExitDelayUnit: string
  vtxoBoardingDescriptor: BoardingDescriptor
  vtxoBoardingDescriptorHash: string
}

export interface VaultStatusOptionalFacts {
  spendingDescriptor?: SpendingEnrollmentDescriptor
  externalOwnerWalletPub?: string
  vaultCosignerBasePub?: string
  arkadeCosignerBasePub?: string
  arkadeCosignerOrigin?: string
  arkadeCosignerVersion?: string
  enrollmentMode?: string
  enrollmentExpiresAt?: string
  passkeyLoginAvailable?: boolean
  recoveryPub?: string
  recoveryKeyPub?: string
  warnings?: string[]
  ledgerSavings?: LedgerSavingsStatus
}

export interface SpendingOnlyVaultStatus extends VaultStatusCore, VaultStatusOptionalFacts {
  templateVersion: typeof SPENDING_ONLY_TEMPLATE
  protectionTier: 'light'
  spendingDescriptor: SpendingEnrollmentDescriptor
  ledgerSavings?: undefined
  externalOwnerWalletPub?: undefined
  recoveryPub?: undefined
  recoveryKeyPub?: undefined
}

interface LedgerVaultStatusBase extends VaultStatusCore, VaultStatusOptionalFacts {
  templateVersion: typeof LEDGER_NATIVE_TEMPLATE
  ledgerSavings: LedgerSavingsStatus
  externalOwnerWalletPub: string
  vaultCosignerBasePub: string
  arkadeCosignerBasePub: string
}

export interface LedgerStandardVaultStatus extends LedgerVaultStatusBase {
  protectionTier: 'standard'
  recoveryPub?: undefined
  recoveryKeyPub?: undefined
}

export interface LedgerAdvancedVaultStatus extends LedgerVaultStatusBase {
  protectionTier: 'advanced'
  recoveryPub: string
  recoveryKeyPub: string
}

export type VaultStatus = SpendingOnlyVaultStatus | LedgerStandardVaultStatus | LedgerAdvancedVaultStatus

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
