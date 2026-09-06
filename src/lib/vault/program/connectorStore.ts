import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { browserVaultLockManager, requireVaultLockManager, type VaultLockManager } from '../vtxo/lock'
import { prepareConnectorPayment } from './connectorPayment'
import { connectorEnrollmentDigest, type ConnectorOrigin } from './connector'

const OPTIONS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true } as const

// Durable approval/handoff state for one Savings connector withdrawal. This is
// the wallet side of the signing order: the exact candidate is persisted BEFORE
// any signing request is issued, and the same candidate is restored after
// reload, timeout, cancel, or device disconnect.
//
// Trust model (wallet consistency only — NOT server replay protection):
// - Every call binds to an independently supplied enrollment identity
//   (vault id + enrollment digest from the local enrollment pin). Stored state
//   is never self-authenticating: transplanting a valid record under another
//   vault key or substituting a different enrolled contract fails against
//   the independent pin.
// - The enrollment pin binds the enrolled CONTRACT (keys, scripts, policy,
//   origin). It does NOT bind a per-payment recipient/amount: swapping the
//   whole stored record for another legitimate payment under the same
//   enrollment yields a different candidate identity (see below). Detecting
//   that swap without an independently held candidate identity or an
//   authoritative server record is out of scope here; the authenticated Guardian operation and
//   chain reconciliation own that boundary.
// - Mutations additionally bind to the exact candidate identity (the unsigned
//   transaction txid returned by prepare/load). A stale callback for a
//   cancelled operation A cannot mark or cancel a newly prepared operation B
//   in the same vault: the txid check under the lock rejects it.
// - Every read/check/write runs under a per-vault shared exclusive Web Lock,
//   so separate tabs or coordinator instances cannot interleave a stale
//   read with a mutation. Arguments are snapshotted before lock acquisition,
//   so mutating a queued call's inputs cannot redirect it. The lock is
//   required; callers inject a manager for tests and the browser supplies
//   `navigator.locks` in production.
// - Cancellation racing with signature dispatch must not release a signed
//   candidate: only a prepared-but-never-signed operation can be cancelled.
//   Once signatures may have issued, ownership is retained until chain
//   reconciliation proves confirmation or a confirmed conflicting spend.
export const CONNECTOR_STORE_KEY = 'arkade-vault-connector-v1-pending-v1'
const CONNECTOR_STORE_VERSION = 1

type ConnectorContract = Parameters<typeof connectorEnrollmentDigest>[0]

export interface ConnectorExpectedIdentity {
  vaultId: string
  enrollmentDigest: string
}

export interface ConnectorStoredOrigin {
  publicKey: string
  fingerprint: number
  path: number[]
}

export interface ConnectorStoredCoin {
  parentHex: string
  txid: string
  vout: number
}

export interface ConnectorPendingInput {
  contract: ConnectorContract
  origin: ConnectorStoredOrigin
  savings: ConnectorStoredCoin
  reserve: ConnectorStoredCoin
  recipient: string
  amountSats: number
  feeSats: number
}

export interface ConnectorPendingRecord extends ConnectorPendingInput {
  operationId?: string
  version: number
  enrollmentDigest: string
  candidatePsbt: string
  signaturesMayHaveIssued: boolean
  phoneSignedPsbt?: string
  savingsWitness?: string[]
  signedTxHex?: string
  txid?: string
}

export type ConnectorOperationPhase = 'prepared' | 'signing' | 'signed'

export function connectorLockName(vaultId: string): string {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  return `arkade-vault-connector:${id}`
}

// Storage keys derive directly from the full validated vault id. Vault ids
// are opaque: nothing here splits on ':' (lock names are composite, storage
// keys are not).
export function connectorStoreKey(vaultId: string): string {
  const id = vaultId.trim()
  if (!id) throw new Error('vault id required')
  return `${CONNECTOR_STORE_KEY}:${id}`
}

