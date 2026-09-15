import { OutScript } from '@scure/btc-signer'
import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { renewalSigningJson } from './vtxo/renewalJson'
import type { BitcoinBatchFinalEvidence, BitcoinPaymentResponse } from './bitcoinBatchEvidence'
import type { VaultStatus } from './types'

export interface BitcoinPaymentOutput {
  script: string
  amountSats: number
}
export interface SpendingBitcoinPlan {
  outputs: BitcoinPaymentOutput[]
  operationId: string
  vaultId: string
  descriptorHash: string
  enrollmentDigest: string
  txid: string
  vout: number
  valueSats: number
  changeSats: number
  reserveScript: string
  reserveSats: number
  reserveCount: number
  feeSats: number
  feePolicyDigest: string
  registerExpireAt: number
}
export interface SpendingBitcoinPrepared {
  plan: SpendingBitcoinPlan
  planDigest: string
  state: string
}
export const savingsSetupDigest = (phase: string, body: unknown) =>
  hex.encode(sha256(new TextEncoder().encode(`vaulted-vtxo/savings-setup/${phase}/v1:${renewalSigningJson(body)}`)))
const canonicalHex = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)
// Current Bitcoin payment attempts and other tabs share this persisted namespace.
export const setupKey = (vault: string) => `vaulted:savings-setup:${vault}`
export interface BitcoinPaymentJournal {
  version: 1
  vaultId: string
  descriptorHash: string
  operationId: string
  txid: string
  vout: number
  reserveCount: number
  outputs: BitcoinPaymentOutput[]
  valueSats: number
  stage: 'preparing' | 'prepared' | 'registering' | 'registered' | 'finalizing' | 'submitted' | 'confirmed'
  plan?: SpendingBitcoinPrepared
  deleteIntent?: { proof: string; message: string }
  final?: BitcoinBatchFinalEvidence
  receipt?: BitcoinPaymentResponse
  prepareRequest?: {
    vaultId: string
    operationId: string
    txid: string
    vout: number
    outputs: BitcoinPaymentOutput[]
    expiresAt: number
    ownerSignature: string
  }
}
/**
 * Concurrent onchain payments persist as a per-vault list keyed by
 * operationId. Saves replace by id after a synchronous re-read, so two tabs
 * racing through the construction lock cannot drop each other's records.
 * Reads validate every retained record and fail closed on any mismatch: a
 * tampered record must never silently vanish and release its reservation.
 */
