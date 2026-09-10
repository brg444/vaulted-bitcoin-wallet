import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { vaultPost } from './api'
import { beginPasskeySession } from './signIn'
import { signDirectP256 } from './ceremony/directauth'
import { unlockLedgerPhoneSeed } from './ledgerPhoneBackup'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import {
  canonicalLedgerValue,
  validateLedgerSavingsContract,
  validateLedgerSavingsEnrollmentSecrets,
} from './program/ledgerEnrollment'
import { ledgerEnrollmentFromStatus } from './program/ledgerRecoveryDescriptor'
import { ledgerBip32Versions } from './program/ledgerNativeKeys'
import { signLedgerRecoveryTransitionWithDevice } from './program/ledgerRecoveryDevice'
import { connectLedgerSavings } from './ledgerClient'
import { validateSavingsRecovery, type SavingsRecoveryFile } from './program/onchainRecovery'
import { isLedgerRecoveryKit } from './program/kit'
import { acceptRecoveryPsbtSignatures } from './recovery/signatureImport'
import {
  acceptLedgerRecoveryGuardianSignatures,
  attachLedgerRecoveryPhoneProof,
  buildLedgerRecoveryPsbt,
  inspectLedgerRecoveryTransition,
  ledgerRecoveryPhoneAuthorizationDigest,
  requireLedgerRecoveryUserApproval,
  signLedgerRecoveryWithPhone,
  type LedgerRecoveryPhoneProof,
  type LedgerRecoveryTransition,
} from './ledgerRecovery'

export interface LedgerRecoveryRecord {
  version: 1
  transition: LedgerRecoveryTransition
  userPsbt?: string
  phoneAuthorization?: LedgerRecoveryPhoneProof
  guardianPsbt?: string
  txHex?: string
}
export interface LedgerRecoveryJournal {
  version: 1
  records: LedgerRecoveryRecord[]
  standalone?: SavingsRecoveryFile[]
}
const storeKey = (id: string) => `vaulted-ledger-recovery-v1:${id}`
function candidate(record: LedgerRecoveryRecord) {
  return Transaction.fromPSBT(hex.decode(buildLedgerRecoveryPsbt(record.transition))).id
}

