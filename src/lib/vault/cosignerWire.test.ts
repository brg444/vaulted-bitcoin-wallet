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
import { POLICY_VERSION } from './constants'
import { SAVINGS_TEMPLATE } from './program/constants'
import { requireStatusIdentity } from './status'
import { defaultSpendingPolicy, spendingPolicyDigest, type SpendingPolicy } from './spendingPolicy'
import type { VaultStatusWire } from './types'
import type { ProtectionTier } from './protectionTier'

type ExpectedVaultStatusWire = {
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

function statusWire(): VaultStatusWire {
  const spendingPolicy = defaultSpendingPolicy()
  return {
    enrolled: true,
    network: 'mutinynet',
    clientOrigin: 'https://vault.example',
    rpId: 'vault.example',
    vaultId: 'vault-a',
    templateVersion: SAVINGS_TEMPLATE,
    policyVersion: POLICY_VERSION,
    protectionTier: 'advanced',
    recoveryKeyPub: `02${'aa'.repeat(32)}`,
    arkadeCosignerOrigin: 'https://mutinynet.arkade.sh',
    arkadeCosignerVersion: '0.4.65',
    savingsAddress: 'tb1psavings',
    savingsScript: `5120${'bb'.repeat(32)}`,
    passkeyLoginAvailable: true,
    enrollmentMode: 'invite',
    periodAllowance: 100_000,
    periodSpent: 10_000,
    periodRemaining: 90_000,
    txCap: 50_000,
    absoluteFeeCap: 5_000,
    feerateCapSatVb: 10,
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
    vtxoVaultCosignerPub: `02${'cc'.repeat(32)}`,
    vtxoExitDelay: 4608,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: 'tark1spending',
    spendingArkScript: `5120${'dd'.repeat(32)}`,
    vtxoDelegatePub: `02${'ee'.repeat(32)}`,
    vtxoBoardingActive: true,
    vtxoBoardingProgram: 'vault-board-v1',
    vtxoBoardingAddress: 'tb1pboarding',
    vtxoBoardingScript: `5120${'ff'.repeat(32)}`,
    vtxoBoardingExitDelay: 604672,
    vtxoBoardingExitDelayUnit: 'seconds',
  }
}

describe('Vault cosigner wire DTO conformance', () => {
  it('matches the frozen server status and request schemas exactly', () => {
    expectTypeOf<VaultStatusWire>().toEqualTypeOf<ExpectedVaultStatusWire>()
    expectTypeOf<VaultEnrollmentRequest>().toEqualTypeOf<ExpectedVaultEnrollmentRequest>()
    expectTypeOf<VaultPasskeyChallengeRequest>().toEqualTypeOf<{ purpose: string; vaultId?: string }>()
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

  it('normalizes the recovery key only after preserving the exact status wire object', () => {
    const wire = statusWire()
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