export function listSpendingBitcoin(status: VaultStatus): BitcoinPaymentJournal[] {
  const raw = localStorage.getItem(setupKey(status.vaultId))
  if (!raw) return []
  if (raw.length > 1000000) throw new Error('Bitcoin payment record is too large')
  const parsed = JSON.parse(raw) as BitcoinPaymentJournal | BitcoinPaymentJournal[]
  // Legacy singleton records (including live submitted operations) read as a
  // one-element list and migrate to the list shape on the next save.
  const journals = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (j): j is BitcoinPaymentJournal => typeof j === 'object' && j !== null,
  )
  // Fail closed on any invalid record — a tampered entry blocks rather than
  // releases — but name the offending operation so support can identify it
  // without dumping payment contents.
  journals.forEach((j) => {
    try {
      validateBitcoinJournal(j, status)
    } catch (error) {
      throw new Error(
        `Bitcoin payment record ${typeof j.operationId === 'string' ? j.operationId : 'unknown'} is invalid: ${error instanceof Error ? error.message : 'unreadable'}`,
      )
    }
  })
  return journals
}
export function readSpendingBitcoinById(status: VaultStatus, operationId: string): BitcoinPaymentJournal | null {
  return listSpendingBitcoin(status).find((j) => j.operationId === operationId) ?? null
}
/** Latest saved journal, preserving single-operation call-site behavior. */
export function readSpendingBitcoin(status: VaultStatus): BitcoinPaymentJournal | null {
  const journals = listSpendingBitcoin(status)
  return journals.length ? journals[journals.length - 1]! : null
}
function validateBitcoinJournal(j: BitcoinPaymentJournal, status: VaultStatus): void {
  if (
    j.version !== 1 ||
    j.vaultId !== status.vaultId ||
    j.descriptorHash !== guardianRenewalContextDigest(status) ||
    !canonicalHex(j.operationId, 16) ||
    !canonicalHex(j.txid, 32) ||
    !Number.isSafeInteger(j.vout) ||
    j.vout < 0 ||
    j.vout > 0xffffffff ||
    !Number.isSafeInteger(j.valueSats) ||
    j.valueSats <= 0 ||
    j.valueSats > 21e14 ||
    j.reserveCount !== 0 ||
    !['preparing', 'prepared', 'registering', 'registered', 'finalizing', 'submitted', 'confirmed'].includes(j.stage)
  )
    throw new Error('Bitcoin payment record does not match this wallet')
  validateBitcoinOutputs(j.outputs)
  if (
    (j.stage !== 'preparing' && !j.plan) ||
    (['finalizing', 'submitted', 'confirmed'].includes(j.stage) && !j.final) ||
    (j.stage === 'confirmed' && j.receipt?.state !== 'confirmed')
  )
    throw new Error('Bitcoin payment progress is incomplete')
  if (j.plan) {
    j.plan = validateSpendingBitcoinPlan(j.plan, status)
    if (JSON.stringify(j.plan.plan.outputs) !== JSON.stringify(j.outputs))
      throw new Error('Bitcoin payment outputs changed')
    if (
      j.plan.plan.operationId !== j.operationId ||
      j.plan.plan.txid !== j.txid ||
      j.plan.plan.vout !== j.vout ||
      j.plan.plan.reserveCount !== j.reserveCount ||
      j.plan.plan.valueSats !== j.valueSats
    )
      throw new Error('Bitcoin payment record changed')
  }
  const r = j.prepareRequest
  if (
    !r ||
    r.vaultId !== j.vaultId ||
    r.operationId !== j.operationId ||
    r.txid !== j.txid ||
    r.vout !== j.vout ||
    Object.hasOwn(r, 'reserveCount') ||
    JSON.stringify(r.outputs) !== JSON.stringify(j.outputs) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= 0 ||
    !canonicalHex(r.ownerSignature, 64) ||
    !schnorr.verify(
      hex.decode(r.ownerSignature),
      hex.decode(savingsSetupDigest('bitcoin-prepare', prepareFacts(r))),
      hex.decode(guardianRenewalContext(status).ownerPub),
    )
  )
    throw new Error('Saved Bitcoin payment authorization changed')
  if (j.plan && j.plan.plan.registerExpireAt !== r.expiresAt) throw new Error('Saved Bitcoin payment expiry changed')
  if (
    j.deleteIntent &&
    (typeof j.deleteIntent.proof !== 'string' ||
      !j.deleteIntent.proof ||
      j.deleteIntent.proof.length > 100000 ||
      j.deleteIntent.message !== '{"type":"delete","expire_at":0}')
  )
    throw new Error('Saved Bitcoin payment cancellation is invalid')
  if (j.receipt) validateBitcoinReceipt(j.receipt, j, status)
}
/** Forward-only stage order. Saves must never regress a retained record: a
 *  stale async result (same tab) or a lagging tab must not overwrite a newer
 *  stage or drop its receipt. Equal stages allow idempotent rewrites. */
