import type { EnrollmentSecrets } from './tenantEnrollment'
import type { SpendingPolicy } from './spendingPolicy'
import type { ProtectionTier } from './protectionTier'
import type { LedgerSavingsEnrollmentSecrets } from './program/ledgerEnrollment'
import type { LedgerSavingsEnrollmentDescriptor } from './program/ledgerRecoveryDescriptor'

export const ENROLL_STORE = 'arkade-vault-v2:enrollment'
export const SELECTED_VAULT_STORE = 'arkade-vault-v2:selected-vault'
export const ENROLL_STAGE_STORE = 'arkade-vault-v2:enrollment-staged'
export const SESSION_LOCK_STORE = 'arkade-vault-v2:session-lock'

function requestedEnrollmentId(vaultId: string): string {
  const id = String(vaultId || '').trim()
  if (!id) throw new Error('vault id required')
  return id
}

export function enrollmentStoreKey(vaultId: string): string {
  return `${ENROLL_STORE}:${requestedEnrollmentId(vaultId)}`
}

function parseEnrollment(raw: string | null): EnrollmentSecrets | null {
  if (!raw) return null
  const rec = JSON.parse(raw) as EnrollmentSecrets
  if (!rec.credId || !rec.ciphertext || !rec.phoneBip340Pub) return null
  return rec
}

function bindEnrollment(rec: EnrollmentSecrets | null, vaultId: string): EnrollmentSecrets | null {
  if (!rec) return null
  if (rec.vaultId && rec.vaultId !== vaultId) {
    throw new Error('enrollment record vault id does not match')
  }
  return { ...rec, vaultId }
}

export function loadEnrollment(storage: Storage = localStorage, vaultId = ''): EnrollmentSecrets | null {
  const id = requestedEnrollmentId(vaultId)
  const namespaced = bindEnrollment(parseEnrollment(storage.getItem(enrollmentStoreKey(id))), id)
  return namespaced
}

export function saveEnrollment(rec: EnrollmentSecrets, storage: Storage = localStorage, vaultId = rec.vaultId) {
  const id = requestedEnrollmentId(vaultId)
  if (rec.vaultId && rec.vaultId !== id) {
    throw new Error('enrollment record vault id does not match')
  }
  storage.setItem(enrollmentStoreKey(id), JSON.stringify({ ...rec, vaultId: id }))
}

export function clearEnrollment(storage: Storage = localStorage, vaultId = '') {
  const id = requestedEnrollmentId(vaultId)
  storage.removeItem(enrollmentStoreKey(id))
}

export function loadSelectedVaultId(storage: Storage = localStorage): string | null {
  const id = String(storage.getItem(SELECTED_VAULT_STORE) || '').trim()
  return id || null
}

export function saveSelectedVaultId(vaultId: string, storage: Storage = localStorage) {
  const id = String(vaultId || '').trim()
  if (!id) throw new Error('vault id required')
  storage.setItem(SELECTED_VAULT_STORE, id)
}

export function clearSelectedVaultId(storage: Storage = localStorage) {
  storage.removeItem(SELECTED_VAULT_STORE)
}

export function loadSessionLocked(storage: Storage = localStorage): boolean {
  return storage.getItem(SESSION_LOCK_STORE) === '1'
}

export function setSessionLocked(locked: boolean, storage: Storage = localStorage) {
  if (locked) storage.setItem(SESSION_LOCK_STORE, '1')
  else storage.removeItem(SESSION_LOCK_STORE)
}

export function findStoredEnrollment(storage: Storage = localStorage): EnrollmentSecrets | null {
  const selected = loadSelectedVaultId(storage)
  if (selected) {
    const rec = loadEnrollment(storage, selected)
    if (rec) return rec
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(`${ENROLL_STORE}:`)) continue
    const rec = parseEnrollment(storage.getItem(key))
    if (rec) return bindEnrollment(rec, rec.vaultId || key.slice(ENROLL_STORE.length + 1))
  }
  return null
}

export type StagedEnrollment = EnrollmentSecrets & {
  spendingDescriptor?: import('./spendingEnrollment').SpendingEnrollmentDescriptor
  ledgerSavingsDraft?: Omit<LedgerSavingsEnrollmentSecrets, 'registration'>
  ledgerSavingsDescriptor?: LedgerSavingsEnrollmentDescriptor
  handle: string
  userHandle: string
  clientDataJSON: string
  authenticatorData: string
  attestationObject: string
  hardwareXOnly: string
  recoveryXOnly?: string
  inviteToken?: string
  descriptorHash?: string
  boardingPub?: string
  boardingDescriptor?: unknown
  boardingDescriptorHash?: string
  savingsAddress?: string
  savingsScript?: string
  protectionTier: ProtectionTier
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
  connectorPub?: string
  connectorType?: 'p2wpkh' | 'p2tr'
  connectorFingerprint?: number
  connectorPath?: number[]
  connectorDescriptorHash?: string
  connectorSavingsAddress?: string
  connectorSavingsScript?: string
  connectorNetwork?: 'mainnet' | 'mutinynet'
  connectorArkadeOrigin?: string
  connectorArkadeVersion?: string
}

export function loadStagedEnrollment(storage: Storage = localStorage): StagedEnrollment | null {
  const rec = parseEnrollment(storage.getItem(ENROLL_STAGE_STORE)) as StagedEnrollment | null
  if (
    !rec?.vaultId ||
    !rec.handle ||
    !rec.credId ||
    !rec.ciphertext ||
    !rec.protectionTier ||
    !rec.spendingPolicy ||
    !rec.spendingPolicyDigest
  )
    return null
  return rec
}

export function saveStagedEnrollment(rec: StagedEnrollment, storage: Storage = localStorage) {
  const id = String(rec.vaultId || '').trim()
  if (!id) throw new Error('vault id required')
  if (!rec.handle || !rec.credId || !rec.ciphertext) throw new Error('staged enrollment incomplete')
  storage.setItem(ENROLL_STAGE_STORE, JSON.stringify(rec))
  saveSelectedVaultId(id, storage)
}

export function clearStagedEnrollment(storage: Storage = localStorage) {
  storage.removeItem(ENROLL_STAGE_STORE)
}

export function promoteStagedEnrollment(rec: EnrollmentSecrets, storage: Storage = localStorage) {
  const id = String(rec.vaultId || '').trim()
  if (!id) throw new Error('vault id required')
  saveEnrollment(rec, storage, id)
  saveSelectedVaultId(id, storage)
  clearStagedEnrollment(storage)
}
