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

export interface SavingsSetupPlan {
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
export interface SavingsSetupPrepared {
  plan: SavingsSetupPlan
  planDigest: string
  state: string
}
export const savingsSetupDigest = (phase: string, body: unknown) =>
  hex.encode(sha256(new TextEncoder().encode(`vaulted-vtxo/savings-setup/${phase}/v1:${renewalSigningJson(body)}`)))
const canonicalHex = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)
export const setupKey = (vault: string) => `vaulted:savings-setup:${vault}`
export function validateSavingsSetupPlan(value: SavingsSetupPrepared, status: VaultStatus): SavingsSetupPrepared {
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
    throw new Error('Signer funding does not match this vault and its limits')
  const plan: SavingsSetupPlan = {
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
  if (savingsSetupDigest('plan', plan) !== value.planDigest) throw new Error('Signer funding approval changed')
  return { ...value, plan }
}
export interface SetupJournal {
  version: 1
  vaultId: string
  descriptorHash: string
  operationId: string
  txid: string
  vout: number
  reserveCount: number
  valueSats: number
  stage: 'preparing' | 'prepared' | 'registering' | 'registered' | 'finalizing' | 'submitted' | 'confirmed'
  plan?: SavingsSetupPrepared
  deleteIntent?: { proof: string; message: string }
  final?: LightRenewalFinalEvidence
  receipt?: LightRenewalResponse
  prepareRequest?: {
    vaultId: string
    operationId: string
    txid: string
    vout: number
    reserveCount: number
    expiresAt: number
    ownerSignature: string
  }
}
export function readSavingsSetup(status: VaultStatus): SetupJournal | null {
  const raw = localStorage.getItem(setupKey(status.vaultId))
  if (!raw) return null
  if (raw.length > 1000000) throw new Error('Signer setup record is too large')
  const j = JSON.parse(raw) as SetupJournal
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
    j.reserveCount < 1 ||
    j.reserveCount > 2 ||
    !['preparing', 'prepared', 'registering', 'registered', 'finalizing', 'submitted', 'confirmed'].includes(j.stage)
  )
    throw new Error('Signer setup record does not match this wallet')
  if (
    (j.stage !== 'preparing' && !j.plan) ||
    (['finalizing', 'submitted', 'confirmed'].includes(j.stage) && !j.final) ||
    (j.stage === 'confirmed' && j.receipt?.state !== 'confirmed')
  )
    throw new Error('Signer setup progress is incomplete')
  if (j.plan) {
    j.plan = validateSavingsSetupPlan(j.plan, status)
    if (
      j.plan.plan.operationId !== j.operationId ||
      j.plan.plan.txid !== j.txid ||
      j.plan.plan.vout !== j.vout ||
      j.plan.plan.reserveCount !== j.reserveCount ||
      j.plan.plan.valueSats !== j.valueSats
    )
      throw new Error('Signer setup record changed')
  }
  const r = j.prepareRequest
  if (
    !r ||
    r.vaultId !== j.vaultId ||
    r.operationId !== j.operationId ||
    r.txid !== j.txid ||
    r.vout !== j.vout ||
    r.reserveCount !== j.reserveCount ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= 0 ||
    !canonicalHex(r.ownerSignature, 64) ||
    !schnorr.verify(
      hex.decode(r.ownerSignature),
      hex.decode(savingsSetupDigest('prepare', prepareFacts(r))),
      hex.decode(guardianRenewalContext(status).ownerPub),
    )
  )
    throw new Error('Saved signer setup authorization changed')
  if (j.plan && j.plan.plan.registerExpireAt !== r.expiresAt) throw new Error('Saved signer setup expiry changed')
  if (
    j.deleteIntent &&
    (typeof j.deleteIntent.proof !== 'string' ||
      !j.deleteIntent.proof ||
      j.deleteIntent.proof.length > 100000 ||
      j.deleteIntent.message !== '{"type":"delete","expire_at":0}')
  )
    throw new Error('Saved signer setup cancellation is invalid')
  if (j.receipt) validateSetupReceipt(j.receipt, j, status)
  return j
}
export function saveSetup(j: SetupJournal) {
  const raw = JSON.stringify(j)
  if (raw.length > 1000000) throw new Error('Signer funding recovery paths are too large to save')
  localStorage.setItem(setupKey(j.vaultId), raw)
  if (localStorage.getItem(setupKey(j.vaultId)) !== raw) throw new Error('Could not save signer funding progress')
  window.dispatchEvent(new Event('vaulted-savings-setup'))
}

export const SETUP_EVENT = 'vaulted-savings-setup'
export function prepareFacts(r: NonNullable<SetupJournal['prepareRequest']>) {
  return {
    vaultId: r.vaultId,
    operationId: r.operationId,
    txid: r.txid,
    vout: r.vout,
    reserveCount: r.reserveCount,
    expiresAt: r.expiresAt,
  }
}
export function clearSetup(j: SetupJournal) {
  // Never remove a newer operation from another observer.
  const raw = localStorage.getItem(setupKey(j.vaultId))
  if (raw && JSON.parse(raw).operationId === j.operationId) {
    localStorage.removeItem(setupKey(j.vaultId))
    window.dispatchEvent(new Event(SETUP_EVENT))
  }
}
export function validateSetupReceipt(r: LightRenewalResponse, j: SetupJournal, status: VaultStatus) {
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
    throw new Error('Signer funding receipt is incomplete')
  const commitment = Transaction.fromPSBT(base64.decode(j.final.commitmentPsbt))
  const node = j.final.vtxoTree.find((n) => n.txid === r.receiverTxid)
  if (commitment.id !== r.commitmentTxid || !node) throw new Error('Signer funding receipt changed')
  const tx = Transaction.fromPSBT(base64.decode(node.tx))
  const output = tx.getOutput(r.receiverVout!)
  if (
    tx.id !== r.receiverTxid ||
    output.amount !== BigInt(j.plan.plan.changeSats) ||
    hex.encode(output.script!) !== guardianRenewalContext(status).scriptPubKey
  )
    throw new Error('Signer funding change does not match this vault')
}
