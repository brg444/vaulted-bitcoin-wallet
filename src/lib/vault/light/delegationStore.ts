import { recoveryFileStore } from '../recovery/fileStore'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import { validateGuardianSchedule, type GuardianDelegationPlan } from './delegationRequest'
import type { TxTreeNode } from '@arkade-os/sdk'
import { validateGuardianDelegationStatus, requireStatusMatchesRequest } from './delegationClient'

export interface GuardianDelegationRecovery {
  batchId: string
  batchExpiry: number
  commitmentPsbt: string
  vtxoTree: TxTreeNode[]
  connectors: TxTreeNode[]
}
export interface GuardianDelegationStatus {
  version: 1
  operationId: string
  descriptorHash: string
  state: string
  validAt: number
  expiresAt: number
  txid: string
  vout: number
  inputValueSats: number
  receiverSats: number
  commitmentTxid?: string
  receiverTxid?: string
  receiverVout?: number
  receiverExpiresAt?: number
  recovery?: GuardianDelegationRecovery
}
export interface SavedGuardianDelegation {
  plan?: GuardianDelegationPlan
  status?: GuardianDelegationStatus
  checkedAt?: string
  recoveryImported?: boolean
}
export interface GuardianDelegationJournal {
  version: 1
  descriptorHash: string
  operations: Record<string, SavedGuardianDelegation>
  checkedAt?: string
  available?: boolean
  error?: string
}
export const GUARDIAN_DELEGATION_EVENT = 'vaulted-guardian-delegation'
const key = (d: LightDescriptor) => `guardian-delegation:${d.vaultId}`
export async function loadGuardianDelegations(d: LightDescriptor): Promise<GuardianDelegationJournal> {
  const hash = lightDescriptorDigest(d)
  const journal = (await recoveryFileStore<GuardianDelegationJournal>(key(d))) || {
    version: 1,
    descriptorHash: hash,
    operations: {},
  }
  if (
    journal.version !== 1 ||
    journal.descriptorHash !== hash ||
    !journal.operations ||
    Object.keys(journal.operations).length > 512 ||
    JSON.stringify(journal).length > 8000000
  )
    throw new Error('Delegation journal does not match this wallet')
  for (const [id, operation] of Object.entries(journal.operations)) {
    if (!/^[0-9a-f]{32}$/.test(id) || (!operation.plan && !operation.status))
      throw new Error('Invalid saved delegation')
    if (operation.plan) {
      const facts = validateGuardianSchedule(operation.plan.request, d)
      if (
        operation.plan.request.operationId !== id ||
        facts.txid !== operation.plan.txid ||
        facts.vout !== operation.plan.vout ||
        facts.valueSats !== operation.plan.valueSats ||
        facts.receiverSats !== operation.plan.receiverSats ||
        facts.message.valid_at !== operation.plan.validAt
      )
        throw new Error('Saved delegation facts changed')
    }
    if (operation.status) {
      const status = validateGuardianDelegationStatus(operation.status, d, id)
      if (operation.plan) {
        requireStatusMatchesRequest(status, operation.plan.request)
        if (
          status.txid !== operation.plan.txid ||
          status.vout !== operation.plan.vout ||
          status.inputValueSats !== operation.plan.valueSats ||
          status.receiverSats !== operation.plan.receiverSats
        )
          throw new Error('Saved delegation identity changed')
      }
    }
  }
  return journal
}
/** Caller holds the per-vault delegation lock; the IDB transaction commits before any POST. */
export async function saveGuardianDelegations(d: LightDescriptor, journal: GuardianDelegationJournal) {
  if (
    journal.descriptorHash !== lightDescriptorDigest(d) ||
    Object.keys(journal.operations).length > 512 ||
    JSON.stringify(journal).length > 8000000
  )
    throw new Error('Delegation history cannot be saved completely')
  await recoveryFileStore(key(d), JSON.parse(JSON.stringify(journal)))
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(GUARDIAN_DELEGATION_EVENT, { detail: d.vaultId }))
}