const BITCOIN_STAGE_RANK: Record<BitcoinPaymentJournal['stage'], number> = {
  preparing: 0,
  prepared: 1,
  registering: 2,
  registered: 3,
  finalizing: 4,
  submitted: 5,
  confirmed: 6,
}
function writeBitcoinJournals(vaultId: string, journals: BitcoinPaymentJournal[]) {
  const raw = JSON.stringify(journals)
  if (raw.length > 1000000) throw new Error('Bitcoin payment recovery paths are too large to save')
  localStorage.setItem(setupKey(vaultId), raw)
  if (localStorage.getItem(setupKey(vaultId)) !== raw) throw new Error('Could not save Bitcoin payment progress')
  window.dispatchEvent(new Event('vaulted-savings-setup'))
}
export function saveBitcoinPayment(status: VaultStatus, j: BitcoinPaymentJournal) {
  // Re-read at save time so a concurrent tab's record survives: replacement
  // is scoped to this operationId and the splice holds no awaits. The splice
  // itself never validates: a poisoned store must remain writable only by
  // shape, never silently dropped — every read still validates all retained
  // records and fails closed, so tampering can only block, never release.
  if (j.vaultId !== status.vaultId) throw new Error('Bitcoin payment record does not match this wallet')
  const raw = localStorage.getItem(setupKey(j.vaultId))
  const parsed = raw ? (JSON.parse(raw) as BitcoinPaymentJournal | BitcoinPaymentJournal[]) : []
  const retained = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (record): record is BitcoinPaymentJournal => typeof record === 'object' && record !== null,
  )
  const stored = retained.find((record) => record.operationId === j.operationId)
  if (stored && BITCOIN_STAGE_RANK[j.stage] < BITCOIN_STAGE_RANK[stored.stage])
    throw new Error('Bitcoin payment record is newer than this update')
  if (stored?.receipt && !j.receipt) throw new Error('Bitcoin payment receipt cannot be removed')
  const journals = retained.filter((record) => record.operationId !== j.operationId)
  journals.push(j)
  writeBitcoinJournals(j.vaultId, journals)
}

/**
 * Outpoints and batch commitments reserved by retained journals. Every
 * retained stage reserves its input: pre-registration drafts may still be
 * admitted, and dispatched operations must never be double-spent. Confirmed
 * journals keep reserving until acknowledgment retires them. A submitted
 * marker alone never releases the original inputs.
 */
export function bitcoinReservedInputs(status: VaultStatus): { outpoints: Set<string>; commitments: Set<string> } {
  const outpoints = new Set<string>()
  const commitments = new Set<string>()
  for (const journal of listSpendingBitcoin(status)) {
    outpoints.add(`${journal.txid}:${journal.vout}`)
    if (journal.receipt?.commitmentTxid) commitments.add(journal.receipt.commitmentTxid)
  }
  return { outpoints, commitments }
}

export const BITCOIN_PAYMENT_EVENT = 'vaulted-savings-setup'
export function prepareFacts(r: NonNullable<BitcoinPaymentJournal['prepareRequest']>) {
  return {
    vaultId: r.vaultId,
    operationId: r.operationId,
    txid: r.txid,
    vout: r.vout,
    outputs: validateBitcoinOutputs(r.outputs),
    expiresAt: r.expiresAt,
  }
}
export function clearBitcoinPayment(j: BitcoinPaymentJournal) {
  // Removal is scoped to this operationId: another operation's record from
  // this or another tab is never touched.
  const raw = localStorage.getItem(setupKey(j.vaultId))
  if (!raw) return
  const parsed = JSON.parse(raw) as BitcoinPaymentJournal | BitcoinPaymentJournal[]
  const journals = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (record): record is BitcoinPaymentJournal =>
      typeof record === 'object' && record !== null && record.operationId !== j.operationId,
  )
  if (journals.length === (Array.isArray(parsed) ? parsed.length : 1)) return
  if (!journals.length) localStorage.removeItem(setupKey(j.vaultId))
  else localStorage.setItem(setupKey(j.vaultId), JSON.stringify(journals))
  window.dispatchEvent(new Event(BITCOIN_PAYMENT_EVENT))
}
export function validateBitcoinReceipt(r: BitcoinPaymentResponse, j: BitcoinPaymentJournal, status: VaultStatus) {
  if (
    !['submitted', 'confirmed', 'uncertain'].includes(r.state) ||
    !canonicalHex(r.commitmentTxid, 32) ||
    !canonicalHex(r.receiverTxid, 32) ||
    !Number.isSafeInteger(r.receiverVout) ||
    r.receiverVout! < 0 ||
    r.receiverVout! > 0xffffffff ||
    !j.final ||
    !j.plan
  )
    throw new Error('Bitcoin payment receipt is incomplete')
  const commitment = Transaction.fromPSBT(base64.decode(j.final.commitmentPsbt))
  const node = j.final.vtxoTree.find((n) => n.txid === r.receiverTxid)
  if (commitment.id !== r.commitmentTxid || !node) throw new Error('Bitcoin payment receipt changed')
  const tx = Transaction.fromPSBT(base64.decode(node.tx))
  const output = tx.getOutput(r.receiverVout!)
  if (
    tx.id !== r.receiverTxid ||
    output.amount !== BigInt(j.plan.plan.changeSats) ||
    hex.encode(output.script!) !== guardianRenewalContext(status).scriptPubKey
  )
    throw new Error('Bitcoin payment change does not match this vault')
}

