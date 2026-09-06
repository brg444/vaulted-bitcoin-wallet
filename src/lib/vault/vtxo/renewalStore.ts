import { recoveryFileStore } from '../recovery/fileStore'
import type { VaultStatus } from '../types'
import { guardianRenewalContextDigest } from './renewalContext'
import { validateSpendingRenewalSet, type SpendingRenewalSet } from './renewalSet'
import { validateSpendingSchedule, type SpendingDelegationPlan } from './renewalRequest'
import {
  requireSpendingRenewalMatchesPlan,
  validateSpendingRenewalStatus,
  type SpendingRenewalStatus,
} from './renewalClient'

export interface SpendingRenewalJournal {
  version: 1
  descriptorHash: string
  sets: Record<string, SpendingRenewalSet>
  operations: Record<
    string,
    { plan?: SpendingDelegationPlan; status?: SpendingRenewalStatus; recoveryImported?: boolean }
  >
  checkedAt?: string
  available?: boolean
  error?: string
}
export const SPENDING_RENEWAL_EVENT = 'vaulted-spending-renewal'
const key = (status: VaultStatus) => `spending-renewal:${status.vaultId}`

function validate(journal: SpendingRenewalJournal, status: VaultStatus) {
  if (
    !journal ||
    journal.version !== 1 ||
    journal.descriptorHash !== guardianRenewalContextDigest(status) ||
    !journal.sets ||
    !journal.operations ||
    Object.keys(journal.operations).length > 512 ||
    Object.keys(journal.sets).length > 512 ||
    JSON.stringify(journal).length > 8_000_000
  )
    throw new Error('Renewal journal does not match this wallet')
  for (const [id, set] of Object.entries(journal.sets)) {
    if (id !== set.setId) throw new Error('Saved renewal set identity changed')
    validateSpendingRenewalSet(set, status)
    for (const item of set.plans) {
      const saved = journal.operations[item.operationId]?.plan
      if (
        !saved ||
        JSON.stringify(saved.request) !==
          JSON.stringify({
            program: set.program,
            descriptorHash: set.descriptorHash,
            vaultId: set.vaultId,
            operationId: item.operationId,
            intent: item.intent,
            forfeitTxs: item.forfeitTxs,
            deleteIntent: item.deleteIntent,
            expiresAt: item.expiresAt,
            ownerSignature: item.ownerSignature,
          })
      )
        throw new Error('Saved renewal set lost an authorized plan')
    }
  }
  for (const [id, entry] of Object.entries(journal.operations)) {
    if (!/^[0-9a-f]{32}$/.test(id) || (!entry.plan && !entry.status)) throw new Error('Invalid saved renewal')
    if (entry.plan) {
      const facts = validateSpendingSchedule(entry.plan.request, status)
      if (
        entry.plan.request.operationId !== id ||
        facts.txid !== entry.plan.txid ||
        facts.vout !== entry.plan.vout ||
        facts.valueSats !== entry.plan.valueSats ||
        facts.receiverSats !== entry.plan.receiverSats ||
        facts.message.valid_at !== entry.plan.validAt
      )
        throw new Error('Saved renewal facts changed')
    }
    if (entry.status) {
      validateSpendingRenewalStatus(entry.status, status, id)
      if (entry.plan) requireSpendingRenewalMatchesPlan(entry.status, entry.plan.request, status)
    }
  }
  return journal
}
export async function loadSpendingRenewals(status: VaultStatus) {
  return validate(
    (await recoveryFileStore<SpendingRenewalJournal>(key(status))) || {
      version: 1,
      descriptorHash: guardianRenewalContextDigest(status),
      sets: {},
      operations: {},
    },
    status,
  )
}
/** Caller holds the per-vault lock. All exact signed bytes commit before any schedule POST. */
export async function saveSpendingRenewals(status: VaultStatus, journal: SpendingRenewalJournal) {
  validate(journal, status)
  await recoveryFileStore(key(status), structuredClone(journal))
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(SPENDING_RENEWAL_EVENT, { detail: status.vaultId }))
}
