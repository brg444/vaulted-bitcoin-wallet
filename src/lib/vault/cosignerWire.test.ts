import { ledgerRecoveryFixture } from './recovery/testdata/ledger'
import type { LightDescriptor, LightPolicy } from './light/contract'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { VaultErrorResponse } from './api'
import {
  vtxoOperationViewFromWire,
  type VaultEnrollmentRequest,
  type VaultPasskeyChallengeRequest,
  type VaultPasskeyChallengeResponse,
  type VaultTransitionRequest,
  type VtxoOperationWireView,
  type VtxoReserveRequest,
  type VtxoReserveResponse,
} from './cosignerClient'
import { requireStatusIdentity } from './status'
import type { SpendingPolicy } from './spendingPolicy'
import type { VaultStatusWire } from './types'
import type { ProtectionTier } from './protectionTier'
import type { LedgerSavingsKeyContext, LedgerAccountOrigin } from './program/ledgerNativeKeys'

type ExpectedVaultStatusWire = {
  spendingDescriptor?: import('./spendingEnrollment').SpendingEnrollmentDescriptor
  ledgerSavings?: { context: LedgerSavingsKeyContext; spendingPolicy: SpendingPolicy; descriptorHash: string }

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
  vtxoBoardingDescriptor?: VaultStatusWire['vtxoBoardingDescriptor']
  vtxoBoardingDescriptorHash?: string
}

type ExpectedVaultEnrollmentRequest = {
  ledgerSavings?: {
    templateVersion: 'phone-ledger-guardian-savings-v1'
    phone: LedgerAccountOrigin
    hardware: LedgerAccountOrigin
    recovery?: LedgerAccountOrigin
  }
  handle: string
  userHandle: string
  clientDataJSON: string
  authenticatorData: string
  attestationObject?: string
  credentialId: string
  webauthnP256: string
  phoneDirectP256: string
  phoneBip340Pub: string
  externalOwnerWalletXOnly?: string
  recoveryXOnly?: string
  recoveryKeyXOnly?: string
  vaultId?: string
  descriptorHash?: string
  vtxoBoardingProgram?: 'vault-board-v1'
  vaultBoardingBip340Pub?: string
  protectionTier: ProtectionTier
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
}

type ExpectedVaultTransitionRequest = {
  ledgerSavings?: {
    claimant: 'phone' | 'hardware' | 'recovery'
    remainingUser?: 'phone' | 'hardware' | 'recovery'
    change: 0 | 1
  }
  phoneAuthorization?: { digest: string; signature: string }
  vaultId: string
  purpose: string
  psbt: string
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  directProof: string
}

type ExpectedVtxoReserveResponse = {
  operationId: string
  bundleDigest: string
  reservationExpires: string
  inputs: { txid: string; vout: number; valueSats: number; scriptHex: string }[]
  changeAddress: string
  changeScript: string
  changeSats: number
  changeVout?: number | null
  destScript: string
  feeSats: number
  feePolicyDigest: string
  checkpointTapscript?: string
}

type ExpectedVtxoOperationWireView = {
  operationId: string
  bundleDigest: string
  state: string
  arkTxid?: string
  expiresAt?: string
  feeSats: number
  feePolicyDigest: string
  changeSats: number
  changeVout?: number | null
  changeScript: string
  authorizedPsbt?: string
  authorizedPendingProof?: string
  checkpointPsbts?: string[]
}

describe('Vault cosigner wire DTO conformance', () => {
  it('matches the frozen server status and request schemas exactly', () => {
    expectTypeOf<VaultStatusWire>().toEqualTypeOf<ExpectedVaultStatusWire>()
    expectTypeOf<VaultEnrollmentRequest>().toEqualTypeOf<ExpectedVaultEnrollmentRequest>()
    expectTypeOf<VaultPasskeyChallengeRequest>().toEqualTypeOf<{
      purpose: string
      vaultId?: string
      candidateTxid?: string
    }>()
    expectTypeOf<VaultPasskeyChallengeResponse>().toEqualTypeOf<{
      challengeId: string
      challenge: string
      allowCredentialId: string
      expiresInSeconds: number
    }>()
    expectTypeOf<VaultTransitionRequest>().toEqualTypeOf<ExpectedVaultTransitionRequest>()
    expectTypeOf<VaultErrorResponse>().toEqualTypeOf<{ error: string; code: string }>()
  })

  it('matches the frozen server Spending response schemas exactly', () => {
    expectTypeOf<VtxoReserveRequest>().toEqualTypeOf<{
      operationId: string
      vaultId: string
      purpose: string
      destAddress: string
      amountSats: number
      phoneSignature: string
    }>()
    expectTypeOf<VtxoReserveResponse>().toEqualTypeOf<ExpectedVtxoReserveResponse>()
    expectTypeOf<VtxoOperationWireView>().toEqualTypeOf<ExpectedVtxoOperationWireView>()
  })

  it('normalizes the recovery key only after preserving the exact status wire object', async () => {
    const wire = structuredClone((await ledgerRecoveryFixture(true)).status) as VaultStatusWire & {
      recoveryPub?: string
    }
    wire.recoveryKeyPub = wire.recoveryPub
    delete wire.recoveryPub
    const domain = requireStatusIdentity(wire, wire.vaultId)

    expect(wire).not.toHaveProperty('recoveryPub')
    expect(domain).toMatchObject({
      recoveryKeyPub: wire.recoveryKeyPub,
      recoveryPub: wire.recoveryKeyPub,
    })
  })

  it('passes every operation wire field through the wallet domain adapter', () => {
    const wire: VtxoOperationWireView = {
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      state: 'reserved',
      arkTxid: '33'.repeat(32),
      expiresAt: '2026-08-25T00:00:00Z',
      feeSats: 123,
      feePolicyDigest: '44'.repeat(32),
      changeSats: 456,
      changeVout: 1,
      changeScript: `5120${'55'.repeat(32)}`,
      authorizedPsbt: 'cHNidP8=',
      authorizedPendingProof: 'cHNidP8=',
      checkpointPsbts: ['cHNidP8='],
    }

    expect(vtxoOperationViewFromWire(wire)).toBe(wire)
  })

  it('fails closed on an operation state the wallet does not implement', () => {
    const wire = {
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      state: 'future-state',
      feeSats: 123,
      feePolicyDigest: '44'.repeat(32),
      changeSats: 456,
      changeScript: `5120${'55'.repeat(32)}`,
    } satisfies VtxoOperationWireView

    expect(() => vtxoOperationViewFromWire(wire)).toThrow(/unknown VTXO operation state/)
  })
})