/** Validate output values and standard scripts before hashing or using them. */
export function validateBitcoinOutputs(outputs: BitcoinPaymentOutput[]): BitcoinPaymentOutput[] {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 2)
    throw new Error('A Bitcoin payment needs one or two outputs')
  const result = outputs.map((o) => {
    if (!o || typeof o.script !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(o.script))
      throw new Error('Invalid Bitcoin payment destination')
    const type = OutScript.decode(hex.decode(o.script)).type
    const dust = type === 'pkh' ? 546 : type === 'sh' ? 540 : ['wpkh', 'wsh', 'tr'].includes(type) ? 330 : Infinity
    if (!Number.isSafeInteger(o.amountSats) || o.amountSats < dust || o.amountSats > 21e14)
      throw new Error('Invalid Bitcoin payment amount or destination')
    return { script: o.script, amountSats: o.amountSats }
  })
  if (result.reduce((n, o) => n + o.amountSats, 0) > 21e14) throw new Error('Bitcoin payment is too large')
  return result
}
export function bitcoinPlanOutputs(p: SpendingBitcoinPlan): BitcoinPaymentOutput[] {
  return validateBitcoinOutputs(p.outputs)
}
export function validateSpendingBitcoinPlan(
  value: SpendingBitcoinPrepared,
  status: VaultStatus,
): SpendingBitcoinPrepared {
  const p = value?.plan
  if (!p) throw new Error('Bitcoin payment plan is missing')
  const policy = guardianRenewalContext(status).spendingPolicy
  const outputs = validateBitcoinOutputs(p.outputs)
  const amount = outputs.reduce((n, o) => n + o.amountSats, 0)
  if (
    p.vaultId !== status.vaultId ||
    p.descriptorHash !== guardianRenewalContextDigest(status) ||
    p.enrollmentDigest !== '' ||
    p.reserveScript !== '' ||
    p.reserveSats !== 0 ||
    p.reserveCount !== 0 ||
    !canonicalHex(p.operationId, 16) ||
    !canonicalHex(p.txid, 32) ||
    !canonicalHex(p.feePolicyDigest, 32) ||
    !Number.isSafeInteger(p.vout) ||
    p.vout < 0 ||
    p.vout > 0xffffffff ||
    !Number.isSafeInteger(p.valueSats) ||
    p.valueSats > 21e14 ||
    !Number.isSafeInteger(p.changeSats) ||
    p.changeSats < 330 ||
    !Number.isSafeInteger(p.feeSats) ||
    p.feeSats < 0 ||
    p.feeSats > Math.min(5000, policy.absoluteFeeCapSats) ||
    amount > policy.txRecipientCapSats ||
    p.valueSats !== p.changeSats + amount + p.feeSats ||
    !Number.isSafeInteger(p.registerExpireAt) ||
    p.registerExpireAt <= 0
  )
    throw new Error('Bitcoin payment does not match this vault and its limits')
  const plan: SpendingBitcoinPlan = {
    operationId: p.operationId,
    vaultId: p.vaultId,
    descriptorHash: p.descriptorHash,
    enrollmentDigest: '',
    txid: p.txid,
    vout: p.vout,
    valueSats: p.valueSats,
    changeSats: p.changeSats,
    reserveScript: '',
    reserveSats: 0,
    reserveCount: 0,
    feeSats: p.feeSats,
    feePolicyDigest: p.feePolicyDigest,
    registerExpireAt: p.registerExpireAt,
    outputs,
  }
  if (savingsSetupDigest('bitcoin-plan', plan) !== value.planDigest) throw new Error('Bitcoin payment approval changed')
  return { ...value, plan }
}
