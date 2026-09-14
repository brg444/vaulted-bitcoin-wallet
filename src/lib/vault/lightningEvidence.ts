import { ArkAddress, P2A, Transaction, matchServerCheckpoints } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { requireExactDefaultTapscriptSignatures } from './taprootSignatures'

/** Durable Lightning evidence that lower layers own: refund attempts with
 * exact signed bytes, and retirement receipts for funded records. The
 * payment owner, the refund lifecycle and archive capture share this module;
 * it depends on nothing wallet-side, so the recovery codec stays independent
 * of the payment coordinator. */

export interface VaultLightningRefundInput {
  txid: string
  vout: number
  value: number | null
}

export interface VaultLightningRefundFacts {
  rfqId: string
  lockupAddress: string
  lockupPkScriptHex: string
  amountSats: number
  destination: string
  vaultId: string
  network: string
  /** X-only enrolled refund signer from the lockup contract. Every signed
   * refund byte is verified against this key, never against keys carried
   * by the bytes themselves. */
  senderPub: string
  /** X-only enrolled Operator signer from the lockup contract. */
  serverPub: string
}

export interface VaultLightningRefundAttempt extends VaultLightningRefundFacts {
  fundedInputs: VaultLightningRefundInput[]
  stage: 'dispatched' | 'submitted' | 'finalized' | 'result'
  signedRefundPsbt?: string
  submittedRefundTxid?: string
  submittedCheckpointPsbts?: string[]
  serverCheckpointPsbts?: string[]
  serverRefundPsbt?: string
  finalCheckpointPsbts?: string[]
  refundArkTxid?: string
  resultAmount?: number
  refundOutputSats?: number
  updatedAt: number
}

export function validateLightningRefundAttempt(value: unknown): VaultLightningRefundAttempt {
  const parsed = value as Partial<VaultLightningRefundAttempt> | null
  if (
    !parsed ||
    typeof parsed.rfqId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.rfqId) ||
    typeof parsed.lockupAddress !== 'string' ||
    typeof parsed.lockupPkScriptHex !== 'string' ||
    !Number.isSafeInteger(parsed.amountSats) ||
    typeof parsed.destination !== 'string' ||
    typeof parsed.vaultId !== 'string' ||
    typeof parsed.network !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.senderPub ?? '') ||
    !/^[0-9a-f]{64}$/.test(parsed.serverPub ?? '') ||
    (parsed.stage !== 'dispatched' &&
      parsed.stage !== 'submitted' &&
      parsed.stage !== 'finalized' &&
      parsed.stage !== 'result') ||
    (parsed.refundArkTxid !== undefined && !/^[0-9a-f]{64}$/.test(parsed.refundArkTxid))
  ) {
    throw new Error('Invalid Lightning refund attempt.')
  }
  if (parsed.stage !== 'dispatched') {
    if (
      !Array.isArray(parsed.fundedInputs) ||
      !parsed.fundedInputs.length ||
      parsed.fundedInputs.some(
        (input) =>
          !input ||
          !/^[0-9a-f]{64}$/.test(input.txid ?? '') ||
          !Number.isSafeInteger(input.vout) ||
          (input.value !== null && input.value !== undefined && !Number.isSafeInteger(input.value)),
      )
    ) {
      throw new Error('Invalid Lightning refund attempt inputs.')
    }
  }
  return parsed as VaultLightningRefundAttempt
}

function attemptKey(rfqId: string): string {
  if (!/^[0-9a-f]{64}$/.test(rfqId)) throw new Error('Lightning RFQ id must be 32 bytes of lowercase hex.')
  return `vaulted-lightning-refund-attempt:${rfqId}`
}

function requireAttemptStore(): Storage {
  if (typeof localStorage === 'undefined') throw new Error('Lightning refund journal storage is unavailable.')
  return localStorage
}

/** Absent returns null; corrupt storage rejects the caller instead of
 * masquerading as absence. */
