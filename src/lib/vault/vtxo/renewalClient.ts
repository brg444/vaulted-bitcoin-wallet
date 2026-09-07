import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { readBounded } from '../bounded'
import { authorizerBase } from '../status'
import type { VaultStatus } from '../types'
import { guardianDelegationTerminal, validateDelegationStatusForBinding } from '../light/delegationClient'
import type { GuardianDelegationStatus } from '../light/delegationStore'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'
import {
  canonicalHex,
  spendingDelegationDigest,
  validateSpendingDelegateInfo,
  validateSpendingSchedule,
  type SpendingScheduleRequest,
} from './renewalRequest'
import { validateSpendingRenewalSet, type SpendingRenewalSet } from './renewalSet'

export { guardianDelegationTerminal }
export type SpendingRenewalStatus = GuardianDelegationStatus & { program: string }
export interface SpendingRenewalRead {
  program: string
  descriptorHash: string
  vaultId: string
  operationId: string
  expiresAt: number
  ownerSignature: string
}

export async function spendingRenewalPost(
  phase: 'info' | 'schedule' | 'status' | 'list' | 'cancel',
  body: unknown,
): Promise<unknown> {
  const encoded = JSON.stringify(body)
  if (new TextEncoder().encode(encoded).length > 1024 * 1024) throw new Error('Renewal request exceeds its limit')
  const response = await fetch(`${authorizerBase()}/v1/vtxo/delegate/${phase}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: encoded,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const text = await readBounded(response, phase === 'status' ? 12_500_000 : 128_000)
  if (!response.ok)
    throw new Error('Automatic renewal could not be updated. Saved authorizations will be checked again.')
  return JSON.parse(text)
}

export async function spendingRenewalInfo(status: VaultStatus) {
  const context = guardianRenewalContext(status)
  return validateSpendingDelegateInfo(
    await spendingRenewalPost('info', {
      vaultId: context.vaultId,
    }),
    status,
  )
}

export function validateSpendingRenewalStatus(
  raw: unknown,
  status: VaultStatus,
  expectedId?: string,
): SpendingRenewalStatus {
  const context = guardianRenewalContext(status)
  return validateDelegationStatusForBinding(
    raw,
    {
      program: context.program,
      descriptorHash: guardianRenewalContextDigest(status),
      absoluteFeeCapSats: context.spendingPolicy.absoluteFeeCapSats,
    },
    expectedId,
  ) as SpendingRenewalStatus
}

export function requireSpendingRenewalMatchesPlan(
  status: SpendingRenewalStatus,
  request: SpendingScheduleRequest,
  wallet: VaultStatus,
) {
  const facts = validateSpendingSchedule(request, wallet)
  if (
    status.operationId !== request.operationId ||
    status.descriptorHash !== request.descriptorHash ||
    status.program !== request.program ||
    status.validAt !== facts.message.valid_at ||
    status.expiresAt !== request.expiresAt ||
    status.txid !== facts.txid ||
    status.vout !== facts.vout ||
    status.inputValueSats !== facts.valueSats ||
    status.receiverSats !== facts.receiverSats
  )
    throw new Error('Guardian acknowledged a different renewal authorization')
}

export async function submitSpendingRenewalSet(set: SpendingRenewalSet, status: VaultStatus) {
  validateSpendingRenewalSet(set, status)
  const raw = (await spendingRenewalPost('schedule', set)) as { setId?: string; operations?: unknown[] }
  if (raw.setId !== set.setId || !Array.isArray(raw.operations) || raw.operations.length !== set.plans.length)
    throw new Error('Guardian acknowledged a different renewal set')
  return raw.operations.map((item, index) => {
    const plan = set.plans[index]
    const result = validateSpendingRenewalStatus(item, status, plan.operationId)
    requireSpendingRenewalMatchesPlan(
      result,
      { ...plan, program: set.program, descriptorHash: set.descriptorHash, vaultId: set.vaultId },
      status,
    )
    return result
  })
}

export function spendingRenewalRead(
  status: VaultStatus,
  operationId: string,
  owner: Uint8Array,
  purpose: 'status' | 'cancel' = 'status',
  now = Date.now(),
): SpendingRenewalRead {
  const context = guardianRenewalContext(status)
  if (!canonicalHex(operationId, 16) || hex.encode(schnorr.getPublicKey(owner)) !== context.ownerPub)
    throw new Error('Renewal read identity changed')
  const body = {
    program: context.program,
    descriptorHash: guardianRenewalContextDigest(status),
    vaultId: context.vaultId,
    operationId,
    expiresAt: Math.floor(now / 1000) + 300,
  }
  return { ...body, ownerSignature: hex.encode(schnorr.sign(spendingDelegationDigest(purpose, body), owner)) }
}

export async function listSpendingRenewals(
  status: VaultStatus,
  owner: Uint8Array,
  retain: (page: SpendingRenewalStatus[]) => Promise<SpendingRenewalStatus[]> = async (page) => page,
) {
  const context = guardianRenewalContext(status),
    all: SpendingRenewalStatus[] = []
  if (hex.encode(schnorr.getPublicKey(owner)) !== context.ownerPub) throw new Error('Renewal list identity changed')
  let cursor = ''
  do {
    const body = {
      program: context.program,
      descriptorHash: guardianRenewalContextDigest(status),
      vaultId: context.vaultId,
      afterOperationId: cursor,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }
    const raw = (await spendingRenewalPost('list', {
      ...body,
      ownerSignature: hex.encode(schnorr.sign(spendingDelegationDigest('list', body), owner)),
    })) as {
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
    const page = raw.operations.map((item) => validateSpendingRenewalStatus(item, status))
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
