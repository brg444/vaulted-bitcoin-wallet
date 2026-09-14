import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { type VtxoReserveRequest } from '../cosignerClient'
import { networkPins } from '../networkPins'
import type { VaultStatus } from '../types'
import { withVtxoSendLock, type VaultLockManager } from './lock'
import { VtxoLivePendingError } from './spendingErrors'
import {
  buildPersistedVtxoSdkBundle,
  checkpointPairsInCanonicalOrder,
  createVaultSdkOperationValidation,
  matchOperatorSignedCheckpoints,
  persistedReservationFactsAreValid,
  requireAuthorizedPendingProof,
  requireFullyAuthorizedCheckpoints,
  reserveSignatureMatches,
  VTXO_DUST_SATS,
  vtxoDestinationScript,
  xOnly,
  type PersistedVtxoSpend,
  type PersistedVtxoSpendStage,
} from './spendingTransaction'

export function vtxoSpendStorageKey(vaultId: string): string {
  return `arkade-vault-vtxo-spend:${vaultId}`
}

export function vtxoSpendJournalKey(vaultId: string): string {
  return `arkade-vault-vtxo-spend-journal:${vaultId}`
}

const MAX_VTXO_SPEND_JOURNAL = 32

function parsePersistedVtxoSpend(
  vaultId: string,
  parsed: Partial<PersistedVtxoSpend> | null,
): PersistedVtxoSpend | undefined {
  if (
    parsed &&
    parsed.vaultId === vaultId &&
    isVtxoOperationId(parsed.operationId) &&
    parsed.stage &&
    parsed.destAddress &&
    typeof parsed.amountSats === 'number' &&
    (parsed.reservePhoneSignature === undefined || /^[0-9a-f]{128}$/.test(parsed.reservePhoneSignature)) &&
    persistedReservationFactsAreValid(parsed) &&
    (parsed.stage === 'pre-reserve' || (parsed.bundleDigest && (parsed.stage === 'reserved' || parsed.arkTxid)))
  ) {
    // Presentation metadata must never make a malformed local row disappear.
    if (parsed.receiptFinalized !== undefined)
      parsed.receiptFinalized = parsed.receiptFinalized === true && parsed.stage !== 'pre-reserve' && !!parsed.arkTxid
    return parsed as PersistedVtxoSpend
  }
  return undefined
}

export interface SpendingRecoveryJournal {
  version: 1
  vaultId: string
  operations: PersistedVtxoSpend[]
  resolved?: Pick<PersistedVtxoSpend, 'operationId' | 'destAddress' | 'amountSats' | 'arkTxid'>[]
}