export async function withConnectorLock<T>(
  vaultId: string,
  run: () => Promise<T> | T,
  locks: VaultLockManager | null | undefined = browserVaultLockManager(),
): Promise<T> {
  return requireVaultLockManager(locks).request(connectorLockName(vaultId), { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error('Web Locks API returned no exclusive connector lock')
    return run()
  })
}

function toOrigin(origin: ConnectorStoredOrigin): ConnectorOrigin {
  return { publicKey: hex.decode(origin.publicKey), fingerprint: origin.fingerprint, path: [...origin.path] }
}

function isRecordShape(value: unknown): value is ConnectorPendingRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === CONNECTOR_STORE_VERSION &&
    typeof record.enrollmentDigest === 'string' &&
    typeof record.candidatePsbt === 'string' &&
    typeof record.signaturesMayHaveIssued === 'boolean' &&
    (record.phoneSignedPsbt === undefined || typeof record.phoneSignedPsbt === 'string') &&
    (record.operationId === undefined ||
      (typeof record.operationId === 'string' && /^[0-9a-f]{32}$/.test(record.operationId))) &&
    typeof record.recipient === 'string' &&
    Number.isSafeInteger(record.amountSats) &&
    Number.isSafeInteger(record.feeSats) &&
    !!record.contract &&
    typeof (record.contract as { vaultId?: unknown }).vaultId === 'string' &&
    !!record.origin &&
    !!record.savings &&
    !!record.reserve &&
    (record.savingsWitness === undefined || Array.isArray(record.savingsWitness)) &&
    (record.signedTxHex === undefined || typeof record.signedTxHex === 'string') &&
    (record.txid === undefined || typeof record.txid === 'string')
  )
}

// Snapshot a queued call's arguments BEFORE lock acquisition. The lock name is
// fixed from the snapshotted vault id and the callback closes only over
// immutable snapshot values, so mutating the caller's objects while queued
// cannot redirect the operation to another vault or payment.
function snapshotIdentity(expected: ConnectorExpectedIdentity): ConnectorExpectedIdentity {
  return { vaultId: expected.vaultId.trim(), enrollmentDigest: expected.enrollmentDigest }
}

function snapshotInput(input: ConnectorPendingInput): ConnectorPendingInput {
  return JSON.parse(JSON.stringify(input)) as ConnectorPendingInput
}

function snapshotStrings(values: string[]): string[] {
  return [...values]
}

function requireCandidateTxid(candidateTxid: string): string {
  if (!/^[0-9a-f]{64}$/i.test(candidateTxid)) throw new Error('connector candidate identity required')
  return candidateTxid.toLowerCase()
}

