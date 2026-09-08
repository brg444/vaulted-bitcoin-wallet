import { OutScript } from '@scure/btc-signer'
import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { connectorContract, connectorIdentity } from './connectorWithdrawal'
import { buildConnectorFamily, DUAL_CONNECTOR_TEMPLATE } from './program/connector'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { renewalSigningJson } from './vtxo/renewalJson'
import type { LightRenewalFinalEvidence, LightRenewalResponse } from './light/renewalTypes'
import type { VaultStatus } from './types'

export interface BitcoinPaymentOutput {
  script: string
  amountSats: number
}
export interface SpendingBitcoinPlan {
  outputs?: BitcoinPaymentOutput[]
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
// Keep the existing namespace so old signed attempts and other tabs share one reservation.
export const setupKey = (vault: string) => `vaulted:savings-setup:${vault}`
export function validateSpendingBitcoinPlan(
  value: SpendingBitcoinPrepared,
  status: VaultStatus,
): SpendingBitcoinPrepared {
  if (value?.plan?.outputs !== undefined) return validateBitcoinPlan(value, status)
  const identity = connectorIdentity(status)
  const contract = connectorContract(status)
  const family = buildConnectorFamily(contract)
  const p = value?.plan
  const dual = status.templateVersion === DUAL_CONNECTOR_TEMPLATE
  if (
    !p ||
    p.vaultId !== status.vaultId ||
    p.descriptorHash !== guardianRenewalContextDigest(status) ||
    p.enrollmentDigest !== identity.enrollmentDigest ||
    !canonicalHex(p.operationId, 16) ||
    !canonicalHex(p.txid, 32) ||
    !canonicalHex(p.feePolicyDigest, 32) ||
    p.reserveScript !== hex.encode(family.connector.script) ||
    p.reserveSats !== (dual ? 500 : 1000) ||
    !Number.isInteger(p.reserveCount) ||
    p.reserveCount < 1 ||
    p.reserveCount > (dual ? 2 : 1) ||
    !Number.isSafeInteger(p.vout) ||
    p.vout < 0 ||
    p.vout > 0xffffffff ||
    !Number.isSafeInteger(p.valueSats) ||
    p.valueSats > 21e14 ||
    !Number.isSafeInteger(p.changeSats) ||
    p.changeSats < 330 ||
    !Number.isSafeInteger(p.feeSats) ||
    p.feeSats < 0 ||
    p.feeSats > Math.min(5000, contract.absoluteFeeCapSats) ||
    p.reserveSats * p.reserveCount > contract.spendingPolicy.txRecipientCapSats ||
    p.valueSats !== p.changeSats + p.reserveSats * p.reserveCount + p.feeSats ||
    !Number.isSafeInteger(p.registerExpireAt) ||
    p.registerExpireAt <= 0
  )
    throw new Error('Bitcoin payment does not match this vault and its limits')
  const plan: SpendingBitcoinPlan = {
    operationId: p.operationId,
    vaultId: p.vaultId,
    descriptorHash: p.descriptorHash,
    enrollmentDigest: p.enrollmentDigest,
    txid: p.txid,
    vout: p.vout,
    valueSats: p.valueSats,
    changeSats: p.changeSats,
    reserveScript: p.reserveScript,
    reserveSats: p.reserveSats,
    reserveCount: p.reserveCount,
    feeSats: p.feeSats,
    feePolicyDigest: p.feePolicyDigest,
    registerExpireAt: p.registerExpireAt,
  }
  if (savingsSetupDigest('plan', plan) !== value.planDigest) throw new Error('Bitcoin payment approval changed')
  return { ...value, plan }
}
export interface BitcoinPaymentJournal {
  version: 1
  vaultId: string
  descriptorHash: string
  operationId: string
  txid: string
  vout: number
  reserveCount: number
  outputs?: BitcoinPaymentOutput[]
  valueSats: number
  stage: 'preparing' | 'prepared' | 'registering' | 'registered' | 'finalizing' | 'submitted' | 'confirmed'
  plan?: SpendingBitcoinPrepared
  deleteIntent?: { proof: string; message: string }
  final?: LightRenewalFinalEvidence
  receipt?: LightRenewalResponse
  prepareRequest?: {
    vaultId: string
    operationId: string
    txid: string
    vout: number
    reserveCount?: number
    outputs?: BitcoinPaymentOutput[]
    expiresAt: number
    ownerSignature: string
  }
}
export function readSpendingBitcoin(status: VaultStatus): BitcoinPaymentJournal | null {
  const raw = localStorage.getItem(setupKey(status.vaultId))
  if (!raw) return null
  if (raw.length > 1000000) throw new Error('Bitcoin payment record is too large')
  const j = JSON.parse(raw) as BitcoinPaymentJournal
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
    !Number.isInteger(j.reserveCount) ||
    j.reserveCount < (j.outputs ? 0 : 1) ||
    j.reserveCount > 2 ||
    !['preparing', 'prepared', 'registering', 'registered', 'finalizing', 'submitted', 'confirmed'].includes(j.stage)
  )
    throw new Error('Bitcoin payment record does not match this wallet')
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
    (r.outputs
      ? j.reserveCount !== 0 || JSON.stringify(r.outputs) !== JSON.stringify(j.outputs)
      : r.reserveCount !== j.reserveCount || j.outputs !== undefined) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= 0 ||
    !canonicalHex(r.ownerSignature, 64) ||
    !schnorr.verify(
      hex.decode(r.ownerSignature),
      hex.decode(savingsSetupDigest(r.outputs ? 'bitcoin-prepare' : 'prepare', prepareFacts(r))),
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
  return j
}
export function saveBitcoinPayment(j: BitcoinPaymentJournal) {
  const raw = JSON.stringify(j)
  if (raw.length > 1000000) throw new Error('Bitcoin payment recovery paths are too large to save')
  localStorage.setItem(setupKey(j.vaultId), raw)
  if (localStorage.getItem(setupKey(j.vaultId)) !== raw) throw new Error('Could not save Bitcoin payment progress')
  window.dispatchEvent(new Event('vaulted-savings-setup'))
}

export const BITCOIN_PAYMENT_EVENT = 'vaulted-savings-setup'
export function prepareFacts(r: NonNullable<BitcoinPaymentJournal['prepareRequest']>) {
  return {
    vaultId: r.vaultId,
    operationId: r.operationId,
    txid: r.txid,
    vout: r.vout,
    ...(r.outputs ? { outputs: validateBitcoinOutputs(r.outputs) } : { reserveCount: r.reserveCount }),
    expiresAt: r.expiresAt,
  }
}
export function clearBitcoinPayment(j: BitcoinPaymentJournal) {
  // Never remove a newer operation from another observer.
  const raw = localStorage.getItem(setupKey(j.vaultId))
  if (raw && JSON.parse(raw).operationId === j.operationId) {
    localStorage.removeItem(setupKey(j.vaultId))
    window.dispatchEvent(new Event(BITCOIN_PAYMENT_EVENT))
  }
}
export function validateBitcoinReceipt(r: LightRenewalResponse, j: BitcoinPaymentJournal, status: VaultStatus) {
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
  return (
    p.outputs || Array.from({ length: p.reserveCount }, () => ({ script: p.reserveScript, amountSats: p.reserveSats }))
  )
}
function validateBitcoinPlan(value: SpendingBitcoinPrepared, status: VaultStatus): SpendingBitcoinPrepared {
  const p = value.plan
  const policy = guardianRenewalContext(status).spendingPolicy
  const outputs = validateBitcoinOutputs(p.outputs!)
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