/** Strict archive boundary: never silently drop malformed or excess pending operations. */
export function validateSpendingRecoveryJournal(status: VaultStatus, raw: unknown): SpendingRecoveryJournal {
  if (!raw || JSON.stringify(raw).length > 8_000_000) throw new Error('Invalid Spending recovery journal')
  const journal = JSON.parse(JSON.stringify(raw)) as SpendingRecoveryJournal
  if (
    journal.version !== 1 ||
    journal.vaultId !== status.vaultId ||
    !Array.isArray(journal.operations) ||
    journal.operations.length > MAX_VTXO_SPEND_JOURNAL
  )
    throw new Error('Invalid Spending recovery journal')
  if (journal.resolved !== undefined && (!Array.isArray(journal.resolved) || journal.resolved.length > 10000))
    throw new Error('Invalid resolved Spending history')
  const resolvedIds = new Set<string>()
  for (const record of journal.resolved || []) {
    if (
      !isVtxoOperationId(record.operationId) ||
      resolvedIds.has(record.operationId) ||
      !Number.isSafeInteger(record.amountSats) ||
      record.amountSats < VTXO_DUST_SATS ||
      (record.arkTxid !== '' && !/^[0-9a-f]{64}$/.test(record.arkTxid))
    )
      throw new Error('Invalid resolved Spending operation')
    vtxoDestinationScript(status, record.destAddress)
    resolvedIds.add(record.operationId)
  }
  const ids = new Set<string>()
  for (const record of journal.operations) {
    if (
      !parsePersistedVtxoSpend(status.vaultId, { ...record }) ||
      !(record.stage in VTXO_SPEND_STAGE_RANK) ||
      ids.has(record.operationId) ||
      !Number.isSafeInteger(record.amountSats) ||
      record.amountSats < VTXO_DUST_SATS
    )
      throw new Error('Invalid pending Spending operation')
    ids.add(record.operationId)
    vtxoDestinationScript(status, record.destAddress)
    if (record.reservePhoneSignature && !reserveSignatureMatches(record, status))
      throw new Error('Spending reservation signature changed')
    if (record.operatorSubmitAttempted !== undefined && typeof record.operatorSubmitAttempted !== 'boolean')
      throw new Error('Invalid submission ambiguity flag')
    if (
      (record.receiptFinalized !== undefined && typeof record.receiptFinalized !== 'boolean') ||
      (record.receiptFinalized === true && (record.stage === 'pre-reserve' || !record.arkTxid))
    )
      throw new Error('Invalid finalization receipt flag')
    if (record.stage === 'pre-reserve') {
      if (
        record.bundleDigest ||
        record.arkTxid ||
        record.authorizedPsbt ||
        record.operatorArkPsbt ||
        record.operatorSubmitAttempted
      )
        throw new Error('Pre-reservation contains later transaction evidence')
      continue
    }
    if (
      !/^[0-9a-f]{64}$/.test(record.bundleDigest) ||
      !record.unsignedArkPsbt ||
      !record.unsignedCheckpointPsbts?.length ||
      record.checkpointTapscript !== networkPins(status.network).checkpointTapscript
    )
      throw new Error('Spending operation is missing its exact transaction bundle')
    const unsigned = Transaction.fromPSBT(base64.decode(record.unsignedArkPsbt))
    // Old journals carry the same transaction facts in their unsigned PSBT. Rebuild
    // through the pinned SDK without changing the imported historical record.
    const rebuildRecord =
      record.sdkBundleVersion === 1
        ? record
        : {
            ...record,
            sdkBundleVersion: 1 as const,
            reservedInputs: Array.from({ length: unsigned.inputsLength }, (_, index) => {
              const input = unsigned.getInput(index)
              if (!input.txid || input.index === undefined || !input.witnessUtxo)
                throw new Error('Spending input prevout is missing')
              return {
                txid: hex.encode(input.txid),
                vout: input.index,
                valueSats: Number(input.witnessUtxo.amount),
                scriptHex: hex.encode(input.witnessUtxo.script),
              }
            }),
            reservedOutputs: Array.from({ length: unsigned.outputsLength }, (_, index) => {
              const output = unsigned.getOutput(index)
              if (!output.script || output.amount === undefined) throw new Error('Spending output is missing')
              return { scriptHex: hex.encode(output.script), amountSats: Number(output.amount) }
            }),
          }
    const { rebuilt } = buildPersistedVtxoSdkBundle(status, rebuildRecord)
    const validation = createVaultSdkOperationValidation(
      status,
      rebuilt.arkTx,
      xOnly(networkPins(status.network).operatorSignerPub, 'Operator'),
    )
    validation.assertArkTransaction(unsigned, 'unsigned')
    for (const { original, candidate } of checkpointPairsInCanonicalOrder(
      rebuilt.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
      record.unsignedCheckpointPsbts,
      'Recovery',
    ))
      validation.assertCheckpointTransaction(candidate, original, 'unsigned')
    if (record.authorizedPsbt)
      validation.assertArkTransaction(Transaction.fromPSBT(base64.decode(record.authorizedPsbt)), 'vault-authorized')
    if (record.operatorArkPsbt)
      validation.assertArkTransaction(Transaction.fromPSBT(base64.decode(record.operatorArkPsbt)), 'operator-signed')
    if (record.authorizedPendingProof)
      requireAuthorizedPendingProof(record.unsignedCheckpointPsbts, record.authorizedPendingProof, status)
    if (record.operatorCheckpointPsbts)
      matchOperatorSignedCheckpoints(
        record.unsignedCheckpointPsbts,
        record.operatorCheckpointPsbts,
        xOnly(networkPins(status.network).operatorSignerPub, 'Operator'),
      )
    if (record.checkpointPsbts)
      requireFullyAuthorizedCheckpoints(
        record,
        status,
        xOnly(networkPins(status.network).operatorSignerPub, 'Operator'),
      )
    if (VTXO_SPEND_STAGE_RANK[record.stage] >= 1 && (!record.authorizedPsbt || !record.authorizedPendingProof))
      throw new Error('Authorized Spending operation has incomplete recovery evidence')
    if (VTXO_SPEND_STAGE_RANK[record.stage] >= 2 && (!record.operatorArkPsbt || !record.operatorCheckpointPsbts))
      throw new Error('Operator result is missing')
    if (VTXO_SPEND_STAGE_RANK[record.stage] >= 3 && !record.checkpointPsbts)
      throw new Error('Authorized checkpoints are missing')
  }
  return journal
}

function strictStoredSpendingJournal(status: VaultStatus): SpendingRecoveryJournal {
  const current = localStorage.getItem(vtxoSpendJournalKey(status.vaultId))
  const legacy = localStorage.getItem(vtxoSpendStorageKey(status.vaultId))
  const parsed = current ? JSON.parse(current) : { version: 1, operations: legacy ? [JSON.parse(legacy)] : [] }
  return validateSpendingRecoveryJournal(status, { ...parsed, vaultId: status.vaultId })
}

