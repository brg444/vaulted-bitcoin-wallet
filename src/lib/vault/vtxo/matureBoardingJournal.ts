import { recoveryFileStore } from '../recovery/fileStore'
import type { VaultStatus } from '../types'
import { requireBoardingStatus } from './board'
import { validateMatureBoardingRecoveryFile, type MatureBoardingRecoveryFile } from './boardingRecoveryFile'

/** signed: exact bytes stored, not dispatched. dispatched: broadcast requested. uncertain: lost
 * response or missing indexer. conflict: another transaction spent an input. confirmed: our
 * exact transaction is confirmed. retired: retirement predicate cleared the pending journal. */
export type MatureBoardingAttemptPhase = 'signed' | 'dispatched' | 'uncertain' | 'conflict' | 'confirmed' | 'retired'

export interface MatureBoardingAttempt {
  name: 'vaulted-mature-boarding-attempt'
  version: 1
  vaultId: string
  network: string
  descriptorHash: string
  evidence: MatureBoardingRecoveryFile
  txid: string
  hex: string
  phase: Exclude<MatureBoardingAttemptPhase, 'retired'>
  conflictTxid?: string
}

export interface MatureBoardingRetired {
  name: 'vaulted-mature-boarding-attempt'
  version: 1
  vaultId: string
  network: string
  descriptorHash: string
  txid: string
  phase: 'retired'
}

export type MatureBoardingRecord = MatureBoardingAttempt | MatureBoardingRetired

export interface MatureBoardingRetirementEvidence {
  confirmation: { txid: string; confirmed: true; blockHeight: number }
  history: { txid: string; kind: 'received' | 'sent'; amountSats: number }
  recovery: {
    vaultId: string
    network: string
    descriptorHash: string
    attemptTxid: string
    attemptHex: string
  }
}

export interface MatureBoardingChainInspection {
  confirmed: boolean
  seen: boolean
  conflictTxid?: string
}

const LIMIT = 12_000_000
const PHASES: Exclude<MatureBoardingAttemptPhase, 'retired'>[] = [
  'signed',
  'dispatched',
  'uncertain',
  'conflict',
  'confirmed',
]

export function matureBoardingAttemptKey(vaultId: string, network: string, script: string) {
  return `mature-boarding-attempt:${vaultId}:${network}:${script}`
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameTransport(left: MatureBoardingAttempt, right: MatureBoardingAttempt) {
  return (
    left.txid === right.txid &&
    left.hex === right.hex &&
    JSON.stringify(left.evidence) === JSON.stringify(right.evidence)
  )
}

function allowPhase(from: MatureBoardingAttempt['phase'], to: MatureBoardingAttempt['phase']) {
  if (from === to) return true
  if (from === 'confirmed') return false
  if (from === 'conflict') return to === 'confirmed'
  if (from === 'signed') return to === 'dispatched' || to === 'uncertain'
  return to === 'dispatched' || to === 'uncertain' || to === 'conflict' || to === 'confirmed'
}

export function validateMatureBoardingAttempt(status: VaultStatus, raw: unknown): MatureBoardingAttempt {
  if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > LIMIT)
    throw new Error('Invalid mature boarding recovery attempt')
  const record = copy(raw) as MatureBoardingAttempt
  const descriptor = requireBoardingStatus(status, String(status.vtxoBoardingDescriptor?.boardingPub || ''))
  if (
    record.name !== 'vaulted-mature-boarding-attempt' ||
    record.version !== 1 ||
    record.vaultId !== status.vaultId ||
    record.network !== status.network ||
    record.descriptorHash !== status.vtxoBoardingDescriptorHash ||
    !PHASES.includes(record.phase) ||
    (record.phase === 'conflict'
      ? typeof record.conflictTxid !== 'string' || !/^[0-9a-f]{64}$/.test(record.conflictTxid)
      : record.conflictTxid !== undefined)
  )
    throw new Error('Mature boarding recovery does not match this vault')
  const view = validateMatureBoardingRecoveryFile(record.evidence)
  if (
    record.evidence.vaultId !== status.vaultId ||
    record.evidence.network !== descriptor.network ||
    JSON.stringify(record.evidence.descriptor) !== JSON.stringify(descriptor) ||
    record.evidence.feerateCapSatVb !== status.feerateCapSatVb ||
    record.evidence.absoluteFeeCapSats !== status.absoluteFeeCap ||
    record.txid !== view.txid ||
    record.hex !== view.hex ||
    !/^[0-9a-f]{64}$/.test(record.txid)
  )
    throw new Error('Mature boarding recovery evidence changed')
  return record
}

export function validateMatureBoardingRecord(status: VaultStatus, raw: unknown): MatureBoardingRecord {
  const record = raw as MatureBoardingRecord
  if (record?.phase === 'retired') {
    if (
      !record ||
      record.name !== 'vaulted-mature-boarding-attempt' ||
      record.version !== 1 ||
      record.vaultId !== status.vaultId ||
      record.network !== status.network ||
      record.descriptorHash !== status.vtxoBoardingDescriptorHash ||
      !/^[0-9a-f]{64}$/.test(record.txid) ||
      JSON.stringify(record).length > LIMIT
    )
      throw new Error('Invalid mature boarding recovery retirement')
    return copy(record)
  }
  return validateMatureBoardingAttempt(status, raw)
}

