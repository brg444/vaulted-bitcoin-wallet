import { requireSupportedVaultNetwork } from './constants'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, encodeUtf8 } from './hex'
import type { VaultStatus } from './types'
import { canonicalSpendingPolicy, spendingPolicyDigest, validateSpendingPolicy } from './spendingPolicy'
import { requireProtectionTier, requireProtectionTierMatchesRecovery, type ProtectionTier } from './protectionTier'

export const ADDRESS_PIN_STORE = 'arkade-vault-program-pin-v1'

const PROGRAM_PIN_DOMAIN = 'arkade-vault/program-pin/v1'

export type AddressPinFields = {
  vaultId: string
  network: string
  protectionTier: ProtectionTier
  spendingPolicyCanonical: string
  spendingPolicyDigest: string
  savingsAddress: string
  savingsScript: string
  vtxoVaultCosignerPub: string
  vtxoExitDelay: number
  vtxoExitDelayUnit: string
  spendingArkAddress: string
  spendingArkScript: string
  vtxoDelegatePub: string
  vtxoBoardingActive: boolean
  vtxoBoardingProgram: string
  vtxoBoardingAddress: string
  vtxoBoardingScript: string
  vtxoBoardingExitDelay: number
  vtxoBoardingExitDelayUnit: string
}

export type AddressPin = AddressPinFields & {
  pinHash: string
}

const PIN_FIELD_NAMES = [
  'vaultId',
  'network',
  'protectionTier',
  'spendingPolicyCanonical',
  'spendingPolicyDigest',
  'savingsAddress',
  'savingsScript',
  'vtxoVaultCosignerPub',
  'vtxoExitDelay',
  'vtxoExitDelayUnit',
  'spendingArkAddress',
  'spendingArkScript',
  'vtxoDelegatePub',
  'vtxoBoardingActive',
  'vtxoBoardingProgram',
  'vtxoBoardingAddress',
  'vtxoBoardingScript',
  'vtxoBoardingExitDelay',
  'vtxoBoardingExitDelayUnit',
] as const satisfies readonly (keyof AddressPinFields)[]

const STORED_PIN_FIELD_NAMES = [...PIN_FIELD_NAMES, 'pinHash'] as const

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw new Error(`${name} required`)
  return value
}

function requiredDelay(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function requestedPinId(vaultId: string): string {
  return requiredText(vaultId, 'vault id')
}

export function addressPinStoreKey(vaultId: string): string {
  return `${ADDRESS_PIN_STORE}:${requestedPinId(vaultId)}`
}

function appendText(parts: Uint8Array[], value: string) {
  const bytes = encodeUtf8(value)
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, bytes.length, false)
  parts.push(len, bytes)
}

function exactFields(value: unknown, names: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`incomplete ${label}`)
  const record = value as Record<string, unknown>
  const got = Object.keys(record)
  if (got.length !== names.length || names.some((name) => !Object.prototype.hasOwnProperty.call(record, name))) {
    throw new Error(`incomplete ${label}`)
  }
  return record
}

function requireAddressPinFields(value: unknown): AddressPinFields {
  const fields = exactFields(value, PIN_FIELD_NAMES, 'program pin fields')
  if (typeof fields.vtxoBoardingActive !== 'boolean') {
    throw new Error('vtxoBoardingActive must be boolean')
  }
  const policyCanonical = requiredText(fields.spendingPolicyCanonical, 'spendingPolicyCanonical')
  const policyDigest = requiredText(fields.spendingPolicyDigest, 'spendingPolicyDigest')
  const network = requireSupportedVaultNetwork(fields.network)
  const selected = validateSpendingPolicy(JSON.parse(policyCanonical) as unknown, network)
  if (
    canonicalSpendingPolicy(selected, network) !== policyCanonical ||
    spendingPolicyDigest(selected, network) !== policyDigest
  ) {
    throw new Error('program pin spending policy does not match its digest')
  }
  return {
    vaultId: requiredText(fields.vaultId, 'vaultId'),
    network,
    protectionTier: requireProtectionTier(fields.protectionTier),
    spendingPolicyCanonical: policyCanonical,
    spendingPolicyDigest: policyDigest,
    savingsAddress: requiredText(fields.savingsAddress, 'savingsAddress'),
    savingsScript: requiredText(fields.savingsScript, 'savingsScript'),
    vtxoVaultCosignerPub: requiredText(fields.vtxoVaultCosignerPub, 'vtxoVaultCosignerPub'),
    vtxoExitDelay: requiredDelay(fields.vtxoExitDelay, 'vtxoExitDelay'),
    vtxoExitDelayUnit: requiredText(fields.vtxoExitDelayUnit, 'vtxoExitDelayUnit'),
    spendingArkAddress: requiredText(fields.spendingArkAddress, 'spendingArkAddress'),
    spendingArkScript: requiredText(fields.spendingArkScript, 'spendingArkScript'),
    vtxoDelegatePub: requiredText(fields.vtxoDelegatePub, 'vtxoDelegatePub'),
    vtxoBoardingActive: fields.vtxoBoardingActive,
    vtxoBoardingProgram: requiredText(fields.vtxoBoardingProgram, 'vtxoBoardingProgram'),
    vtxoBoardingAddress: requiredText(fields.vtxoBoardingAddress, 'vtxoBoardingAddress'),
    vtxoBoardingScript: requiredText(fields.vtxoBoardingScript, 'vtxoBoardingScript'),
    vtxoBoardingExitDelay: requiredDelay(fields.vtxoBoardingExitDelay, 'vtxoBoardingExitDelay'),
    vtxoBoardingExitDelayUnit: requiredText(fields.vtxoBoardingExitDelayUnit, 'vtxoBoardingExitDelayUnit'),
  }
}