// Rebuild the live payment handle from a stored record and prove it against
// the INDEPENDENTLY supplied enrollment identity. The persisted candidate is
// the pristine `prepareConnectorPayment` PSBT, so its FULL canonical bytes
// must match the rebuild — tampered prevout/derivation/sighash/partial-sig
// metadata never becomes the signing request on reload. Throws fail-closed on
// vault mismatch, pin mismatch, any candidate byte mismatch, invalid saved
// witness, or a signed transaction that does not re-derive from the stored
// artifacts. Returns the freshly rebuilt handle (retained request wins over
// stored metadata) and the candidate identity (unsigned-tx txid).
function validatedRecord(expected: ConnectorExpectedIdentity, raw: unknown) {
  const vaultId = expected.vaultId.trim()
  if (!vaultId) throw new Error('vault id required')
  if (!/^[0-9a-f]{64}$/i.test(expected.enrollmentDigest)) throw new Error('connector enrollment pin required')
  if (!isRecordShape(raw)) throw new Error('corrupt connector operation')
  const record = raw as ConnectorPendingRecord
  if (record.contract.vaultId !== vaultId) throw new Error('connector vault identity mismatch')
  if (record.enrollmentDigest !== expected.enrollmentDigest.toLowerCase())
    throw new Error('connector enrollment pin mismatch')
  const prepared = prepareConnectorPayment({
    contract: record.contract,
    origin: toOrigin(record.origin),
    enrollmentDigest: expected.enrollmentDigest,
    savings: record.savings,
    reserve: record.reserve,
    recipient: record.recipient,
    amountSats: record.amountSats,
    feeSats: record.feeSats,
  })
  if (record.candidatePsbt !== prepared.psbt()) throw new Error('connector candidate mismatch on restore')
  const candidateTxid = Transaction.fromPSBT(hex.decode(prepared.psbt()), OPTIONS).id
  if (record.phoneSignedPsbt !== undefined) {
    if (prepared.verifyPhoneStage(record.phoneSignedPsbt) !== record.phoneSignedPsbt)
      throw new Error('noncanonical saved phone signing stage')
    if (!record.signaturesMayHaveIssued) throw new Error('phone signing stage without retained ownership')
  }
  // A saved Savings witness is re-validated on every load, even before any
  // signed transaction exists.
  if (record.savingsWitness) {
    if (!record.signaturesMayHaveIssued) throw new Error('Savings witness without retained ownership')
    const hardware = prepared.forHardware(record.savingsWitness.map((item) => hex.decode(item)))
    if (record.signedTxHex) {
      const derived = hardware.accept(record.signedTxHex)
      if (hex.encode(hex.decode(derived.txHex)) !== hex.encode(hex.decode(record.signedTxHex)))
        throw new Error('connector signed transaction mismatch on restore')
      if (record.txid && derived.txid !== record.txid) throw new Error('connector txid mismatch on restore')
    }
  } else if (record.signedTxHex) {
    throw new Error('connector Savings witness required before signed tx')
  }
  if (record.txid && !record.signedTxHex) throw new Error('connector txid without signed transaction')
  return { prepared, record, candidateTxid }
}

function readValidated(expected: ConnectorExpectedIdentity, storage: Storage) {
  const raw = storage.getItem(connectorStoreKey(expected.vaultId))
  if (!raw) return null
  return validatedRecord(expected, JSON.parse(raw))
}

function writeRecord(vaultId: string, record: ConnectorPendingRecord, storage: Storage): void {
  storage.setItem(connectorStoreKey(vaultId), JSON.stringify(record))
}

function requireCandidateMatch(validated: { candidateTxid: string }, candidateTxid: string): void {
  if (validated.candidateTxid !== requireCandidateTxid(candidateTxid)) throw new Error('stale connector operation')
}

export function loadPendingConnectorOperation(
  expected: ConnectorExpectedIdentity,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) return null
      const { record, prepared, candidateTxid } = validated
      if (record.signedTxHex) return { record, prepared, phase: 'signed' as const, candidateTxid }
      return {
        record,
        prepared,
        phase: record.signaturesMayHaveIssued || record.savingsWitness ? ('signing' as const) : ('prepared' as const),
        candidateTxid,
      }
    },
    locks,
  )
}

// Persist the exact candidate BEFORE any signing request. Refuses when this
// vault already owns an unresolved operation, so a second preparation can
// never silently release the first operation's outpoints.
export function preparePendingConnectorOperation(
  input: ConnectorPendingInput,
  expected: ConnectorExpectedIdentity,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snapInput = snapshotInput(input)
  const snap = snapshotIdentity(expected)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const existing = readValidated(snap, storage)
      if (existing) {
        throw new Error('connector operation already pending for this vault')
      }
      const prepared = prepareConnectorPayment({
        contract: snapInput.contract,
        origin: toOrigin(snapInput.origin),
        enrollmentDigest: snap.enrollmentDigest,
        savings: snapInput.savings,
        reserve: snapInput.reserve,
        recipient: snapInput.recipient,
        amountSats: snapInput.amountSats,
        feeSats: snapInput.feeSats,
      })
      if (snapInput.contract.vaultId !== snap.vaultId) throw new Error('connector vault identity mismatch')
      const record: ConnectorPendingRecord = {
        ...snapInput,
        version: CONNECTOR_STORE_VERSION,
        enrollmentDigest: snap.enrollmentDigest.toLowerCase(),
        candidatePsbt: prepared.psbt(),
        signaturesMayHaveIssued: false,
      }
      writeRecord(snap.vaultId, record, storage)
      const candidateTxid = Transaction.fromPSBT(hex.decode(record.candidatePsbt), OPTIONS).id
      return { record, prepared, candidateTxid }
    },
    locks,
  )
}