export function readLightningRefundAttempt(rfqId: string): VaultLightningRefundAttempt | null {
  const store = requireAttemptStore()
  const raw = store.getItem(attemptKey(rfqId))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Lightning refund journal for ${rfqId} is corrupt.`)
  }
  try {
    const attempt = validateLightningRefundAttempt(parsed)
    if (attempt.rfqId !== rfqId) throw new Error('mismatch')
    return attempt
  } catch {
    throw new Error(`Lightning refund journal for ${rfqId} is corrupt.`)
  }
}

/** One monotonic merge for live progress, archive capture and restore.
 * Conflicting identity or signed bytes reject the caller. Defined evidence
 * is retained. The highest phase wins independently of wall-clock stamps. */
export function mergeLightningRefundAttempts(
  previous: VaultLightningRefundAttempt | null,
  incoming: VaultLightningRefundFacts &
    Partial<VaultLightningRefundAttempt> & { stage: VaultLightningRefundAttempt['stage'] },
): VaultLightningRefundAttempt {
  if (previous) {
    if (incoming.rfqId !== undefined && incoming.rfqId !== previous.rfqId) {
      throw new Error('Conflicting Lightning refund restore.')
    }
    assertSameRefundOperation(previous, incoming)
    assertSameRefundEvidence(previous, incoming)
  }
  let stage = incoming.stage
  if (previous && REFUND_STAGE_RANK[previous.stage] > REFUND_STAGE_RANK[stage]) {
    stage = previous.stage
  }
  const defined = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined))
  const incomingUpdatedAt = incoming.updatedAt
  const updatedAt =
    previous && typeof incomingUpdatedAt === 'number'
      ? Math.max(previous.updatedAt, incomingUpdatedAt)
      : typeof incomingUpdatedAt === 'number'
        ? incomingUpdatedAt
        : Math.floor(Date.now() / 1000)
  return { ...(previous ?? {}), ...defined, stage, updatedAt } as VaultLightningRefundAttempt
}

function refundAttemptBody(attempt: VaultLightningRefundAttempt): string {
  return JSON.stringify({ ...attempt, updatedAt: undefined })
}

/** Merge-only persistence: identity facts and signed evidence, once
 * observed, are never overwritten by a later phase. Conflicting identity
 * facts reject the caller; conflicting signed bytes reject the caller;
 * phases advance monotonically so a repeated dispatch can never demote a
 * recorded submission. */
export function recordRefundAttemptProgress(
  facts: VaultLightningRefundFacts & Partial<VaultLightningRefundAttempt>,
  stage: VaultLightningRefundAttempt['stage'],
): void {
  const store = requireAttemptStore()
  const previous = readLightningRefundAttempt(facts.rfqId)
  const merged = mergeLightningRefundAttempts(previous, { ...facts, stage })
  store.setItem(attemptKey(facts.rfqId), JSON.stringify({ ...merged, updatedAt: Math.floor(Date.now() / 1000) }))
}

const REFUND_STAGE_RANK: Record<VaultLightningRefundAttempt['stage'], number> = {
  dispatched: 0,
  submitted: 1,
  finalized: 2,
  result: 3,
}

const REFUND_IDENTITY_FACTS = [
  'lockupAddress',
  'lockupPkScriptHex',
  'amountSats',
  'destination',
  'vaultId',
  'network',
  'senderPub',
  'serverPub',
] as const

function assertSameRefundOperation(
  previous: VaultLightningRefundAttempt,
  facts: VaultLightningRefundFacts & Partial<VaultLightningRefundAttempt>,
): void {
  for (const field of REFUND_IDENTITY_FACTS) {
    if (facts[field] !== undefined && facts[field] !== previous[field]) {
      throw new Error('Lightning refund inputs changed.')
    }
  }
}

/** Signed graph bytes are write-once: a second write carrying different
 * bytes is corruption, never an update. */
function assertSameRefundEvidence(
  previous: VaultLightningRefundAttempt,
  facts: VaultLightningRefundFacts & Partial<VaultLightningRefundAttempt>,
): void {
  const evidenceFields = [
    'fundedInputs',
    'signedRefundPsbt',
    'submittedRefundTxid',
    'submittedCheckpointPsbts',
    'serverCheckpointPsbts',
    'serverRefundPsbt',
    'finalCheckpointPsbts',
    'refundArkTxid',
    'resultAmount',
    'refundOutputSats',
  ] as const
  for (const field of evidenceFields) {
    const incoming = facts[field]
    const retained = previous[field]
    if (incoming === undefined || retained === undefined) continue
    if (JSON.stringify(incoming) !== JSON.stringify(retained)) {
      throw new Error('Lightning refund evidence changed.')
    }
  }
}

/** Seed a restored attempt without downgrading newer local evidence. A
 * corrupt local copy yields to the validated file; an attempt for a
 * different operation never overwrites local evidence and fails closed;
 * storage failures propagate instead of silently dropping the restore.
 * Timestamps never choose the winner: the shared merge keeps the highest
 * phase and every accepted byte. */
export function seedRestoredRefundAttempt(attempt: VaultLightningRefundAttempt): boolean {
  const validated = validateLightningRefundAttempt(attempt)
  const store = requireAttemptStore()
  const raw = store.getItem(attemptKey(validated.rfqId))
  let previous: VaultLightningRefundAttempt | null = null
  if (raw !== null) {
    try {
      previous = validateLightningRefundAttempt(JSON.parse(raw))
    } catch {
      previous = null
    }
  }
  let merged: VaultLightningRefundAttempt
  try {
    merged = mergeLightningRefundAttempts(previous, validated)
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Lightning refund inputs changed.' || error.message === 'Lightning refund evidence changed.')
    ) {
      throw new Error('Conflicting Lightning refund restore.')
    }
    throw error
  }
  if (previous && refundAttemptBody(previous) === refundAttemptBody(merged)) return false
  store.setItem(attemptKey(validated.rfqId), JSON.stringify(merged))
  return true
}

/** Derive the funded input set from signed refund bytes. The transaction id
 * comes from the bytes themselves, so it survives a lost submit response. */
export function refundInputsFromSignedPsbt(signedRefundPsbt: string): {
  txid: string
  inputs: VaultLightningRefundInput[]
} {
  const tx = Transaction.fromPSBT(base64.decode(signedRefundPsbt))
  const inputs: VaultLightningRefundInput[] = []
  for (let index = 0; index < tx.inputsLength; index++) {
    const input = tx.getInput(index)
    const txid = input.txid?.length ? hex.encode(input.txid) : ''
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(input.index)) {
      throw new Error('Lightning refund input is incomplete.')
    }
    const amount = input.witnessUtxo?.amount
    inputs.push({ txid, vout: input.index as number, value: typeof amount === 'bigint' ? Number(amount) : null })
  }
  if (!inputs.length) throw new Error('Lightning refund has no inputs.')
  const seen = new Set(inputs.map((input) => `${input.txid}:${input.vout}`))
  if (seen.size !== inputs.length) throw new Error('Lightning refund inputs are duplicated.')
  return { txid: tx.id, inputs }
}

export function sameRefundInputs(
  left: readonly VaultLightningRefundInput[],
  right: readonly VaultLightningRefundInput[],
): boolean {
  if (left.length !== right.length) return false
  const key = (input: VaultLightningRefundInput) => `${input.txid}:${input.vout}`
  if (new Set(left.map(key)).size !== left.length || new Set(right.map(key)).size !== right.length) return false
  const rightByKey = new Map(right.map((input) => [key(input), input]))
  return left.every((input) => {
    const match = rightByKey.get(key(input))
    if (!match) return false
    if (input.value !== null && match.value !== null && input.value !== match.value) return false
    return true
  })
}

/** Parse the signed refund once: its transaction id and the non-anchor
 * payment total. The unsigned checkpoint sums are not trusted here; the
 * full graph validator binds them to the refund below. */
export function refundPaymentTotal(signedRefundPsbt: string): { txid: string; paymentTotal: number } {
  const refund = Transaction.fromPSBT(base64.decode(signedRefundPsbt))
  let paymentTotal = 0n
  for (let index = 0; index < refund.outputsLength; index++) {
    const output = refund.getOutput(index)
    if (!output || !output.script) throw new Error('Lightning refund output is incomplete.')
    paymentTotal += output.amount ?? 0n
  }
  return { txid: refund.id, paymentTotal: Number(paymentTotal) }
}

function checkpointOutpoint(checkpointPsbt: string): { checkpointId: string; txid: string; vout: number } {
  const checkpoint = Transaction.fromPSBT(base64.decode(checkpointPsbt))
  if (checkpoint.inputsLength !== 1) throw new Error('Lightning refund checkpoint must spend one lockup output.')
  const input = checkpoint.getInput(0)
  const txid = input.txid?.length ? hex.encode(input.txid) : ''
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(input.index)) {
    throw new Error('Lightning refund checkpoint input is incomplete.')
  }
  return { checkpointId: checkpoint.id, txid, vout: input.index as number }
}

function requireUnsignedCheckpoint(checkpointPsbt: string): void {
  const checkpoint = Transaction.fromPSBT(base64.decode(checkpointPsbt))
  for (let index = 0; index < checkpoint.inputsLength; index++) {
    if ((checkpoint.getInput(index).tapScriptSig?.length ?? 0) > 0) {
      throw new Error('Lightning refund checkpoint is already signed.')
    }
  }
}

/** Every input must carry exactly the enrolled signer set, with valid
 * tapscript signatures over the expected leaf: presence alone never
 * suffices, so sender-only, Operator-only and forged bytes each fail
 * outside their own phase. */
export function requireRefundSigners(refundPsbt: string, expectedPubs: string[], label: string): void {
  let parsed: Transaction
  try {
    parsed = Transaction.fromPSBT(base64.decode(refundPsbt))
  } catch {
    throw new Error(`Lightning refund ${label} is not a valid transaction.`)
  }
  if (!parsed.inputsLength) throw new Error(`Lightning refund ${label} has no inputs.`)
  for (let index = 0; index < parsed.inputsLength; index++) {
    try {
      requireExactDefaultTapscriptSignatures(parsed, index, expectedPubs)
    } catch {
      throw new Error(`Lightning refund ${label} has an invalid signer.`)
    }
  }
}

/** Two serializations of one checkpoint: identical version, locktime,
 * transaction id, inputs and outputs, differing only in signature fields.
 * Callers pair by transaction id, matching the SDK, so a reordered Operator
 * response is accepted and a re-cut checkpoint is not. */
export function sameCheckpointGraph(unsignedPsbt: string, signedPsbt: string): boolean {
  let unsigned: Transaction
  let signed: Transaction
  try {
    unsigned = Transaction.fromPSBT(base64.decode(unsignedPsbt))
    signed = Transaction.fromPSBT(base64.decode(signedPsbt))
  } catch {
    return false
  }
  if (unsigned.id !== signed.id) return false
  if (unsigned.version !== signed.version || unsigned.lockTime !== signed.lockTime) return false
  if (
    unsigned.inputsLength !== signed.inputsLength ||
    unsigned.outputsLength !== signed.outputsLength ||
    unsigned.outputsLength === 0
  ) {
    return false
  }
  for (let index = 0; index < unsigned.inputsLength; index++) {
    const a = unsigned.getInput(index)
    const b = signed.getInput(index)
    const aTxid = a.txid?.length ? hex.encode(a.txid) : ''
    const bTxid = b.txid?.length ? hex.encode(b.txid) : ''
    if (aTxid !== bTxid || a.index !== b.index) return false
    const aSequence = (a as { sequence?: unknown }).sequence
    const bSequence = (b as { sequence?: unknown }).sequence
    if (aSequence !== undefined && bSequence !== undefined && aSequence !== bSequence) return false
  }
  for (let index = 0; index < unsigned.outputsLength; index++) {
    const a = unsigned.getOutput(index)
    const b = signed.getOutput(index)
    if (!a || !b || !a.script || !b.script) return false
    if (hex.encode(a.script) !== hex.encode(b.script)) return false
    if ((a.amount ?? 0n) !== (b.amount ?? 0n)) return false
  }
  return true
}

function pairCheckpointPsbts(unsignedPsbts: readonly string[], signedPsbts: readonly string[], label: string): void {
  if (unsignedPsbts.length !== signedPsbts.length) {
    throw new Error(`${label} are incomplete.`)
  }
  const unsignedTxs = unsignedPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)))
  let pairs: ReturnType<typeof matchServerCheckpoints>
  try {
    pairs = matchServerCheckpoints([...signedPsbts], unsignedTxs, label)
  } catch {
    throw new Error(`${label} changed inputs.`)
  }
  for (const { server, local } of pairs) {
    if (!sameCheckpointGraph(base64.encode(local.toPSBT()), base64.encode(server.toPSBT()))) {
      throw new Error(`${label} changed inputs.`)
    }
  }
}

/** Bind every recorded byte of an attempt to one package graph, with
 * signer keys from the enrolled lockup contract. The checkpoint set must
 * spend exactly the funded lockup outpoints, the signed refund must spend
 * exactly those checkpoint outputs at index 0 and pay the recorded
 * destination from exactly one payment output beside the SDK zero-value
 * P2A anchor, the Operator successor must be that same transaction, and
 * each stage must carry the evidence its phase requires. The pre-submit
 * refund carries the sender alone, Operator checkpoints carry the Operator
 * alone, and the successor and finals carry both; forged, wrong-set and
 * missing signatures fail closed. Shape validation stays in
 * `validateLightningRefundAttempt` so journal reads never depend on graph
 * parsing; capture, restore and resume call this explicitly. */
export function validateLightningRefundGraph(attempt: VaultLightningRefundAttempt): void {
  validateLightningRefundAttempt(attempt)
  if (attempt.stage === 'dispatched') {
    if (attempt.signedRefundPsbt !== undefined || attempt.submittedCheckpointPsbts !== undefined) {
      throw new Error('Lightning refund dispatch must not carry signed bytes.')
    }
    return
  }
  if (
    !attempt.signedRefundPsbt ||
    !/^[0-9a-f]{64}$/.test(attempt.submittedRefundTxid ?? '') ||
    !Array.isArray(attempt.submittedCheckpointPsbts) ||
    !attempt.submittedCheckpointPsbts.length ||
    !Array.isArray(attempt.fundedInputs) ||
    !attempt.fundedInputs.length
  ) {
    throw new Error('Lightning refund submission evidence is incomplete.')
  }
  const { refundOutputSats } = attempt
  if (typeof refundOutputSats !== 'number' || !Number.isSafeInteger(refundOutputSats)) {
    throw new Error('Lightning refund submission evidence is incomplete.')
  }
  const sender = attempt.senderPub
  const server = attempt.serverPub
  const refund = Transaction.fromPSBT(base64.decode(attempt.signedRefundPsbt))
  if (refund.id !== attempt.submittedRefundTxid) throw new Error('Lightning refund transaction changed.')
  // The checkpoints spend the original lockup outpoints, exactly and once.
  const checkpointOutpoints = attempt.submittedCheckpointPsbts.map((raw) => {
    requireUnsignedCheckpoint(raw)
    return checkpointOutpoint(raw)
  })
  const spentLockups = checkpointOutpoints.map(({ txid, vout }) => ({ txid, vout, value: null }))
  if (!sameRefundInputs(spentLockups, attempt.fundedInputs)) {
    throw new Error('Lightning refund checkpoints do not spend the funded inputs.')
  }
  // The signed refund spends every checkpoint output at index 0 and nothing
  // else, with each input's witness bound to that checkpoint output's exact
  // script and value.
  if (refund.inputsLength !== checkpointOutpoints.length) {
    throw new Error('Lightning refund does not spend every checkpoint.')
  }
  const checkpointOutputs = new Map(
    attempt.submittedCheckpointPsbts.map((raw, position) => {
      const checkpoint = Transaction.fromPSBT(base64.decode(raw))
      const output = checkpoint.getOutput(0)
      if (!output || !output.script) throw new Error('Lightning refund checkpoint output is incomplete.')
      return [
        checkpointOutpoints[position].checkpointId,
        { scriptHex: hex.encode(output.script), amount: output.amount ?? 0n },
      ]
    }),
  )
  for (let index = 0; index < refund.inputsLength; index++) {
    const input = refund.getInput(index)
    const txid = input.txid?.length ? hex.encode(input.txid) : ''
    const expected = checkpointOutputs.get(txid)
    if (input.index !== 0 || !expected) {
      throw new Error('Lightning refund input is not a checkpoint output.')
    }
    const witness = input.witnessUtxo as { script?: Uint8Array; amount?: bigint } | undefined
    if (
      !witness?.script ||
      hex.encode(witness.script) !== expected.scriptHex ||
      (witness.amount ?? 0n) !== expected.amount
    ) {
      throw new Error('Lightning refund input does not bind its checkpoint output.')
    }
  }
  requireRefundSigners(attempt.signedRefundPsbt, [sender], 'refund')
  // Exactly one payment output to the recorded destination beside the SDK
  // zero-value P2A anchor: extra outputs would hide diverted value.
  const anchorScriptHex = hex.encode(P2A.script)
  let destinationScriptHex: string
  try {
    destinationScriptHex = hex.encode(ArkAddress.decode(attempt.destination).pkScript)
  } catch {
    throw new Error('Lightning refund destination is not a valid address.')
  }
  if (refund.outputsLength !== 2) throw new Error('Lightning refund must carry one payment and one anchor.')
  let destinationPaid = false
  let paymentTotal = 0n
  let anchors = 0
  for (let index = 0; index < refund.outputsLength; index++) {
    const output = refund.getOutput(index)
    if (!output || !output.script) throw new Error('Lightning refund output is incomplete.')
    const scriptHex = hex.encode(output.script)
    if (scriptHex === anchorScriptHex) {
      if (output.amount !== P2A.amount) throw new Error('Lightning refund anchor is not zero-value.')
      anchors++
      continue
    }
    if (scriptHex === destinationScriptHex) destinationPaid = true
    paymentTotal += output.amount ?? 0n
  }
  if (anchors !== 1) throw new Error('Lightning refund must carry exactly one P2A anchor.')
  if (!destinationPaid) throw new Error('Lightning refund does not pay its destination.')
  if (paymentTotal !== BigInt(refundOutputSats)) {
    throw new Error('Lightning refund output does not match its funded inputs.')
  }
  const fundedTotal = attempt.fundedInputs.every((input) => typeof input.value === 'number')
    ? attempt.fundedInputs.reduce((total, input) => total + BigInt(input.value ?? 0), 0n)
    : null
  if (fundedTotal !== null && paymentTotal !== fundedTotal) {
    throw new Error('Lightning refund output does not match its funded inputs.')
  }
  // The Operator successor is the same transaction, never a replacement,
  // and every Operator and final checkpoint is a signature over its
  // recorded unsigned twin, never a re-cut transaction.
  const hasServerResponse = (attempt.serverCheckpointPsbts?.length ?? 0) > 0 || attempt.serverRefundPsbt !== undefined
  const completeResponse = attempt.stage === 'finalized' || attempt.stage === 'result'
  if (completeResponse && !hasServerResponse) {
    throw new Error('Lightning refund Operator response is incomplete.')
  }
  if (hasServerResponse) {
    if (!attempt.serverCheckpointPsbts?.length || !attempt.serverRefundPsbt) {
      throw new Error('Lightning refund Operator response is incomplete.')
    }
    const serverRefund = Transaction.fromPSBT(base64.decode(attempt.serverRefundPsbt))
    if (serverRefund.id !== refund.id) throw new Error('Lightning refund Operator response changed the transaction.')
    requireRefundSigners(attempt.serverRefundPsbt, [sender, server], 'Operator successor')
    if (attempt.serverCheckpointPsbts.length !== checkpointOutpoints.length) {
      throw new Error('Lightning refund Operator checkpoints are incomplete.')
    }
    attempt.serverCheckpointPsbts.forEach((raw) => {
      requireRefundSigners(raw, [server], 'Operator checkpoint')
    })
    pairCheckpointPsbts(
      attempt.submittedCheckpointPsbts!,
      attempt.serverCheckpointPsbts,
      'Lightning refund Operator checkpoint',
    )
  }
  if (completeResponse) {
    if (!attempt.finalCheckpointPsbts?.length) throw new Error('Lightning refund final evidence is incomplete.')
    if (attempt.finalCheckpointPsbts.length !== checkpointOutpoints.length) {
      throw new Error('Lightning refund final checkpoints are incomplete.')
    }
    attempt.finalCheckpointPsbts.forEach((raw) => {
      requireRefundSigners(raw, [sender, server], 'final checkpoint')
    })
    pairCheckpointPsbts(
      attempt.submittedCheckpointPsbts!,
      attempt.finalCheckpointPsbts,
      'Lightning refund final checkpoint',
    )
  }
  if (attempt.stage === 'result') {
    if (attempt.refundArkTxid !== refund.id) throw new Error('Lightning refund transaction changed.')
    if (!Number.isSafeInteger(attempt.resultAmount)) throw new Error('Lightning refund result amount is invalid.')
  }
}

/** Validate final checkpoints against their recorded unsigned twins with
 * the enrolled signer set, before release. Without recorded twins only the
 * signer set is enforced; callers with twins always pass them. */
export function validateLightningRefundFinals(
  unsignedCheckpointPsbts: readonly string[] | undefined,
  finalCheckpointPsbts: readonly string[],
  senderPub: string,
  serverPub: string,
): void {
  if (!finalCheckpointPsbts.length) throw new Error('Lightning refund final checkpoints are incomplete.')
  if (unsignedCheckpointPsbts?.length && unsignedCheckpointPsbts.length !== finalCheckpointPsbts.length) {
    throw new Error('Lightning refund final checkpoints are incomplete.')
  }
  finalCheckpointPsbts.forEach((raw) => {
    requireRefundSigners(raw, [senderPub, serverPub], 'final checkpoint')
  })
  if (unsignedCheckpointPsbts?.length) {
    pairCheckpointPsbts(unsignedCheckpointPsbts, finalCheckpointPsbts, 'Lightning refund final checkpoint')
  }
}

/** Retirement receipt for a funded Lightning record. The package may prune
 * the record only while every field still matches; a rewritten record, a
 * different vault or network, or a partial failure keeps it withheld. */
export interface VaultLightningRetiredFunding {
  rfqId: string
  lockupAddress: string
  amountSats: number
  fundingArkTxid: string
  refundArkTxid?: string
  state: string
  fileDigest: string
  network: string
  vaultId: string
  retiredAt: number
}

function retiredFundingKey(rfqId: string): string {
  if (!/^[0-9a-f]{64}$/.test(rfqId)) throw new Error('Lightning RFQ id must be 32 bytes of lowercase hex.')
  return `vaulted-lightning-retired-funding:${rfqId}`
}

export function readRetiredLightningFunding(rfqId: string): VaultLightningRetiredFunding | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const parsed = JSON.parse(
      localStorage.getItem(retiredFundingKey(rfqId)) || 'null',
    ) as Partial<VaultLightningRetiredFunding> | null
    if (
      !parsed ||
      parsed.rfqId !== rfqId ||
      typeof parsed.lockupAddress !== 'string' ||
      !Number.isSafeInteger(parsed.amountSats) ||
      !/^[0-9a-f]{64}$/.test(String(parsed.fundingArkTxid || '')) ||
      (parsed.refundArkTxid !== undefined && !/^[0-9a-f]{64}$/.test(parsed.refundArkTxid)) ||
      typeof parsed.state !== 'string' ||
      typeof parsed.fileDigest !== 'string' ||
      typeof parsed.network !== 'string' ||
      typeof parsed.vaultId !== 'string'
    ) {
      return null
    }
    return parsed as VaultLightningRetiredFunding
  } catch {
    return null
  }
}

/** Backwards-compatible read of the acknowledgment marker as a receipt. */
export function readLightningRecoveryAcknowledgment(rfqId: string): VaultLightningRetiredFunding | null {
  return readRetiredLightningFunding(rfqId)
}

export function writeRetiredLightningFunding(receipt: VaultLightningRetiredFunding): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(retiredFundingKey(receipt.rfqId), JSON.stringify(receipt))
}

/** Retirement receipt for a settled Lightning receive. It carries the history
 * facts and the exact identity binding so the operational journal can be
 * removed while the labeled history row and the archived recovery bytes
 * survive. The preimage stays solely in the archived record. */
export interface VaultLightningRetiredReceive {
  rfqId: string
  claimArkTxid: string
  lockupAddress: string
  lockupPkScriptHex: string
  amountSats: number
  displayAmount: number
  fee: number
  payoutAddress: string
  payoutPkScriptHex: string
  state: string
  createdAt: number
  network: string
  vaultId: string
  descriptorHash: string
  fileDigest: string
  retiredAt: number
}

const RETIRED_RECEIVE_PREFIX = 'vaulted-lightning-retired-receive:'
const RETIRED_RECEIVE_NETWORKS = new Set(['mainnet', 'mutinynet'])

function retiredReceiveKey(rfqId: string): string {
  if (!/^[0-9a-f]{64}$/.test(rfqId)) throw new Error('Lightning RFQ id must be 32 bytes of lowercase hex.')
  return `${RETIRED_RECEIVE_PREFIX}${rfqId}`
}

const isDigestHex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isScriptHex = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 40000 &&
  value.length % 2 === 0 &&
  /^[0-9a-f]+$/.test(value)

function validateRetiredReceive(parsed: unknown): VaultLightningRetiredReceive | null {
  const value = parsed as Partial<VaultLightningRetiredReceive> | null
  if (
    !value ||
    !isDigestHex(value.rfqId) ||
    !isDigestHex(value.claimArkTxid) ||
    typeof value.lockupAddress !== 'string' ||
    !value.lockupAddress ||
    !isScriptHex(value.lockupPkScriptHex) ||
    !Number.isSafeInteger(value.amountSats) ||
    (value.amountSats as number) <= 0 ||
    !Number.isSafeInteger(value.displayAmount) ||
    (value.displayAmount as number) <= 0 ||
    !Number.isSafeInteger(value.fee) ||
    (value.fee as number) < 0 ||
    typeof value.payoutAddress !== 'string' ||
    !value.payoutAddress ||
    !isScriptHex(value.payoutPkScriptHex) ||
    value.state !== 'settled' ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    typeof value.network !== 'string' ||
    !RETIRED_RECEIVE_NETWORKS.has(value.network) ||
    typeof value.vaultId !== 'string' ||
    !value.vaultId ||
    !isDigestHex(value.descriptorHash) ||
    !isDigestHex(value.fileDigest) ||
    !Number.isSafeInteger(value.retiredAt) ||
    (value.retiredAt as number) < (value.createdAt as number)
  )
    return null
  return value as VaultLightningRetiredReceive
}

/** Reads only the key derived from the requested rfqId and rejects a stored
 * record whose embedded rfqId differs from that key. */
export function readRetiredLightningReceive(rfqId: string): VaultLightningRetiredReceive | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const receipt = validateRetiredReceive(JSON.parse(localStorage.getItem(retiredReceiveKey(rfqId)) || 'null'))
    if (!receipt || receipt.rfqId !== rfqId) return null
    return receipt
  } catch {
    return null
  }
}

/** Write first, then read back. A receipt that fails to land throws so the
 * owner keeps the journal instead of deleting its only local copy. */
export function writeRetiredLightningReceive(receipt: VaultLightningRetiredReceive): void {
  if (typeof localStorage === 'undefined') throw new Error('Lightning receive receipt storage is unavailable.')
  const key = retiredReceiveKey(receipt.rfqId)
  localStorage.setItem(key, JSON.stringify(receipt))
  const readback = validateRetiredReceive(JSON.parse(localStorage.getItem(key) || 'null'))
  if (!readback || JSON.stringify(readback) !== JSON.stringify(receipt))
    throw new Error('Lightning receive retirement receipt did not persist.')
}

/** Enumerate device-local receipts for exactly one vault and network. A stored
 * record counts only when its key equals its own derived key, so an entry
 * under an arbitrary suffix cannot masquerade as a receipt. */
export function listRetiredLightningReceiveReceipts(scope: {
  vaultId: string
  network: string
}): VaultLightningRetiredReceive[] {
  if (typeof localStorage === 'undefined') return []
  const out: VaultLightningRetiredReceive[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith(RETIRED_RECEIVE_PREFIX)) continue
    let receipt: VaultLightningRetiredReceive | null
    try {
      receipt = validateRetiredReceive(JSON.parse(localStorage.getItem(key) || 'null'))
    } catch {
      continue
    }
    if (!receipt || key !== retiredReceiveKey(receipt.rfqId)) continue
    if (receipt.vaultId !== scope.vaultId || receipt.network !== scope.network) continue
    out.push(receipt)
  }
  return out
}
