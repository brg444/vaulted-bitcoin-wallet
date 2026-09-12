import type { TxTreeNode } from '@arkade-os/sdk'

const canonicalHex = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)

export const spendingRenewalStates = [
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
export const spendingRenewalTerminal = (state: string) =>
  ['confirmed', 'invalidated', 'cancelled', 'expired', 'needs_authorization', 'rejected'].includes(state)
export interface SpendingRenewalRecovery {
  batchId: string
  batchExpiry: number
  commitmentPsbt: string
  vtxoTree: TxTreeNode[]
  connectors: TxTreeNode[]
}
export interface SpendingRenewalStatus {
  version: 1
  program: string
  operationId: string
  descriptorHash: string
  state: string
  validAt: number
  expiresAt: number
  txid: string
  vout: number
  inputValueSats: number
  receiverSats: number
  commitmentTxid?: string
  receiverTxid?: string
  receiverVout?: number
  receiverExpiresAt?: number
  recovery?: SpendingRenewalRecovery
}
export function validateRenewalStatusBinding(
  raw: unknown,
  binding: { descriptorHash: string; absoluteFeeCapSats: number; program: string },
  expectedId?: string,
): SpendingRenewalStatus {
  const r = raw as SpendingRenewalStatus
  if (
    !r ||
    r.version !== 1 ||
    !canonicalHex(r.operationId, 16) ||
    (expectedId && r.operationId !== expectedId) ||
    !spendingRenewalStates.includes(r.state as (typeof spendingRenewalStates)[number]) ||
    r.descriptorHash !== binding.descriptorHash ||
    r.program !== binding.program ||
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
    r.inputValueSats - r.receiverSats > binding.absoluteFeeCapSats ||
    (r.commitmentTxid !== undefined && !canonicalHex(r.commitmentTxid, 32)) ||
    (r.receiverTxid !== undefined && !canonicalHex(r.receiverTxid, 32)) ||
    (r.receiverVout !== undefined &&
      (!Number.isSafeInteger(r.receiverVout) || r.receiverVout < 0 || r.receiverVout > 0xffffffff)) ||
    (r.receiverExpiresAt !== undefined && (!Number.isSafeInteger(r.receiverExpiresAt) || r.receiverExpiresAt <= 0))
  )
    throw new Error('Guardian renewal status does not match this wallet')
  return JSON.parse(JSON.stringify(r))
}
export function withoutRecovery(status: SpendingRenewalStatus): SpendingRenewalStatus {
  const rest = { ...status }
  delete rest.recovery
  return rest
}
export function requireSpendingRenewalRecovery(status: SpendingRenewalStatus): SpendingRenewalRecovery {
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