// Latch ownership the moment a signing request may have produced signatures
// (Guardian, Emulator, or hardware). After this, timeout, cancel, and reload
// must NOT release the savings or reserve outpoints.
export function markConnectorSignaturesMayHaveIssued(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) throw new Error('no connector operation to mark')
      requireCandidateMatch(validated, txid)
      validated.record.signaturesMayHaveIssued = true
      writeRecord(snap.vaultId, validated.record, storage)
      return { record: validated.record, candidateTxid: validated.candidateTxid }
    },
    locks,
  )
}

// Persist before sending to the Guardian. Schnorr auxiliary randomness means
// signing the same candidate again is not a byte-identical authorization retry.
// The first verified phone stage wins, even across tabs or a lost response.
export function storeConnectorPhoneStage(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  phoneSignedPsbt: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  const stage = String(phoneSignedPsbt)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) throw new Error('no connector operation to update')
      requireCandidateMatch(validated, txid)
      const canonical = validated.prepared.verifyPhoneStage(stage)
      if (validated.record.phoneSignedPsbt && validated.record.phoneSignedPsbt !== canonical)
        throw new Error('connector phone signing stage already saved')
      validated.record.phoneSignedPsbt = canonical
      validated.record.signaturesMayHaveIssued = true
      writeRecord(snap.vaultId, validated.record, storage)
      return { record: validated.record, candidateTxid: validated.candidateTxid }
    },
    locks,
  )
}

export function storeConnectorSavingsWitness(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  witnessHex: string[],
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  const witness = snapshotStrings(witnessHex)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) throw new Error('no connector operation to update')
      requireCandidateMatch(validated, txid)
      // Throws unless the witness is a valid 5-item Savings witness for this
      // exact candidate; the returned handle is discarded — only validation matters.
      validated.prepared.forHardware(witness.map((item) => hex.decode(item)))
      validated.record.savingsWitness = [...witness]
      validated.record.signaturesMayHaveIssued = true
      writeRecord(snap.vaultId, validated.record, storage)
      return { record: validated.record, candidateTxid: validated.candidateTxid }
    },
    locks,
  )
}

// Accept a signed raw transaction only after re-deriving it from the stored
// witness and candidate. Returns the canonical txid for broadcast. The signed
// operation stays pending afterwards: rebroadcast the SAME raw tx on loss,
// and wait for chain reconciliation for confirmation.
export function storeConnectorSignedTx(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  txHex: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  const rawTx = String(txHex)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) throw new Error('no connector operation to update')
      requireCandidateMatch(validated, txid)
      if (!validated.record.savingsWitness) throw new Error('connector Savings witness required before signed tx')
      const normalized = hex.encode(hex.decode(rawTx.replace(/\s+/g, '')))
      const hardware = validated.prepared.forHardware(validated.record.savingsWitness.map((item) => hex.decode(item)))
      const derived = hardware.accept(normalized)
      if (validated.record.signedTxHex && validated.record.signedTxHex !== derived.txHex)
        throw new Error('connector signed transaction already saved')
      validated.record.signedTxHex = derived.txHex
      validated.record.txid = derived.txid
      validated.record.signaturesMayHaveIssued = true
      writeRecord(snap.vaultId, validated.record, storage)
      return { record: validated.record, txHex: derived.txHex, txid: derived.txid }
    },
    locks,
  )
}

// Outpoints owned by the unresolved operation, labeled separately so balance
// accounting can exclude reserved funds without hiding them (no zero-balance
// illusion) and without double-counting the reserve as Savings.
export function reservedConnectorOutpoints(
  expected: ConnectorExpectedIdentity,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) return { savings: null, reserve: null }
      const { record } = validated
      return {
        savings: { txid: record.savings.txid, vout: record.savings.vout },
        reserve: { txid: record.reserve.txid, vout: record.reserve.vout },
      }
    },
    locks,
  )
}