export function addressPinHash(input: AddressPinFields): string {
  const fields = requireAddressPinFields(input)
  const parts: Uint8Array[] = [encodeUtf8(PROGRAM_PIN_DOMAIN)]
  for (const name of PIN_FIELD_NAMES) appendText(parts, String(fields[name]))
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return bytesToHex(sha256(out))
}

export function pinFieldsFromStatus(status: VaultStatus): AddressPinFields {
  if (!status?.enrolled) throw new Error('authorizer is not enrolled')
  const network = requireSupportedVaultNetwork(status.network)
  const selected = validateSpendingPolicy(status.spendingPolicy, network)
  const digest = spendingPolicyDigest(selected, network)
  if (digest !== status.spendingPolicyDigest) throw new Error('status spending policy digest does not match')
  const protectionTier = requireProtectionTierMatchesRecovery(
    status.protectionTier,
    status.recoveryKeyPub || status.recoveryPub || '',
  )
  return requireAddressPinFields({
    vaultId: status.vaultId,
    network: status.network,
    protectionTier,
    spendingPolicyCanonical: canonicalSpendingPolicy(selected, network),
    spendingPolicyDigest: digest,
    savingsAddress: status.savingsAddress,
    savingsScript: status.savingsScript,
    vtxoVaultCosignerPub: status.vtxoVaultCosignerPub,
    vtxoExitDelay: status.vtxoExitDelay,
    vtxoExitDelayUnit: status.vtxoExitDelayUnit,
    spendingArkAddress: status.spendingArkAddress,
    spendingArkScript: status.spendingArkScript,
    vtxoDelegatePub: status.vtxoDelegatePub,
    vtxoBoardingActive: status.vtxoBoardingActive,
    vtxoBoardingProgram: status.vtxoBoardingProgram,
    vtxoBoardingAddress: status.vtxoBoardingAddress,
    vtxoBoardingScript: status.vtxoBoardingScript,
    vtxoBoardingExitDelay: status.vtxoBoardingExitDelay,
    vtxoBoardingExitDelayUnit: status.vtxoBoardingExitDelayUnit,
  })
}

export function pinFromEnrolledStatus(status: VaultStatus): AddressPin {
  const fields = pinFieldsFromStatus(status)
  return { ...fields, pinHash: addressPinHash(fields) }
}

function requireAddressPin(value: unknown, expectedVaultId: string): AddressPin {
  const record = exactFields(value, STORED_PIN_FIELD_NAMES, 'program pin')
  const fields = requireAddressPinFields(Object.fromEntries(PIN_FIELD_NAMES.map((name) => [name, record[name]])))
  const pinHash = requiredText(record.pinHash, 'pinHash')
  if (!/^[0-9a-f]{64}$/.test(pinHash)) throw new Error('program pin hash must be 32-byte lowercase hex')
  if (fields.vaultId !== expectedVaultId) throw new Error('program pin vault id does not match the local pin request')
  const hash = addressPinHash(fields)
  if (hash !== pinHash) throw new Error('local program pin hash does not match')
  return { ...fields, pinHash: hash }
}

export function requireStatusMatchesPin(status: VaultStatus, pin: AddressPin): VaultStatus {
  const fields = pinFieldsFromStatus(status)
  const validPin = requireAddressPin(pin, fields.vaultId)
  if (addressPinHash(fields) !== validPin.pinHash) {
    throw new Error('vault program does not match the local pin')
  }
  return status
}

export function loadStoredAddressPin(storage: Storage = localStorage, vaultId = ''): AddressPin | null {
  const id = requestedPinId(vaultId)
  const raw = storage.getItem(addressPinStoreKey(id))
  if (!raw) return null
  return requireAddressPin(JSON.parse(raw) as unknown, id)
}

export function loadAddressPin(storage: Storage = localStorage, vaultId = ''): AddressPin | null {
  return loadStoredAddressPin(storage, requestedPinId(vaultId))
}

export function saveAddressPin(pin: AddressPin, storage: Storage = localStorage): AddressPin {
  const id = requestedPinId(pin?.vaultId)
  const valid = requireAddressPin(pin, id)
  storage.setItem(addressPinStoreKey(valid.vaultId), JSON.stringify(valid))
  return valid
}

export function clearAddressPin(storage: Storage = localStorage, vaultId = '') {
  storage.removeItem(addressPinStoreKey(requestedPinId(vaultId)))
}

export function bindStatusToLocalPin(status: VaultStatus, storage: Storage = localStorage): VaultStatus {
  const id = String(status?.vaultId || '').trim()
  if (!id) {
    if (status?.enrolled) throw new Error('vault id required')
    return status
  }
  const existing = loadAddressPin(storage, id)
  if (existing) return requireStatusMatchesPin(status, existing)
  if (status.enrolled) pinFieldsFromStatus(status)
  return status
}

export function pinEnrolledStatus(status: VaultStatus, storage: Storage = localStorage): AddressPin {
  const id = requestedPinId(status?.vaultId)
  const existing = loadAddressPin(storage, id)
  if (existing) {
    requireStatusMatchesPin(status, existing)
    return existing
  }
  return saveAddressPin(pinFromEnrolledStatus(status), storage)
}