export function validateLedgerRecoveryRecord(raw: unknown): LedgerRecoveryRecord {
  const record = structuredClone(raw) as LedgerRecoveryRecord
  if (!record || record.version !== 1) throw new Error('Unsupported Ledger recovery record')
  validateLedgerSavingsContract(record.transition.contract)
  const view = inspectLedgerRecoveryTransition(record.transition)
  let tx = Transaction.fromPSBT(hex.decode(buildLedgerRecoveryPsbt(record.transition)))
  if (record.userPsbt) tx = requireLedgerRecoveryUserApproval(record.transition, record.userPsbt)
  if (record.phoneAuthorization) {
    if (
      !record.userPsbt ||
      view.user !== 'phone' ||
      canonicalLedgerValue(
        attachLedgerRecoveryPhoneProof(record.transition, record.userPsbt, record.phoneAuthorization.signature)
          .phoneAuthorization,
      ) !== canonicalLedgerValue(record.phoneAuthorization)
    )
      throw new Error('Ledger recovery phone proof changed')
  }
  if (record.guardianPsbt) {
    if (!record.userPsbt || (view.user === 'phone' && !record.phoneAuthorization))
      throw new Error('Ledger recovery approval is incomplete')
    tx = Transaction.fromPSBT(
      hex.decode(acceptLedgerRecoveryGuardianSignatures(record.transition, record.userPsbt, record.guardianPsbt)),
    )
    tx.finalize()
    if (record.txHex !== hex.encode(tx.extract())) throw new Error('Ledger recovery transaction changed')
  } else if (record.txHex) throw new Error('Ledger recovery transaction has no Guardian approval')
  const rebuilt: LedgerRecoveryRecord = {
    version: 1,
    transition: record.transition,
    ...(record.userPsbt ? { userPsbt: record.userPsbt } : {}),
    ...(record.phoneAuthorization ? { phoneAuthorization: record.phoneAuthorization } : {}),
    ...(record.guardianPsbt ? { guardianPsbt: record.guardianPsbt, txHex: record.txHex } : {}),
  }
  if (canonicalLedgerValue(rebuilt) !== canonicalLedgerValue(record))
    throw new Error('Unsupported Ledger recovery fields')
  return rebuilt
}
export function validateLedgerRecoveryJournal(
  contract: LedgerRecoveryTransition['contract'],
  raw: unknown,
): LedgerRecoveryJournal {
  const journal = raw as LedgerRecoveryJournal
  if (!journal || journal.version !== 1 || !Array.isArray(journal.records) || journal.records.length > 1000)
    throw new Error('Invalid Ledger recovery journal')
  const records = journal.records.map(validateLedgerRecoveryRecord),
    ids = new Set<string>()
  for (const record of records) {
    if (
      canonicalLedgerValue(record.transition.contract) !== canonicalLedgerValue(contract) ||
      ids.has(candidate(record))
    )
      throw new Error('Ledger recovery journal identity changed')
    ids.add(candidate(record))
  }
  if (journal.standalone && (!Array.isArray(journal.standalone) || journal.standalone.length > 1000))
    throw new Error('Invalid stand-alone recovery journal')
  const standalone = journal.standalone?.map((file) => {
    const view = validateSavingsRecovery(file)
    if (
      !isLedgerRecoveryKit(view.kit) ||
      canonicalLedgerValue(view.kit.descriptor.ledgerSavings) !== canonicalLedgerValue(contract) ||
      ids.has(view.tx.id)
    )
      throw new Error('Stand-alone recovery identity changed')
    ids.add(view.tx.id)
    return structuredClone(file)
  })
  const result = { version: 1 as const, records, ...(standalone ? { standalone } : {}) }
  if (canonicalLedgerValue(raw) !== canonicalLedgerValue(result))
    throw new Error('Unsupported Ledger recovery journal fields')
  return result
}
export function exportLedgerRecoveryJournal(
  contract: LedgerRecoveryTransition['contract'],
  storage: Storage = localStorage,
) {
  const raw = storage.getItem(storeKey(contract.context.vaultId))
  return validateLedgerRecoveryJournal(contract, raw ? JSON.parse(raw) : { version: 1, records: [] })
}
function mergeRecord(old: LedgerRecoveryRecord | undefined, next: LedgerRecoveryRecord) {
  if (!old) return next
  if (canonicalLedgerValue(old.transition) !== canonicalLedgerValue(next.transition))
    throw new Error('Ledger recovery intent changed')
  for (const field of ['userPsbt', 'phoneAuthorization', 'guardianPsbt', 'txHex'] as const)
    if (
      old[field] !== undefined &&
      next[field] !== undefined &&
      canonicalLedgerValue(old[field]) !== canonicalLedgerValue(next[field])
    )
      throw new Error('Ledger recovery approval changed')
  return validateLedgerRecoveryRecord({ ...old, ...next })
}
export async function restoreLedgerRecoveryJournal(
  contract: LedgerRecoveryTransition['contract'],
  raw: unknown,
  storage: Storage = localStorage,
) {
  const incoming = validateLedgerRecoveryJournal(contract, raw)
  if (!navigator.locks) throw new Error('Exclusive recovery storage is unavailable')
  return navigator.locks.request(storeKey(contract.context.vaultId), async () => {
    const current = exportLedgerRecoveryJournal(contract, storage)
    for (const entry of incoming.records) {
      const conflict = current.records.find(
        (r) =>
          candidate(r) !== candidate(entry) &&
          !r.guardianPsbt &&
          r.transition.coin.txid === entry.transition.coin.txid &&
          r.transition.coin.vout === entry.transition.coin.vout,
      )
      if (conflict) throw new Error('Another recovery candidate for this output is still pending')
      const index = current.records.findIndex((r) => candidate(r) === candidate(entry))
      const merged = mergeRecord(current.records[index], entry)
      if (index < 0) current.records.push(merged)
      else current.records[index] = merged
    }
    for (const entry of incoming.standalone || []) {
      const view = validateSavingsRecovery(entry)
      current.standalone ??= []
      const index = current.standalone.findIndex((r) => validateSavingsRecovery(r).tx.id === view.tx.id)
      if (index < 0) current.standalone.push(entry)
      else {
        const old = current.standalone[index]
        const prior = validateSavingsRecovery(old).tx.getInput(0).tapScriptSig || []
        const added = view.tx.getInput(0).tapScriptSig || []
        const signatures = new Map(
          prior.map(([key, sig]) => [
            `${hex.encode(key.pubKey)}:${hex.encode(key.leafHash)}`,
            [key, sig] as (typeof prior)[number],
          ]),
        )
        for (const [key, sig] of added) {
          const id = `${hex.encode(key.pubKey)}:${hex.encode(key.leafHash)}`,
            previous = signatures.get(id)
          if (previous && hex.encode(previous[1]) !== hex.encode(sig))
            throw new Error('Stand-alone recovery signature changed')
          signatures.set(id, [key, sig])
        }
        view.tx.updateInput(0, { tapScriptSig: [...signatures.values()] })
        const psbt = acceptRecoveryPsbtSignatures(old.psbt, hex.encode(view.tx.toPSBT()), view.pubs)
        current.standalone[index] = { ...old, psbt }
      }
    }
    validateLedgerRecoveryJournal(contract, current)
    storage.setItem(storeKey(contract.context.vaultId), JSON.stringify(current))
    return current
  })
}
export async function saveLedgerRecoveryRecord(record: LedgerRecoveryRecord) {
  const valid = validateLedgerRecoveryRecord(record)
  const journal = await restoreLedgerRecoveryJournal(valid.transition.contract, { version: 1, records: [valid] })
  return journal.records.find((r) => candidate(r) === candidate(valid))!
}
export async function discardUnsignedLedgerRecoveryRecord(
  record: LedgerRecoveryRecord,
  storage: Storage = localStorage,
) {
  const valid = validateLedgerRecoveryRecord(record)
  if (!navigator.locks) throw new Error('Exclusive recovery storage is unavailable')
  await navigator.locks.request(storeKey(valid.transition.contract.context.vaultId), async () => {
    const journal = exportLedgerRecoveryJournal(valid.transition.contract, storage)
    const found = journal.records.find((r) => candidate(r) === candidate(valid))
    if (found?.userPsbt || found?.phoneAuthorization || found?.guardianPsbt || found?.txHex)
      throw new Error('An approved recovery candidate must be retained')
    journal.records = journal.records.filter((r) => candidate(r) !== candidate(valid))
    storage.setItem(storeKey(valid.transition.contract.context.vaultId), JSON.stringify(journal))
  })
}
export async function saveLedgerStandaloneRecovery(file: SavingsRecoveryFile) {
  const view = validateSavingsRecovery(file)
  if (!isLedgerRecoveryKit(view.kit)) throw new Error('Ledger recovery file required')
  const journal = await restoreLedgerRecoveryJournal(view.kit.descriptor.ledgerSavings, {
    version: 1,
    records: [],
    standalone: [file],
  })
  return journal.standalone!.find((r) => validateSavingsRecovery(r).tx.id === view.tx.id)!
}