// Cancellation is only possible while no signature may have issued, and only
// for the exact candidate named by the caller. Once the latch is set, a
// witness is stored, or a signed transaction exists, the operation is retained
// for chain reconciliation — a racing or stale cancel must never release a
// signed candidate. Signed operations can only be archived after verified chain resolution.
export function cancelPendingConnectorOperation(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  storage: Storage,
  locks?: VaultLockManager | null,
): Promise<void> {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const validated = readValidated(snap, storage)
      if (!validated) return
      requireCandidateMatch(validated, txid)
      const { record } = validated
      if (record.signaturesMayHaveIssued || record.savingsWitness || record.signedTxHex)
        throw new Error('signed connector operation is retained for chain reconciliation')
      storage.removeItem(connectorStoreKey(snap.vaultId))
    },
    locks,
  )
}

// Retain the server capability with the exact candidate. It is never inferred
// from an outpoint or replaced by a later response.
export function storeConnectorOperationId(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  operationId: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  if (!/^[0-9a-f]{32}$/.test(operationId)) throw new Error('invalid connector operation id')
  return withConnectorLock(
    snap.vaultId,
    () => {
      const current = readValidated(snap, storage)
      if (!current) throw new Error('no connector operation to update')
      requireCandidateMatch(current, candidateTxid)
      if (current.record.operationId && current.record.operationId !== operationId)
        throw new Error('connector operation identity changed')
      current.record.operationId = operationId
      writeRecord(snap.vaultId, current.record, storage)
    },
    locks,
  )
}

const connectorHistoryKey = (vaultId: string) => `${connectorStoreKey(vaultId)}:history`
// The coordinator calls this only after a fresh, verified observation that an
// archived operation is unresolved again. Keep its exact signing stages and
// history, and never overwrite another tab's active candidate.
export function restoreUnresolvedConnectorOperation(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  operationId: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const txid = requireCandidateTxid(candidateTxid)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const current = readValidated(snap, storage)
      if (current) {
        requireCandidateMatch(current, txid)
        if (current.record.operationId !== operationId) throw new Error('connector operation identity changed')
        return current
      }
      const archived = readConnectorHistory(snap, storage).find((row) => row.candidateTxid === txid)
      if (!archived || !operationId || archived.record.operationId !== operationId)
        throw new Error('connector archived operation identity changed')
      writeRecord(snap.vaultId, archived.record, storage)
      return archived
    },
    locks,
  )
}

export function archiveResolvedConnectorOperation(
  expected: ConnectorExpectedIdentity,
  candidateTxid: string,
  operationId: string,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const current = readValidated(snap, storage)
      if (!current) return
      requireCandidateMatch(current, candidateTxid)
      if (!current.record.operationId || current.record.operationId !== operationId)
        throw new Error('connector operation identity changed')
      const rows = readConnectorHistory(snap, storage)
      if (!rows.some((row) => row.candidateTxid === current.candidateTxid)) rows.push(current)
      // Archive before removing the active pointer. A storage failure retains it.
      storage.setItem(connectorHistoryKey(snap.vaultId), JSON.stringify(rows.map((row) => row.record)))
      storage.removeItem(connectorStoreKey(snap.vaultId))
    },
    locks,
  )
}

function readConnectorHistory(expected: ConnectorExpectedIdentity, storage: Storage) {
  const raw = storage.getItem(connectorHistoryKey(expected.vaultId))
  if (!raw) return []
  const rows: unknown = JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('corrupt connector history')
  return rows.map((row) => validatedRecord(expected, row))
}
export function loadConnectorHistory(
  expected: ConnectorExpectedIdentity,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  return withConnectorLock(snap.vaultId, () => readConnectorHistory(snap, storage), locks)
}

