import type { LightRenewalClient } from './light/renewalTypes'
import { vaultGet, vaultPost } from './api'
import { fetchPublicStatus, fetchVaultStatus, type PublicAuthorizerStatus } from './status'
import type { VaultStatus, VaultStatusWire } from './types'
import type { SpendingPolicy } from './spendingPolicy'
import type { ProtectionTier } from './protectionTier'

const enrollmentHeader = (token: string) => ({ 'X-Vault-Enrollment-Token': token })

export interface VaultInviteView {
  canEnroll: boolean
  vaultId: string | null
}

export interface VaultEnrollStartResponse {
  handle: string
  vaultId: string
  challenge: string
  rpId: string
  rpName: string
  userId: string
  userName: string
  timeoutMs: number
  protectionTier: ProtectionTier
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
}

export interface VaultEnrollStartRequest {
  protectionTier: ProtectionTier
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
}

export interface VaultEnrollmentRequest {
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

export interface VaultEnrollProposeResponse {
  vaultId: string
  descriptorHash: string
  descriptor: unknown
}

export type VaultPasskeyPurpose = 'recover' | 'install-envelope' | 'transition' | 'map-write'

export interface VaultPasskeyChallengeRequest {
  purpose: string
  vaultId?: string
}

export interface VaultPasskeyChallengeResponse {
  challengeId: string
  challenge: string
  allowCredentialId: string
  expiresInSeconds: number
}

export interface VaultSessionAssertion {
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  directProof: string
}

export interface VaultRecoveryBindingRequest {
  vaultId: string
  envelopeNonce: string
  envelopeCiphertext: string
}

export interface VaultRecoveryBindingResponse {
  binding: string
  bindingDigest: string
}

export interface VaultInstallEnvelopeRequest extends VaultRecoveryBindingRequest, VaultSessionAssertion {
  binding: string
  bindingDirectSig: string
  bindingPhoneSig: string
}

export interface VaultRecoverEnvelopeRequest extends VaultSessionAssertion {
  vaultId: string
}

export interface VaultRecoverEnvelopeResponse extends VaultRecoveryBindingResponse {
  envelopeNonce: string
  envelopeCiphertext: string
  bindingDirectSig: string
  bindingPhoneSig: string
}

export interface VaultTransitionRequest extends VaultSessionAssertion {
  vaultId: string
  purpose: string
  psbt: string
}

export type VaultInitiateRequest = Omit<VaultTransitionRequest, 'purpose'> & { purpose: 'initiate' }
export type VaultClawbackRequest = Omit<VaultTransitionRequest, 'purpose'> & { purpose: 'clawback' }

export interface VaultTransitionResponse {
  signedPsbt: string
  replay: boolean
}

export interface VaultMapWriteRequest extends VaultSessionAssertion {
  vaultId: string
  payload: unknown
}

export interface VtxoReserveRequest {
  operationId: string
  vaultId: string
  purpose: string
  destAddress: string
  amountSats: number
  phoneSignature: string
}

export interface VtxoReserveResponse {
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

export interface VtxoAuthorizeRequest {
  vaultId: string
  operationId: string
  bundleDigest: string
  unsignedArkPsbt: string
  unsignedCheckpointPsbts: string[]
  pendingProof: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  directSig: string
}

export interface VtxoAuthorizeResponse {
  operationId: string
  bundleDigest: string
  authorizedPsbt: string
  authorizedPendingProof: string
  arkTxid: string
}

export interface VtxoCheckpointAuthorizeRequest {
  vaultId: string
  operationId: string
  bundleDigest: string
  checkpointPsbts: string[]
}

export interface VtxoCheckpointAuthorizeResponse {
  operationId: string
  bundleDigest: string
  checkpointPsbts: string[]
  arkTxid: string
}

export interface VtxoFinalizeRequest {
  vaultId: string
  operationId: string
  bundleDigest: string
  arkTxid: string
}

export interface VtxoFinalizeResponse {
  operationId: string
  bundleDigest: string
  state: string
  arkTxid: string
}

export interface VtxoAbortRequest {
  operationId: string
  vaultId: string
  purpose: 'spend'
  phoneSignature: string
}

export interface VtxoAbortResponse {
  operationId: string
  state: string
}

export type VtxoOperationState = 'reserved' | 'signed' | 'submitted' | 'finalized' | 'aborted' | 'unresolved'

export class UnknownVtxoOperationStateError extends Error {
  constructor(state: unknown) {
    super(`unknown VTXO operation state: ${String(state)}`)
    this.name = 'UnknownVtxoOperationStateError'
  }
}

// Exact JSON object emitted by GET /v1/vtxo/operation.
export interface VtxoOperationWireView {
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

// Wallet domain view after the operation state is bound to the current
// lifecycle. Optional economic fields retain compatibility with persisted
// browser fixtures; they are required on VtxoOperationWireView.
export interface VtxoOperationView {
  operationId: string
  bundleDigest: string
  state: VtxoOperationState
  arkTxid?: string
  expiresAt?: string
  feeSats?: number
  feePolicyDigest?: string
  changeSats?: number
  changeVout?: number | null
  changeScript?: string
  authorizedPsbt?: string
  authorizedPendingProof?: string
  checkpointPsbts?: string[]
}

export function vtxoOperationViewFromWire(wire: VtxoOperationWireView): VtxoOperationView {
  switch (wire.state) {
    case 'reserved':
    case 'signed':
    case 'submitted':
    case 'finalized':
    case 'aborted':
    case 'unresolved':
      break
    default:
      throw new UnknownVtxoOperationStateError(wire.state)
  }
  return wire as VtxoOperationView
}

export interface VaultMutationSuccess {
  ok: boolean
}

export interface VaultCosignerEnrollmentClient {
  publicStatus(signal?: AbortSignal): Promise<PublicAuthorizerStatus>
  status(vaultId: string, signal?: AbortSignal): Promise<VaultStatus>
  session(): Promise<{ token: string; expiresAt: string }>
  invite(token: string): Promise<VaultInviteView>
  start(token: string, request: VaultEnrollStartRequest): Promise<VaultEnrollStartResponse>
  propose(token: string, request: VaultEnrollmentRequest): Promise<VaultEnrollProposeResponse>
  finish(token: string, request: VaultEnrollmentRequest): Promise<VaultStatusWire>
  binding(request: VaultRecoveryBindingRequest): Promise<VaultRecoveryBindingResponse>
  install(request: VaultInstallEnvelopeRequest): Promise<VaultMutationSuccess>
  recover(request: VaultRecoverEnvelopeRequest): Promise<VaultRecoverEnvelopeResponse>
}

export interface BoardingOutpointWire {
  txid: string
  vout: number
}

export interface BoardingRecipientWire {
  address: string
  amountSats: number
}

export interface BoardingPrepareRequest {
  vaultId: string
  inputs: BoardingOutpointWire[]
  recipients: BoardingRecipientWire[]
}

export type BoardingPrepareResponse =
  | { status: 'ready'; handle: string; registerExpireAt: number }
  | { status: 'release_required'; handle: string; deleteExpireAt: number }
  | { status: 'blocked'; reason: string }
  | { status: 'finalized'; commitmentTxid: string }

export type BoardingRegisterMessageWire = {
  type: 'register'
  onchain_output_indexes: number[]
  valid_at: number
  expire_at: number
  cosigners_public_keys: string[]
}

export type BoardingDeleteMessageWire = { type: 'delete'; expire_at: number }

export interface BoardingPhaseRequest<Message> {
  handle: string
  psbt: string
  inputIndexes: number[]
  message: Message
}

export type BoardingRegisterResponse =
  | { status: 'registered'; intentId: string }
  | { status: 'definitely_not_submitted' }
  | { status: 'ambiguous' }

export type BoardingReleaseResponse = { status: 'released' } | { status: 'ambiguous' }
export type BoardingFinalResponse = { status: 'submitted' } | { status: 'ambiguous' }

export interface BoardingTreeNodeWire {
  txid: string
  tx: string
  children: Record<number, string>
}

export interface BoardingFinalRequest {
  handle: string
  psbt: string
  inputIndexes: number[]
  signedForfeits: string[]
  validatedBatch: {
    batchId: string
    batchExpiry: number
    unsignedCommitmentTx: string
    vtxoTree: BoardingTreeNodeWire[]
    expectedRecipients: BoardingRecipientWire[]
  }
}

export interface VaultCosignerBoardingClient {
  prepare(request: BoardingPrepareRequest): Promise<BoardingPrepareResponse>
  register(request: BoardingPhaseRequest<BoardingRegisterMessageWire>): Promise<BoardingRegisterResponse>
  release(request: BoardingPhaseRequest<BoardingDeleteMessageWire>): Promise<BoardingReleaseResponse>
  final(request: BoardingFinalRequest): Promise<BoardingFinalResponse>
}

export interface VaultCosignerRecoveryClient {
  challenge(request: VaultPasskeyChallengeRequest): Promise<VaultPasskeyChallengeResponse>
  initiate(request: VaultInitiateRequest): Promise<VaultTransitionResponse>
  clawback(request: VaultClawbackRequest): Promise<VaultTransitionResponse>
  readMap(vaultId: string): Promise<unknown>
  writeMap(request: VaultMapWriteRequest): Promise<VaultMutationSuccess>
}

export interface VaultCosignerSpendingClient {
  reserve(request: VtxoReserveRequest): Promise<VtxoReserveResponse>
  authorize(request: VtxoAuthorizeRequest): Promise<VtxoAuthorizeResponse>
  authorizeCheckpoints(request: VtxoCheckpointAuthorizeRequest): Promise<VtxoCheckpointAuthorizeResponse>
  finalize(request: VtxoFinalizeRequest): Promise<VtxoFinalizeResponse>
  abort(request: VtxoAbortRequest): Promise<VtxoAbortResponse>
  operation(vaultId: string, operationId: string): Promise<VtxoOperationWireView>
}

export interface VaultCosignerClient {
  enrollment: VaultCosignerEnrollmentClient
  recovery: VaultCosignerRecoveryClient
  spending: VaultCosignerSpendingClient
  boarding: VaultCosignerBoardingClient
  lightRenewal: LightRenewalClient
}

export const vaultCosignerClient: VaultCosignerClient = {
  lightRenewal: {
    prepare: (request) => vaultPost('/v1/light/renew/prepare', request),
    register: (request) => vaultPost('/v1/light/renew/register', request),
    final: (request) => vaultPost('/v1/light/renew/final', request),
    status: ({ vaultId, operationId }) => vaultPost('/v1/light/renew/status', { vaultId, operationId }),
    release: ({ vaultId, operationId }) => vaultPost('/v1/light/renew/release', { vaultId, operationId }),
  },
  enrollment: {
    publicStatus(signal) {
      return fetchPublicStatus(signal)
    },
    status(vaultId, signal) {
      return fetchVaultStatus(signal, vaultId)
    },
    session() {
      return vaultPost('/v1/enroll/session', {})
    },
    invite(token) {
      return vaultGet('/v1/invite', enrollmentHeader(token))
    },
    start(token, request) {
      return vaultPost('/v1/enroll/start', request, enrollmentHeader(token))
    },
    propose(token, request) {
      return vaultPost('/v1/enroll/propose', request, enrollmentHeader(token))
    },
    finish(token, request) {
      return vaultPost('/v1/enroll/finish', request, enrollmentHeader(token))
    },
    binding(request) {
      return vaultPost('/v1/passkey/binding', request)
    },
    install(request) {
      return vaultPost('/v1/passkey/install', request)
    },
    recover(request) {
      return vaultPost('/v1/passkey/recover', request)
    },
  },
  recovery: {
    challenge(request) {
      return vaultPost('/v1/passkey/challenge', request)
    },
    initiate(request) {
      return vaultPost('/v1/initiate', request)
    },
    clawback(request) {
      return vaultPost('/v1/clawback', request)
    },
    readMap(vaultId) {
      return vaultGet(`/v1/map?vault=${encodeURIComponent(vaultId)}`)
    },
    writeMap(request) {
      return vaultPost('/v1/map', request)
    },
  },
  spending: {
    reserve(request) {
      return vaultPost('/v1/vtxo/reserve', request)
    },
    authorize(request) {
      return vaultPost('/v1/vtxo/authorize', request)
    },
    authorizeCheckpoints(request) {
      return vaultPost('/v1/vtxo/checkpoints/authorize', request)
    },
    finalize(request) {
      return vaultPost('/v1/vtxo/finalize', request)
    },
    abort(request) {
      return vaultPost('/v1/vtxo/abort', request)
    },
    operation(vaultId, operationId) {
      return vaultGet(
        `/v1/vtxo/operation?vaultId=${encodeURIComponent(vaultId)}&operationId=${encodeURIComponent(operationId)}`,
      )
    },
  },
  boarding: {
    prepare(request) {
      return vaultPost('/v1/vtxo/board/prepare', request)
    },
    register(request) {
      return vaultPost('/v1/vtxo/board/register', request)
    },
    release(request) {
      return vaultPost('/v1/vtxo/board/release', request)
    },
    final(request) {
      return vaultPost('/v1/vtxo/board/final', request)
    },
  },
}