/** Phone approval is persisted before HTTP; H/R approval needs no phone or passkey. */
export async function approveLedgerRecovery(
  input: LedgerRecoveryRecord,
  statusInput: VaultStatus,
  enrollmentInput?: EnrollmentSecrets,
  deps = { begin: beginPasskeySession, post: vaultPost, connect: connectLedgerSavings },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  let record = validateLedgerRecoveryRecord(input)
  const status = structuredClone(statusInput),
    enrollment = enrollmentInput ? structuredClone(enrollmentInput) : undefined
  const contract = ledgerEnrollmentFromStatus(status).savings
  if (canonicalLedgerValue(record.transition.contract) !== canonicalLedgerValue(contract))
    throw new Error('Recovery status changed')
  record = await saveLedgerRecoveryRecord(record)
  signal?.throwIfAborted()
  if (record.guardianPsbt) return record
  const view = inspectLedgerRecoveryTransition(record.transition)
  let session: Awaited<ReturnType<typeof beginPasskeySession>> | undefined
  let seed: Uint8Array | undefined
  const nodes: HDKey[] = []
  try {
    if (view.user === 'phone') {
      if (!enrollment?.ledgerSavings) throw new Error('Original passkey enrollment required for phone recovery')
      const saved = validateLedgerSavingsEnrollmentSecrets(enrollment.ledgerSavings, contract)
      session = await deps.begin('transition', status, enrollment.credId)
      signal?.throwIfAborted()
      if (hex.encode(session.derivedDirectPub) !== contract.context.phoneDirectP256)
        throw new Error('Passkey direct key differs from enrollment')
      if (!record.userPsbt) {
        seed = await unlockLedgerPhoneSeed(saved.phoneSeedBackup, session.prf, 'passkey-prf', contract.context)
        signal?.throwIfAborted()
        let account = HDKey.fromMasterSeed(seed, ledgerBip32Versions(contract.context.network))
        nodes.push(account)
        for (const index of contract.context.phone.path) {
          account = account.deriveChild(index)
          nodes.push(account)
        }
        const userPsbt = signLedgerRecoveryWithPhone(record.transition, account)
        const proof = attachLedgerRecoveryPhoneProof(
          record.transition,
          userPsbt,
          hex.encode(signDirectP256(session.scalar, ledgerRecoveryPhoneAuthorizationDigest(record.transition))),
        )
        record = await saveLedgerRecoveryRecord({ ...record, userPsbt, phoneAuthorization: proof.phoneAuthorization })
      }
      if (!record.phoneAuthorization) {
        const proof = attachLedgerRecoveryPhoneProof(
          record.transition,
          record.userPsbt!,
          hex.encode(signDirectP256(session.scalar, ledgerRecoveryPhoneAuthorizationDigest(record.transition))),
        )
        record = await saveLedgerRecoveryRecord({ ...record, phoneAuthorization: proof.phoneAuthorization })
      }
    } else if (!record.userPsbt) {
      const device = await deps.connect()
      try {
        signal?.throwIfAborted()
        record = await saveLedgerRecoveryRecord({
          ...record,
          userPsbt: await signLedgerRecoveryTransitionWithDevice(device.app, record.transition, signal),
        })
      } finally {
        await device.close()
      }
    }
    if (!record.userPsbt) throw new Error('Recovery user approval missing')
    signal?.throwIfAborted()
    const action = record.transition.action
    const response = await deps.post<{ signedPsbt: string; replay: boolean }>(`/v1/${action.kind}`, {
      vaultId: contract.context.vaultId,
      purpose: action.kind,
      // Recovery primitives retain hex; the existing HTTP contract uses Base64.
      psbt: base64.encode(hex.decode(record.userPsbt)),
      ledgerSavings: {
        claimant: action.claimant,
        change: action.change,
        ...(action.kind === 'clawback' ? { remainingUser: action.remainingUser } : {}),
      },
      ...(session ? session.assertion : {}),
      ...(record.phoneAuthorization ? { phoneAuthorization: record.phoneAuthorization } : {}),
    })
    const guardianPsbt = acceptLedgerRecoveryGuardianSignatures(
      record.transition,
      record.userPsbt,
      hex.encode(base64.decode(response.signedPsbt)),
    )
    const tx = Transaction.fromPSBT(hex.decode(guardianPsbt))
    tx.finalize()
    return await saveLedgerRecoveryRecord({ ...record, guardianPsbt, txHex: hex.encode(tx.extract()) })
  } finally {
    seed?.fill(0)
    nodes.forEach((n) => n.wipePrivateData())
    session?.prf.fill(0)
    session?.scalar.fill(0)
  }
}