export function exportSpendingRecoveryJournal(status: VaultStatus, locks?: VaultLockManager) {
  return withVtxoSendLock(status.vaultId, async () => strictStoredSpendingJournal(status), locks)
}

/** Existing local operations win; importing a backup never downgrades a newer local state. */
export function restoreSpendingRecoveryJournal(status: VaultStatus, raw: unknown, locks?: VaultLockManager) {
  const imported = validateSpendingRecoveryJournal(status, raw)
  return withVtxoSendLock(
    status.vaultId,
    async () => {
      const local = strictStoredSpendingJournal(status)
      const operations = [...local.operations]
      const resolved = [...(local.resolved || [])]
      for (const incoming of imported.operations) {
        // A restored device observes confirmation from Guardian itself.
        delete incoming.receiptFinalized
        const closed = resolved.find((record) => record.operationId === incoming.operationId)
        if (closed) {
          if (
            closed.destAddress !== incoming.destAddress ||
            closed.amountSats !== incoming.amountSats ||
            (closed.arkTxid && incoming.arkTxid && closed.arkTxid !== incoming.arkTxid)
          )
            throw new Error('Conflicting resolved Spending evidence')
          continue
        }
        const current = operations.find((record) => record.operationId === incoming.operationId)
        if (current) {
          for (const key of Object.keys(incoming) as (keyof PersistedVtxoSpend)[]) {
            if (key === 'stage' || key === 'operatorSubmitAttempted' || key === 'reservationExpires') continue
            const a = current[key],
              b = incoming[key]
            if (a !== undefined && b !== undefined && a !== '' && b !== '' && JSON.stringify(a) !== JSON.stringify(b))
              throw new Error('Conflicting pending Spending evidence')
          }
          // Retain signature/attempt evidence even if the local stage is older.
          Object.assign(current, {
            ...incoming,
            ...current,
            stage: laterVtxoSpendStage(current.stage, incoming.stage),
            operatorSubmitAttempted: current.operatorSubmitAttempted || incoming.operatorSubmitAttempted,
          })
        } else operations.push(incoming)
      }
      for (const row of imported.resolved || []) {
        const known = resolved.find((record) => record.operationId === row.operationId)
        if (known && JSON.stringify(known) !== JSON.stringify(row))
          throw new Error('Conflicting resolved Spending history')
        if (!known && !operations.some((record) => record.operationId === row.operationId)) resolved.push(row)
      }
      const merged = validateSpendingRecoveryJournal(status, { ...local, operations, resolved })
      writeVtxoSpendJournal(status.vaultId, merged.operations, merged.resolved)
      return merged
    },
    locks,
  )
}

function readVtxoSpendJournal(vaultId: string): PersistedVtxoSpend[] {
  if (typeof localStorage === 'undefined' || !vaultId) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(vtxoSpendJournalKey(vaultId)) || 'null') as {
      version?: number
      operations?: Partial<PersistedVtxoSpend>[]
    } | null
    if (parsed?.version === 1 && Array.isArray(parsed.operations)) {
      return parsed.operations
        .map((record) => parsePersistedVtxoSpend(vaultId, record))
        .filter((record): record is PersistedVtxoSpend => Boolean(record))
        .slice(0, MAX_VTXO_SPEND_JOURNAL)
    }
  } catch {
    // Fall through to the retired one-slot key.
  }
  try {
    const legacy = parsePersistedVtxoSpend(
      vaultId,
      JSON.parse(localStorage.getItem(vtxoSpendStorageKey(vaultId)) || 'null') as Partial<PersistedVtxoSpend>,
    )
    return legacy ? [legacy] : []
  } catch {
    return []
  }
}

export const SPENDING_PAYMENT_EVENT = 'vaulted-spending-payment'

function writeVtxoSpendJournal(
  vaultId: string,
  operations: PersistedVtxoSpend[],
  resolved?: SpendingRecoveryJournal['resolved'],
) {
  if (typeof localStorage === 'undefined' || !vaultId) return
  const previous = JSON.parse(localStorage.getItem(vtxoSpendJournalKey(vaultId)) || 'null')
  const history = resolved ?? previous?.resolved ?? []
  localStorage.setItem(vtxoSpendJournalKey(vaultId), JSON.stringify({ version: 1, operations, resolved: history }))
  localStorage.removeItem(vtxoSpendStorageKey(vaultId))
  window.dispatchEvent(new Event(SPENDING_PAYMENT_EVENT))
}

export function listPersistedVtxoSpends(vaultId: string): PersistedVtxoSpend[] {
  return readVtxoSpendJournal(vaultId)
}

export function loadPersistedVtxoSpend(vaultId: string): PersistedVtxoSpend | undefined {
  const operations = readVtxoSpendJournal(vaultId)
  return operations[operations.length - 1]
}