function storageKey(status: VaultStatus) {
  const descriptor = requireBoardingStatus(status, String(status.vtxoBoardingDescriptor?.boardingPub || ''))
  return matureBoardingAttemptKey(status.vaultId, descriptor.network, descriptor.script)
}

export async function loadMatureBoardingRecord(status: VaultStatus): Promise<MatureBoardingRecord | null> {
  const raw = await recoveryFileStore<MatureBoardingRecord>(storageKey(status))
  return raw ? validateMatureBoardingRecord(status, raw) : null
}

export async function loadMatureBoardingAttempt(status: VaultStatus): Promise<MatureBoardingAttempt | null> {
  const record = await loadMatureBoardingRecord(status)
  return record && record.phase !== 'retired' ? record : null
}

export async function persistMatureBoardingAttempt(status: VaultStatus, next: MatureBoardingAttempt) {
  const exact = validateMatureBoardingAttempt(status, next)
  if (!navigator.locks) throw new Error('Web Locks required to preserve mature boarding recovery')
  const key = storageKey(status)
  return navigator.locks.request(key, async () => {
    const previous = await recoveryFileStore<MatureBoardingRecord>(key)
    if (previous) {
      const saved = validateMatureBoardingRecord(status, previous)
      if (saved.phase === 'retired') {
        if (exact.phase !== 'signed') throw new Error('Mature boarding recovery is not a new signed attempt')
      } else if (!sameTransport(saved, exact)) {
        throw new Error('Mature boarding recovery already retained')
      } else if (!allowPhase(saved.phase, exact.phase)) {
        throw new Error('Mature boarding recovery phase cannot move backward')
      }
    } else if (exact.phase !== 'signed') {
      throw new Error('Mature boarding recovery must persist signed bytes first')
    }
    await recoveryFileStore(key, exact)
    const readback = await recoveryFileStore<MatureBoardingRecord>(key)
    if (!readback || JSON.stringify(validateMatureBoardingAttempt(status, readback)) !== JSON.stringify(exact))
      throw new Error('Mature boarding recovery did not persist')
    return exact
  })
}

export function canRetireMatureBoardingAttempt(
  record: MatureBoardingAttempt,
  evidence: MatureBoardingRetirementEvidence,
) {
  if (record.phase !== 'confirmed') return false
  if (!evidence?.confirmation?.confirmed || evidence.confirmation.txid !== record.txid) return false
  if (!Number.isSafeInteger(evidence.confirmation.blockHeight) || evidence.confirmation.blockHeight <= 0) return false
  if (
    evidence.history?.txid !== record.txid ||
    (evidence.history.kind !== 'received' && evidence.history.kind !== 'sent') ||
    !Number.isSafeInteger(evidence.history.amountSats) ||
    evidence.history.amountSats <= 0
  )
    return false
  const recovery = evidence.recovery
  return (
    recovery?.vaultId === record.vaultId &&
    recovery.network === record.network &&
    recovery.descriptorHash === record.descriptorHash &&
    recovery.attemptTxid === record.txid &&
    recovery.attemptHex === record.hex
  )
}

export async function retireMatureBoardingAttempt(status: VaultStatus, evidence: MatureBoardingRetirementEvidence) {
  if (!navigator.locks) throw new Error('Web Locks required to preserve mature boarding recovery')
  const key = storageKey(status)
  return navigator.locks.request(key, async () => {
    const current = await loadMatureBoardingAttempt(status)
    if (!current) return null
    if (!canRetireMatureBoardingAttempt(current, evidence))
      throw new Error('Mature boarding recovery is not ready to retire')
    const retired: MatureBoardingRetired = {
      name: 'vaulted-mature-boarding-attempt',
      version: 1,
      vaultId: current.vaultId,
      network: current.network,
      descriptorHash: current.descriptorHash,
      txid: current.txid,
      phase: 'retired',
    }
    await recoveryFileStore(key, retired)
    return retired
  })
}

export async function restoreMatureBoardingAttempt(status: VaultStatus, incoming: MatureBoardingAttempt) {
  const exact = validateMatureBoardingAttempt(status, incoming)
  if (!navigator.locks) throw new Error('Web Locks required to restore mature boarding recovery')
  const key = storageKey(status)
  return navigator.locks.request(key, async () => {
    const previous = await recoveryFileStore<MatureBoardingRecord>(key)
    if (!previous) {
      await recoveryFileStore(key, exact)
      return exact
    }
    const saved = validateMatureBoardingRecord(status, previous)
    if (saved.phase === 'retired') {
      if (saved.txid === exact.txid) return saved
      throw new Error('Mature boarding recovery already retained')
    }
    if (!sameTransport(saved, exact)) throw new Error('Conflicting mature boarding recovery evidence')
    const next = allowPhase(saved.phase, exact.phase) ? exact : saved
    if (JSON.stringify(next) !== JSON.stringify(saved)) await recoveryFileStore(key, next)
    return next
  })
}

export function inspectMatureBoardingConflict(
  attempt: MatureBoardingAttempt,
  outspends: readonly { spent: boolean; txid?: string }[] | undefined,
  vout: number,
) {
  const out = outspends?.[vout]
  if (!out?.spent || typeof out.txid !== 'string' || !/^[0-9a-f]{64}$/.test(out.txid) || out.txid === attempt.txid)
    return undefined
  return out.txid
}
