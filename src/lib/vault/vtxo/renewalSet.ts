import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { signDirectP256, verifyDirectP256 } from '../ceremony/directauth'
import type { VaultStatus } from '../types'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'
import { canonicalHex, validateSpendingSchedule, type SpendingScheduleRequest } from './renewalRequest'
import type { VtxoSpendPasskey } from './spend'

export type SpendingRenewalSetPlan = Omit<SpendingScheduleRequest, 'program' | 'descriptorHash' | 'vaultId'>
export interface SpendingRenewalSet {
  program: string
  descriptorHash: string
  vaultId: string
  setId: string
  plans: SpendingRenewalSetPlan[]
  ownerSignature: string
  authorization?: VtxoSpendPasskey['assertion'] & { directSig: string }
}

export function spendingRenewalSetBody(set: SpendingRenewalSet) {
  return {
    program: set.program,
    descriptorHash: set.descriptorHash,
    vaultId: set.vaultId,
    setId: set.setId,
    plans: set.plans.map((p) => ({
      operationId: p.operationId,
      intent: { proof: p.intent.proof, message: p.intent.message },
      forfeitTxs: p.forfeitTxs,
      deleteIntent: { proof: p.deleteIntent.proof, message: p.deleteIntent.message },
      expiresAt: p.expiresAt,
      ownerSignature: p.ownerSignature,
    })),
  }
}

export function spendingRenewalSetDigest(set: SpendingRenewalSet) {
  return sha256(
    new TextEncoder().encode(`vaulted-vtxo/delegate-schedule-set/v1:${JSON.stringify(spendingRenewalSetBody(set))}`),
  )
}

/** Validates durable authority. Fresh WebAuthn verification and counter acceptance belong to Guardian. */
export function validateSpendingRenewalSet(set: SpendingRenewalSet, status: VaultStatus) {
  const context = guardianRenewalContext(status)
  if (JSON.stringify(set).length > 1024 * 1024) throw new Error('Renewal set exceeds the request limit')
  if (
    !set ||
    set.program !== context.program ||
    set.descriptorHash !== guardianRenewalContextDigest(status) ||
    set.vaultId !== context.vaultId ||
    !canonicalHex(set.setId, 16) ||
    !Array.isArray(set.plans) ||
    set.plans.length < 1 ||
    set.plans.length > 50 ||
    !canonicalHex(set.ownerSignature, 64)
  )
    throw new Error('Renewal set identity or bounds changed')
  const ids = new Set<string>(),
    inputs = new Set<string>()
  for (const plan of set.plans) {
    const facts = validateSpendingSchedule(
      { ...plan, program: set.program, descriptorHash: set.descriptorHash, vaultId: set.vaultId },
      status,
    )
    const input = `${facts.txid}:${facts.vout}`
    if (ids.has(plan.operationId) || inputs.has(input)) throw new Error('Renewal set repeats an operation or input')
    ids.add(plan.operationId)
    inputs.add(input)
  }
  const digest = spendingRenewalSetDigest(set)
  if (!schnorr.verify(hex.decode(set.ownerSignature), digest, hex.decode(context.ownerPub)))
    throw new Error('Renewal set owner authorization changed')
  if (context.protectionTier !== 'light') {
    if (
      !set.authorization ||
      !canonicalHex(set.authorization.directSig, 64) ||
      !status.phoneDirectP256 ||
      !verifyDirectP256(hex.decode(status.phoneDirectP256), digest, hex.decode(set.authorization.directSig))
    )
      throw new Error('Renewal set device authorization changed')
  }
  return set
}

/** Uses one fresh ceremony for the exact set; caller owns and wipes the supplied keys. */
export function signSpendingRenewalSet(
  status: VaultStatus,
  requests: SpendingScheduleRequest[],
  auth: VtxoSpendPasskey,
  setId = hex.encode(crypto.getRandomValues(new Uint8Array(16))),
): SpendingRenewalSet {
  const context = guardianRenewalContext(status)
  for (const request of requests) validateSpendingSchedule(request, status)
  const set: SpendingRenewalSet = {
    program: context.program,
    descriptorHash: guardianRenewalContextDigest(status),
    vaultId: context.vaultId,
    setId,
    plans: requests.map(({ operationId, intent, forfeitTxs, deleteIntent, expiresAt, ownerSignature }) =>
      structuredClone({ operationId, intent, forfeitTxs, deleteIntent, expiresAt, ownerSignature }),
    ),
    ownerSignature: '',
  }
  const digest = spendingRenewalSetDigest(set)
  set.ownerSignature = hex.encode(schnorr.sign(digest, auth.phoneSecret))
  if (context.protectionTier !== 'light')
    set.authorization = {
      ...auth.assertion,
      directSig: hex.encode(signDirectP256(auth.scalar, digest)),
    }
  return validateSpendingRenewalSet(set, status)
}