export function loadPersistedVtxoSpendById(vaultId: string, operationId: string): PersistedVtxoSpend | undefined {
  return readVtxoSpendJournal(vaultId).find((record) => record.operationId === operationId)
}

/** A submitted-but-unfinished operation. Shared by the payment owners and the
 * wallet-worker observation cadence without importing `./spend`. */
export function vtxoSpendIsLivePending(
  record: Pick<PersistedVtxoSpend, 'receiptFinalized' | 'operatorSubmitAttempted' | 'stage'>,
): boolean {
  if (record.receiptFinalized === true) return false
  return (
    record.operatorSubmitAttempted === true ||
    record.stage === 'authorized' ||
    record.stage === 'operator-submitted' ||
    record.stage === 'checkpoints-authorized' ||
    record.stage === 'operator-finalized'
  )
}

/** True when this vault has any submitted-but-unfinished Spending operation. */
export function hasLivePendingVtxoSpend(vaultId: string): boolean {
  return readVtxoSpendJournal(vaultId).some((record) => vtxoSpendIsLivePending(record))
}

export function isVtxoOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

export function createVtxoOperationId(random?: Uint8Array): string {
  const bytes = random || crypto.getRandomValues(new Uint8Array(16))
  if (bytes.length !== 16) throw new Error('VTXO operation id requires 16 random bytes')
  return hex.encode(bytes)
}

export function preReserveVtxoSpend(
  vaultId: string,
  destAddress: string,
  amountSats: number,
  operationId = createVtxoOperationId(),
): PersistedVtxoSpend {
  if (!vaultId.trim()) throw new Error('vault id required')
  if (!isVtxoOperationId(operationId)) throw new Error('invalid VTXO operation id')
  const record: PersistedVtxoSpend = {
    vaultId,
    operationId,
    bundleDigest: '',
    destAddress: destAddress.trim(),
    amountSats,
    arkTxid: '',
    stage: 'pre-reserve',
  }
  persistVtxoSpend(record)
  return record
}

export function vtxoReserveRequest(pending: PersistedVtxoSpend, status: VaultStatus): VtxoReserveRequest {
  if (pending.stage !== 'pre-reserve' || !isVtxoOperationId(pending.operationId)) {
    throw new Error('VTXO pre-reservation required')
  }
  if (!pending.reservePhoneSignature || !reserveSignatureMatches(pending, status)) {
    throw new Error('VTXO reservation requires this device signature')
  }
  return {
    vaultId: pending.vaultId,
    operationId: pending.operationId,
    purpose: 'spend',
    destAddress: pending.destAddress,
    amountSats: pending.amountSats,
    phoneSignature: pending.reservePhoneSignature,
  }
}

export function persistVtxoSpend(record: PersistedVtxoSpend) {
  if (typeof localStorage === 'undefined') return
  const operations = readVtxoSpendJournal(record.vaultId)
  const index = operations.findIndex((candidate) => candidate.operationId === record.operationId)
  if (index >= 0) operations.splice(index, 1)
  else if (operations.length >= MAX_VTXO_SPEND_JOURNAL) {
    throw new VtxoLivePendingError(operations.map((candidate) => candidate.operationId))
  }
  operations.push(record)
  writeVtxoSpendJournal(record.vaultId, operations)
}

/** Retire one operation by id, appending its receipt facts to resolved history. */
export function clearPersistedVtxoSpend(vaultId: string, operationId: string) {
  if (typeof localStorage === 'undefined' || !vaultId) return
  const operations = readVtxoSpendJournal(vaultId)
  const cleared = operations.find((record) => record.operationId === operationId)
  const previous = JSON.parse(localStorage.getItem(vtxoSpendJournalKey(vaultId)) || 'null')
  const resolved: NonNullable<SpendingRecoveryJournal['resolved']> = previous?.resolved || []
  if (cleared && !resolved.some((record) => record.operationId === operationId)) {
    if (resolved.length >= 10000) throw new Error('Spending recovery history is full')
    const { destAddress, amountSats, arkTxid } = cleared
    resolved.push({ operationId, destAddress, amountSats, arkTxid })
  }
  writeVtxoSpendJournal(
    vaultId,
    operations.filter((record) => record.operationId !== operationId),
    resolved,
  )
}

export const VTXO_SPEND_STAGE_RANK: Record<PersistedVtxoSpendStage, number> = {
  'pre-reserve': -1,
  reserved: 0,
  authorized: 1,
  'operator-submitted': 2,
  'checkpoints-authorized': 3,
  'operator-finalized': 4,
}

export function laterVtxoSpendStage(
  current: PersistedVtxoSpendStage,
  incoming: PersistedVtxoSpendStage,
): PersistedVtxoSpendStage {
  return VTXO_SPEND_STAGE_RANK[incoming] > VTXO_SPEND_STAGE_RANK[current] ? incoming : current
}
