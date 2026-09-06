import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { authorizerBase } from '../status'
import { readBounded } from '../bounded'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import {
  canonicalHex,
  delegationDigest,
  validateGuardianDelegateInfo,
  type GuardianScheduleRequest,
} from './delegationRequest'
import type { GuardianDelegationStatus, GuardianDelegationRecovery } from './delegationStore'

export const guardianDelegationStates = [
  'armed',
  'claimed',
  'register_authorized',
  'register_dispatched',
  'register_result',
  'batch_started',
  'tree_prepared',
  'nonces_committed',
  'tree_signed',
  'final_authorized',
  'final_dispatched',
  'final_result',
  'cleanup_pending',
  'confirmed',
  'invalidated',
  'cancelled',
  'expired',
  'needs_authorization',
  'rejected',
] as const
export const guardianDelegationTerminal = (state: string) =>
  ['confirmed', 'invalidated', 'cancelled', 'expired', 'needs_authorization', 'rejected'].includes(state)
export interface GuardianReadRequest {
  vaultId: string
  operationId: string
  expiresAt: number
  ownerSignature: string
}
export interface GuardianListRequest {
  vaultId: string
  afterOperationId: string
  expiresAt: number
  ownerSignature: string
}
export class GuardianDelegationUnavailable extends Error {}
export async function guardianDelegatePost(
  phase: 'info' | 'schedule' | 'status' | 'list' | 'cancel',
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${authorizerBase()}/v1/light/delegate/${phase}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const text = await readBounded(response, phase === 'status' ? 12_500_000 : 128_000)
  if (!response.ok)
    throw new GuardianDelegationUnavailable(
      'Automatic renewal could not be updated. Saved authorizations will be checked again.',
    )
  return JSON.parse(text)
}
export async function guardianDelegateInfo(d: LightDescriptor) {
  const raw = await guardianDelegatePost('info', { vaultId: d.vaultId })
  if (!raw || typeof raw !== 'object' || !('enabled' in raw) || raw.enabled !== true)
    throw new GuardianDelegationUnavailable('Automatic renewal is not enabled by Guardian')
  return validateGuardianDelegateInfo(raw, d)
}
export function guardianReadRequest(
  d: LightDescriptor,
  operationId: string,
  owner: Uint8Array,
  purpose: 'status' | 'cancel' = 'status',
  now = Date.now(),
): GuardianReadRequest {
  if (!canonicalHex(operationId, 16) || hex.encode(schnorr.getPublicKey(owner)) !== d.ownerPub)
    throw new Error('Delegation read identity changed')
  const body = { vaultId: d.vaultId, operationId, expiresAt: Math.floor(now / 1000) + 300 }
  return { ...body, ownerSignature: hex.encode(schnorr.sign(delegationDigest(purpose, body), owner)) }
}
export function guardianListRequest(
  d: LightDescriptor,
  afterOperationId: string,
  owner: Uint8Array,
  now = Date.now(),
): GuardianListRequest {
  if (
    (afterOperationId !== '' && !canonicalHex(afterOperationId, 16)) ||
    hex.encode(schnorr.getPublicKey(owner)) !== d.ownerPub
  )
    throw new Error('Delegation list identity changed')
  const body = { vaultId: d.vaultId, afterOperationId, expiresAt: Math.floor(now / 1000) + 300 }
  return { ...body, ownerSignature: hex.encode(schnorr.sign(delegationDigest('list', body), owner)) }
}
export function validateGuardianDelegationStatus(
  raw: unknown,
  d: LightDescriptor,
  expectedId?: string,
): GuardianDelegationStatus {
  const r = raw as GuardianDelegationStatus
  if (
    !r ||
    r.version !== 1 ||
    !canonicalHex(r.operationId, 16) ||
    (expectedId && r.operationId !== expectedId) ||
    !guardianDelegationStates.includes(r.state as (typeof guardianDelegationStates)[number]) ||
    r.descriptorHash !== lightDescriptorDigest(d) ||
    !canonicalHex(r.txid, 32) ||
    !Number.isSafeInteger(r.vout) ||
    r.vout < 0 ||
    r.vout > 0xffffffff ||
    !Number.isSafeInteger(r.validAt) ||
    r.validAt <= 0 ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= r.validAt ||
    r.expiresAt > r.validAt + 86400 ||
    !Number.isSafeInteger(r.inputValueSats) ||
    r.inputValueSats <= 0 ||
    r.inputValueSats > 21e14 ||
    !Number.isSafeInteger(r.receiverSats) ||
    r.receiverSats <= 0 ||
    r.receiverSats > r.inputValueSats ||
    r.inputValueSats - r.receiverSats > d.spendingPolicy.absoluteFeeCapSats ||
    (r.commitmentTxid !== undefined && !canonicalHex(r.commitmentTxid, 32)) ||
    (r.receiverTxid !== undefined && !canonicalHex(r.receiverTxid, 32)) ||
    (r.receiverVout !== undefined &&
      (!Number.isSafeInteger(r.receiverVout) || r.receiverVout < 0 || r.receiverVout > 0xffffffff)) ||
    (r.receiverExpiresAt !== undefined && (!Number.isSafeInteger(r.receiverExpiresAt) || r.receiverExpiresAt <= 0))
  )
    throw new Error('Guardian renewal status does not match this wallet')
  return JSON.parse(JSON.stringify(r))
}
export function requireStatusMatchesRequest(status: GuardianDelegationStatus, request: GuardianScheduleRequest) {
  if (
    status.operationId !== request.operationId ||
    status.validAt !== JSON.parse(request.intent.message).valid_at ||
    status.expiresAt !== request.expiresAt
  )
    throw new Error('Guardian acknowledged a different authorization')
}
export async function listGuardianDelegations(
  d: LightDescriptor,
  owner: Uint8Array,
  retain: (page: GuardianDelegationStatus[]) => Promise<GuardianDelegationStatus[]> = async (page) => page,
) {
  const all: GuardianDelegationStatus[] = []
  let cursor = ''
  do {
    const raw = (await guardianDelegatePost('list', guardianListRequest(d, cursor, owner))) as {
      version: number
      operations: unknown[]
      nextCursor: string
    }
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.operations) ||
      raw.operations.length > 100 ||
      typeof raw.nextCursor !== 'string' ||
      (raw.nextCursor !== '' && !canonicalHex(raw.nextCursor, 16))
    )
      throw new Error('Invalid Guardian renewal list')
    const page = raw.operations.map((v) => validateGuardianDelegationStatus(v, d))
    if (
      page.some((v, i) => v.operationId <= (i ? page[i - 1].operationId : cursor)) ||
      (raw.nextCursor !== '' && raw.nextCursor !== page.at(-1)?.operationId)
    )
      throw new Error('Guardian renewal pagination changed')
    all.push(...(await retain(page)))
    if (all.length > 512) throw new Error('Guardian renewal history exceeds the client limit')
    cursor = raw.nextCursor
  } while (cursor)
  return all
}
export function withoutRecovery(status: GuardianDelegationStatus): GuardianDelegationStatus {
  const rest = { ...status }
  delete rest.recovery
  return rest
}
export function requireDelegationRecovery(status: GuardianDelegationStatus): GuardianDelegationRecovery {
  const r = status.recovery
  if (
    !r ||
    !status.commitmentTxid ||
    !status.receiverTxid ||
    status.receiverVout === undefined ||
    !Number.isSafeInteger(r.batchExpiry) ||
    r.batchExpiry <= 0 ||
    typeof r.batchId !== 'string' ||
    r.batchId.length > 256 ||
    typeof r.commitmentPsbt !== 'string' ||
    r.commitmentPsbt.length > 1_000_000 ||
    !Array.isArray(r.vtxoTree) ||
    !r.vtxoTree.length ||
    r.vtxoTree.length > 512 ||
    !Array.isArray(r.connectors) ||
    r.connectors.length > 512 ||
    JSON.stringify(r).length > 12_000_000
  )
    throw new Error('Complete renewal recovery data is unavailable')
  return r
}
