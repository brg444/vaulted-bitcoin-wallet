import type { TxTreeNode } from '@arkade-os/sdk'
import type { VtxoAuthorizeRequest } from '../cosignerClient'

export interface LightRenewalPlan {
  operationId: string
  vaultId: string
  descriptorHash: string
  txid: string
  vout: number
  valueSats: number
  receiverSats: number
  feeSats: number
  feePolicyDigest: string
  registerExpireAt: number
}
export interface LightRenewalPrepareRequest {
  vaultId: string
  operationId: string
  txid: string
  vout: number
  ownerSignature: string
}
export interface LightRenewalPrepared {
  plan: LightRenewalPlan
  planDigest: string
  state: string
}
export interface LightRenewalRegisterRequest {
  vaultId: string
  operationId: string
  psbt: string
  message: string
  assertion: Pick<VtxoAuthorizeRequest, 'credentialId' | 'clientDataJSON' | 'authenticatorData' | 'signature'>
  directSig: string
}
export interface LightRenewalFinalEvidence {
  batchId: string
  batchExpiry: number
  commitmentPsbt: string
  vtxoTree: TxTreeNode[]
  connectors: TxTreeNode[]
  ownerForfeitPsbt: string
}
export interface LightRenewalOperationRequest {
  vaultId: string
  operationId: string
}
export interface LightRenewalResponse {
  state: string
  intentId?: string
  commitmentTxid?: string
  receiverTxid?: string
  receiverVout?: number
}
export interface LightRenewalClient {
  prepare(request: LightRenewalPrepareRequest): Promise<LightRenewalPrepared>
  register(request: LightRenewalRegisterRequest): Promise<LightRenewalResponse>
  final(request: LightRenewalOperationRequest & { evidence: LightRenewalFinalEvidence }): Promise<LightRenewalResponse>
  status(request: LightRenewalOperationRequest): Promise<LightRenewalResponse>
  release(request: LightRenewalOperationRequest): Promise<LightRenewalResponse>
}
