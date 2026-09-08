import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, requireLowerHex } from '../hex'

export const ROLLING_PROGRAM = 'vault-allowance-rolling-v1'
export const ROLLING_WINDOW_SECONDS = 86_400
export const HISTORY_DEPTH = 31
export const MAX_SEQUENCE = 2_147_483_647
export const MAX_BUDGET = 1_000_000_000
const branchTag = 'VaultRollingBranch/v1'
const utf8 = new TextEncoder()

export interface RollingState {
  remaining: number
  sequence: number
  root: string
}

export interface RollingDebit {
  sequence: number
  amount: number
  parentTxid: string
  parentIndex: number
}

export interface RollingParameters {
  /** Serialized genesis hash bytes, matching the canonical descriptor. */
  networkGenesis: string
  /** Display-order transaction ID, converted to wire order when encoded. */
  controllerTxid: string
  controllerIndex: number
  budget: number
  recipientCap: number
  feeCap: number
  renewalWindow: number
  feerateCap: number
  delegatePubkey: string
  receiptKey: string
  checkpointExit: string
}

export interface RollingReceipt {
  domain: string
  debit: RollingDebit
  observedAt: number
  signature: string
}

export type HistoryProof = readonly string[]

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint64(value: number): Uint8Array<ArrayBuffer> {
  integer(value, 0, Number.MAX_SAFE_INTEGER, 'uint64')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true)
  return out
}

function readUint64(raw: Uint8Array, offset: number): number {
  const n = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(offset, true)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe integer encoding')
  return Number(n)
}

function hashBytes(value: string, name: string): Uint8Array<ArrayBuffer> {
  return hexToBytes(requireLowerHex(value, name, 32))
}

function wireTxid(value: string): Uint8Array<ArrayBuffer> {
  return hashBytes(value, 'transaction ID').reverse()
}

export function encodeRollingState(state: RollingState): Uint8Array {
  integer(state.remaining, 0, MAX_BUDGET, 'remaining allowance')
  integer(state.sequence, 0, MAX_SEQUENCE, 'sequence')
  return concat(
    utf8.encode('VR01'),
    uint64(state.remaining),
    uint64(state.sequence),
    hashBytes(state.root, 'history root'),
  )
}

export function decodeRollingState(raw: Uint8Array): RollingState {
  if (raw.length !== 52 || bytesToHex(raw.slice(0, 4)) !== '56523031') throw new Error('Invalid rolling state encoding')
  const state = { remaining: readUint64(raw, 4), sequence: readUint64(raw, 12), root: bytesToHex(raw.slice(20)) }
  encodeRollingState(state)
  return state
}

export function encodeDebit(debit: RollingDebit): Uint8Array {
  integer(debit.sequence, 0, MAX_SEQUENCE - 1, 'debit sequence')
  integer(debit.amount, 1, MAX_BUDGET, 'debit amount')
  integer(debit.parentIndex, 0, 0, 'controller index')
  const parent = wireTxid(debit.parentTxid)
  if (parent.every((n) => n === 0)) throw new Error('Missing controller transaction')
  return concat(uint64(debit.sequence), uint64(debit.amount), parent, new Uint8Array(4))
}

export function decodeDebit(raw: Uint8Array): RollingDebit {
  if (raw.length !== 52) throw new Error('Invalid debit encoding')
  const debit = {
    sequence: readUint64(raw, 0),
    amount: readUint64(raw, 8),
    parentTxid: bytesToHex(raw.slice(16, 48).reverse()),
    parentIndex: new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(48, true),
  }
  encodeDebit(debit)
  return debit
}

function branch(left: string, right: string): string {
  const nodes = left < right ? [left, right] : [right, left]
  return bytesToHex(schnorr.utils.taggedHash(branchTag, ...nodes.map((n) => hashBytes(n, 'branch node'))))
}

export function debitLeaf(debit: RollingDebit): string {
  return bytesToHex(sha256(concat(new Uint8Array([1]), encodeDebit(debit))))
}

export function emptyRoots(): string[] {
  const roots = [bytesToHex(sha256(new Uint8Array([0])))]
  for (let i = 0; i < HISTORY_DEPTH; i++) roots.push(branch(roots[i], roots[i]))
  return roots
}

export function initialRollingState(budget: number): RollingState {
  integer(budget, 330, MAX_BUDGET, 'budget')
  return { remaining: budget, sequence: 0, root: emptyRoots()[HISTORY_DEPTH] }
}

export function historyRoot(proof: HistoryProof, leaf: string): string {
  if (proof.length !== HISTORY_DEPTH) throw new Error('Invalid history proof depth')
  hashBytes(leaf, 'history leaf')
  return proof.reduce((node, sibling) => branch(node, sibling), leaf)
}

/** Siblings use deterministic sequence positions; the VM hashes sorted children. */
export function buildHistoryProof(debits: readonly RollingDebit[], index: number): { proof: string[]; root: string } {
  integer(index, 0, MAX_SEQUENCE - 1, 'proof index')
  let nodes = new Map<number, string>()
  for (const debit of debits) {
    if (nodes.has(debit.sequence)) throw new Error('Duplicate debit sequence')
    nodes.set(debit.sequence, debitLeaf(debit))
  }
  const empty = emptyRoots()
  const proof = []
  for (let depth = 0; depth < HISTORY_DEPTH; depth++) {
    proof.push(nodes.get(index ^ 1) ?? empty[depth])
    const next = new Map<number, string>()
    for (const key of nodes.keys()) {
      next.set(Math.floor(key / 2), branch(nodes.get(key & ~1) ?? empty[depth], nodes.get(key | 1) ?? empty[depth]))
    }
    nodes = next
    index = Math.floor(index / 2)
  }
  return { proof, root: nodes.get(0) ?? empty[HISTORY_DEPTH] }
}