/** Exact signing evidence, including resolved operations that may reappear after a reorg. */
export interface ConnectorRecoveryJournal {
  version: 1
  pending: ConnectorPendingRecord | null
  history: ConnectorPendingRecord[]
}

export function validateConnectorRecoveryJournal(expected: ConnectorExpectedIdentity, raw: unknown) {
  const journal = JSON.parse(JSON.stringify(raw)) as ConnectorRecoveryJournal
  if (!journal || journal.version !== 1 || !Array.isArray(journal.history) || journal.history.length > 1024)
    throw new Error('invalid connector recovery journal')
  if (JSON.stringify(journal).length > 12_000_000) throw new Error('connector recovery journal too large')
  if (journal.pending !== null) validatedRecord(expected, journal.pending)
  const seen = new Set<string>()
  for (const record of journal.history) {
    const { candidateTxid } = validatedRecord(expected, record)
    if (seen.has(candidateTxid)) throw new Error('duplicate connector recovery history')
    seen.add(candidateTxid)
  }
  return journal
}

export function exportConnectorRecoveryJournal(
  expected: ConnectorExpectedIdentity,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  return withConnectorLock(
    snap.vaultId,
    () =>
      validateConnectorRecoveryJournal(snap, {
        version: 1,
        pending: readValidated(snap, storage)?.record ?? null,
        history: readConnectorHistory(snap, storage).map(({ record }) => record),
      }),
    locks,
  )
}

function mergeRecoveryRecord(
  expected: ConnectorExpectedIdentity,
  current: ConnectorPendingRecord,
  incoming: ConnectorPendingRecord,
): ConnectorPendingRecord {
  const a = validatedRecord(expected, current)
  const b = validatedRecord(expected, incoming)
  requireCandidateMatch(a, b.candidateTxid)
  const merged = {
    ...current,
    signaturesMayHaveIssued: current.signaturesMayHaveIssued || incoming.signaturesMayHaveIssued,
  }
  for (const field of ['operationId', 'phoneSignedPsbt', 'savingsWitness', 'signedTxHex', 'txid'] as const) {
    if (
      current[field] !== undefined &&
      incoming[field] !== undefined &&
      JSON.stringify(current[field]) !== JSON.stringify(incoming[field])
    )
      throw new Error(`conflicting connector recovery ${field}`)
  }
  const result = {
    ...incoming,
    ...Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
  }
  return validatedRecord(expected, result).record
}

/** Restore never treats absent data as cancellation or an archive as fresh chain evidence. */
export function restoreConnectorRecoveryJournal(
  expected: ConnectorExpectedIdentity,
  raw: unknown,
  storage: Storage,
  locks?: VaultLockManager | null,
) {
  const snap = snapshotIdentity(expected)
  const incoming = validateConnectorRecoveryJournal(snap, raw)
  return withConnectorLock(
    snap.vaultId,
    () => {
      const current = readValidated(snap, storage)
      let pending = current?.record ?? null
      if (incoming.pending) pending = pending ? mergeRecoveryRecord(snap, pending, incoming.pending) : incoming.pending
      const history = new Map(readConnectorHistory(snap, storage).map((row) => [row.candidateTxid, row.record]))
      for (const record of incoming.history) {
        const { candidateTxid } = validatedRecord(snap, record)
        const prior = history.get(candidateTxid)
        history.set(candidateTxid, prior ? mergeRecoveryRecord(snap, prior, record) : record)
      }
      if (pending) {
        const { candidateTxid } = validatedRecord(snap, pending)
        const archived = history.get(candidateTxid)
        if (archived) pending = mergeRecoveryRecord(snap, pending, archived)
      }
      // Validate every merge before the first write. History first means a failed
      // second write retains evidence and never clears the active operation.
      const merged = validateConnectorRecoveryJournal(snap, { version: 1, pending, history: [...history.values()] })
      storage.setItem(connectorHistoryKey(snap.vaultId), JSON.stringify(merged.history))
      if (merged.pending) writeRecord(snap.vaultId, merged.pending, storage)
      return merged
    },
    locks,
  )
}