export function historyWitness(proof: HistoryProof): Uint8Array[] {
  if (proof.length !== HISTORY_DEPTH) throw new Error('Invalid history proof depth')
  const nodes = proof.map((n) => hashBytes(n, 'history sibling'))
  return [concat(...nodes.slice(16)), concat(...nodes.slice(0, 16))]
}

export function verifyRollingHistory(state: RollingState, debits: readonly RollingDebit[], budget: number): void {
  encodeRollingState(state)
  integer(budget, 330, MAX_BUDGET, 'budget')
  let charged = 0
  for (const debit of debits) {
    if (debit.sequence >= state.sequence) throw new Error('Debit is ahead of controller sequence')
    encodeDebit(debit)
    charged += debit.amount
    integer(charged, 0, budget, 'outstanding allowance')
  }
  const { root } = buildHistoryProof(debits, Math.min(state.sequence, MAX_SEQUENCE - 1))
  if (root !== state.root || state.remaining !== budget - charged) throw new Error('Controller history mismatch')
}

export function applyDebit(
  state: RollingState,
  budget: number,
  debit: RollingDebit,
  proof: HistoryProof,
): RollingState {
  encodeRollingState(state)
  integer(budget, 330, MAX_BUDGET, 'budget')
  const leaf = debitLeaf(debit)
  if (state.remaining > budget || state.sequence !== debit.sequence || state.remaining < debit.amount) {
    throw new Error('Debit exceeds allowance or sequence')
  }
  if (historyRoot(proof, emptyRoots()[0]) !== state.root) throw new Error('Occupied or invalid history slot')
  return { remaining: state.remaining - debit.amount, sequence: state.sequence + 1, root: historyRoot(proof, leaf) }
}

export function receiptDomain(p: RollingParameters): string {
  integer(p.budget, 330, MAX_BUDGET, 'budget')
  integer(p.recipientCap, 330, p.budget, 'recipient cap')
  integer(p.feeCap, 0, 100_000, 'fee cap')
  integer(p.renewalWindow, 1, 30 * 86_400, 'renewal window')
  integer(p.feerateCap, 1, 100, 'feerate cap')
  integer(p.controllerIndex, 0, 65_535, 'asset index')
  const index = new Uint8Array(2)
  new DataView(index.buffer).setUint16(0, p.controllerIndex, true)
  const genesis = hashBytes(p.networkGenesis, 'network genesis')
  const controller = wireTxid(p.controllerTxid)
  if (genesis.every((n) => n === 0) || controller.every((n) => n === 0))
    throw new Error('Missing network or controller')
  const delegate = hexToBytes(requireLowerHex(p.delegatePubkey, 'delegate key', 33))
  secp256k1.Point.fromHex(bytesToHex(delegate))
  const receiptKey = hashBytes(p.receiptKey, 'receipt key')
  secp256k1.Point.fromHex(`02${p.receiptKey}`)
  const checkpoint = hexToBytes(requireLowerHex(p.checkpointExit, 'checkpoint exit'))
  return bytesToHex(
    sha256(
      concat(
        utf8.encode(`${ROLLING_PROGRAM}\0finalization\0`),
        genesis,
        controller,
        index,
        ...[p.budget, p.recipientCap, p.feeCap, p.renewalWindow, ROLLING_WINDOW_SECONDS, p.feerateCap].map(uint64),
        delegate,
        receiptKey,
        sha256(checkpoint),
      ),
    ),
  )
}

export function receiptMessage(receipt: RollingReceipt): Uint8Array {
  integer(receipt.observedAt, 1, 100_000_000_000, 'finalization observation')
  const domain = hashBytes(receipt.domain, 'receipt domain')
  if (domain.every((n) => n === 0)) throw new Error('Missing receipt domain')
  return concat(domain, encodeDebit(receipt.debit), uint64(receipt.observedAt))
}

/** Local maturity checks are advisory; the Emulator enforces its own clock. */
export function verifyMatureReceipt(receipt: RollingReceipt, p: RollingParameters, now: number): void {
  integer(now, 0, Number.MAX_SAFE_INTEGER, 'current time')
  const message = receiptMessage(receipt)
  if (receipt.domain !== receiptDomain(p) || now <= receipt.observedAt + ROLLING_WINDOW_SECONDS) {
    throw new Error('Receipt domain or maturity mismatch')
  }
  const signature = hexToBytes(requireLowerHex(receipt.signature, 'receipt signature', 64))
  if (!schnorr.verify(signature, sha256(message), hashBytes(p.receiptKey, 'receipt key')))
    throw new Error('Invalid receipt signature')
}

/** A debit remains in the committed history until a credit transaction finalizes. */
export function applyMatureCredit(
  state: RollingState,
  p: RollingParameters,
  receipt: RollingReceipt,
  proof: HistoryProof,
  now: number,
): RollingState {
  encodeRollingState(state)
  verifyMatureReceipt(receipt, p, now)
  const debit = receipt.debit
  if (debit.sequence >= state.sequence || state.remaining > p.budget || debit.amount > p.budget - state.remaining) {
    throw new Error('Credit exceeds allowance or sequence')
  }
  if (historyRoot(proof, debitLeaf(debit)) !== state.root) throw new Error('Debit absent or already credited')
  return {
    remaining: state.remaining + debit.amount,
    sequence: state.sequence,
    root: historyRoot(proof, emptyRoots()[0]),
  }
}
