import { describe, expect, it } from 'vitest'
import { POLICY_VERSION } from './constants'
import { SAVINGS_TEMPLATE } from './program/constants'
import {
  addressPinStoreKey,
  bindStatusToLocalPin,
  clearAddressPin,
  loadAddressPin,
  loadStoredAddressPin,
  pinEnrolledStatus,
  pinFromEnrolledStatus,
  requireStatusMatchesPin,
  type AddressPinFields,
} from './pin'
import type { VaultStatus } from './types'
import { canonicalSpendingPolicy, defaultSpendingPolicy, spendingPolicyDigest } from './spendingPolicy'

const VAULT_ID = 'vault-test-current'

const PROGRAM_FIELDS = [
  'vaultId',
  'network',
  'protectionTier',
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

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function sampleStatus(over: Partial<VaultStatus> = {}): VaultStatus {
  const spendingPolicy = defaultSpendingPolicy()
  return {
    enrolled: true,
    network: 'mutinynet',
    clientOrigin: 'https://vault.example',
    rpId: 'vault.example',
    vaultId: VAULT_ID,
    templateVersion: SAVINGS_TEMPLATE,
    policyVersion: POLICY_VERSION,
    protectionTier: 'standard',
    savingsAddress: 'tb1psavings',
    savingsScript: '5120' + '11'.repeat(32),
    periodAllowance: 100000,
    periodSpent: 0,
    periodRemaining: 100000,
    txCap: 50000,
    absoluteFeeCap: 5000,
    feerateCapSatVb: 10,
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
    vtxoVaultCosignerPub: '02' + '22'.repeat(32),
    vtxoExitDelay: 4608,
    vtxoExitDelayUnit: 'seconds',
    spendingArkAddress: 'tark1spending',
    spendingArkScript: '5120' + '33'.repeat(32),
    vtxoDelegatePub: '02' + '44'.repeat(32),
    vtxoBoardingActive: true,
    vtxoBoardingProgram: 'vault-board-v1',
    vtxoBoardingAddress: 'tb1pboarding',
    vtxoBoardingScript: '5120' + '55'.repeat(32),
    vtxoBoardingExitDelay: 604672,
    vtxoBoardingExitDelayUnit: 'seconds',
    ...over,
  }
}

function tenantStatus(over: Partial<VaultStatus> = {}): VaultStatus {
  return sampleStatus({
    vaultId: 'tenant-b',
    savingsAddress: 'tb1pothersavingsaddress00000000000000000000000000000000000000',
    ...over,
  })
}

function mutatedValue(field: keyof AddressPinFields, value: AddressPinFields[keyof AddressPinFields]) {
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value + 1
  if (field === 'protectionTier') return value === 'standard' ? 'advanced' : 'standard'
  return field === 'vaultId' ? 'different-vault' : `${value}-different`
}

describe('local program pin', () => {
  it('does not pin a first enrolled status until the ceremony asks', () => {
    const storage = memoryStorage()
    expect(bindStatusToLocalPin(tenantStatus(), storage).vaultId).toBe('tenant-b')
    expect(loadStoredAddressPin(storage, 'tenant-b')).toBeNull()
    const first = pinEnrolledStatus(tenantStatus(), storage)
    expect(loadStoredAddressPin(storage, 'tenant-b')?.pinHash).toBe(first.pinHash)
    expect(() => pinEnrolledStatus(tenantStatus({ savingsAddress: 'tb1pattacker' }), storage)).toThrow(/local pin/)
  })

  it('does not synthesize a pin before enrollment commits one', () => {
    const storage = memoryStorage()
    expect(loadAddressPin(storage, VAULT_ID)).toBeNull()
    expect(loadStoredAddressPin(storage, VAULT_ID)).toBeNull()
    expect(bindStatusToLocalPin(sampleStatus({ savingsAddress: 'tb1pattacker' }), storage).savingsAddress).toBe(
      'tb1pattacker',
    )
  })

  it('rejects an incomplete enrolled status even before a pin exists', () => {
    const storage = memoryStorage()
    expect(() => bindStatusToLocalPin(sampleStatus({ spendingArkScript: undefined }), storage)).toThrow(
      /spendingArkScript required/,
    )
    expect(loadAddressPin(storage, VAULT_ID)).toBeNull()
  })

  it('does not treat an unenrolled status as a pin', () => {
    const storage = memoryStorage()
    expect(bindStatusToLocalPin(tenantStatus({ enrolled: false }), storage)).toMatchObject({ enrolled: false })
    expect(loadStoredAddressPin(storage, 'tenant-b')).toBeNull()
  })

  it('fails closed when an enrolled pinned status becomes unenrolled', () => {
    const storage = memoryStorage()
    pinEnrolledStatus(tenantStatus(), storage)
    expect(() => bindStatusToLocalPin(tenantStatus({ enrolled: false }), storage)).toThrow(/not enrolled/)
  })

  it('uses a fresh storage and hash domain with no old-pin fallback', () => {
    const storage = memoryStorage()
    storage.setItem(
      `arkade-vault-savings-pin-v1:tenant-b`,
      JSON.stringify({
        vaultId: 'tenant-b',
        savingsAddress: 'tb1pold',
        savingsScript: '5120' + '66'.repeat(32),
        pinHash: '77'.repeat(32),
        pinnedAt: new Date().toISOString(),
      }),
    )
    expect(addressPinStoreKey('tenant-b')).toBe('arkade-vault-program-pin-v1:tenant-b')
    expect(loadAddressPin(storage, 'tenant-b')).toBeNull()
  })

  it('freezes the program pin domain and field order', () => {
    expect(pinFromEnrolledStatus(sampleStatus()).pinHash).toBe(
      'adb92cb437635681608b351ac6f3c473a7201b87f25871b23161c1ad75ff383e',
    )
  })

  it.each(PROGRAM_FIELDS)('rejects status drift in %s', (field) => {
    const status = sampleStatus()
    const pin = pinFromEnrolledStatus(status)
    const changed = {
      ...status,
      [field]: mutatedValue(field, pin[field]),
      ...(field === 'protectionTier' ? { recoveryKeyPub: `02${'66'.repeat(32)}` } : {}),
    }
    expect(() => requireStatusMatchesPin(changed, pin)).toThrow(
      field === 'network' ? /unsupported Vault network/ : /local pin/,
    )
  })

  it('rejects status drift in the immutable spending policy or its digest', () => {
    const status = sampleStatus()
    const pin = pinFromEnrolledStatus(status)
    expect(() =>
      requireStatusMatchesPin(
        { ...status, spendingPolicy: { ...status.spendingPolicy!, txRecipientCapSats: 49_999 } },
        pin,
      ),
    ).toThrow()
    expect(() => requireStatusMatchesPin({ ...status, spendingPolicyDigest: '00'.repeat(32) }, pin)).toThrow()
  })

  it.each(['spendingPolicyCanonical', 'spendingPolicyDigest'] as const)(
    'rejects a stored pin whose %s was tampered or removed',
    (field) => {
      const storage = memoryStorage()
      const pin = pinEnrolledStatus(sampleStatus(), storage)
      const key = addressPinStoreKey(VAULT_ID)
      const tampered =
        field === 'spendingPolicyCanonical'
          ? canonicalSpendingPolicy({ ...defaultSpendingPolicy(), txRecipientCapSats: 49_999 })
          : '00'.repeat(32)
      storage.setItem(key, JSON.stringify({ ...pin, [field]: tampered }))
      expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(/program pin/)
      const missing = { ...pin } as Record<string, unknown>
      delete missing[field]
      storage.setItem(key, JSON.stringify(missing))
      expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(/incomplete program pin/)
    },
  )

  it.each(PROGRAM_FIELDS)('rejects an enrolled status missing %s', (field) => {
    const status = { ...sampleStatus() } as Record<string, unknown>
    delete status[field]
    expect(() => pinFromEnrolledStatus(status as unknown as VaultStatus)).toThrow()
  })

  it.each(PROGRAM_FIELDS)('rejects a stored pin whose %s was tampered', (field) => {
    const storage = memoryStorage()
    const pin = pinEnrolledStatus(sampleStatus(), storage)
    const key = addressPinStoreKey(VAULT_ID)
    storage.setItem(key, JSON.stringify({ ...pin, [field]: mutatedValue(field, pin[field]) }))
    expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(
      field === 'network' ? /unsupported Vault network/ : /program pin/,
    )
  })

  it.each([...PROGRAM_FIELDS, 'pinHash'] as const)('rejects a stored pin missing %s', (field) => {
    const storage = memoryStorage()
    const pin = pinEnrolledStatus(sampleStatus(), storage) as Record<string, unknown>
    delete pin[field]
    storage.setItem(addressPinStoreKey(VAULT_ID), JSON.stringify(pin))
    expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(/incomplete program pin/)
  })

  it('rejects extra or malformed stored pin fields', () => {
    const storage = memoryStorage()
    const pin = pinEnrolledStatus(sampleStatus(), storage)
    const key = addressPinStoreKey(VAULT_ID)
    storage.setItem(key, JSON.stringify({ ...pin, pinnedAt: new Date().toISOString() }))
    expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(/incomplete program pin/)
    storage.setItem(key, JSON.stringify({ ...pin, vtxoBoardingActive: 'true' }))
    expect(() => loadAddressPin(storage, VAULT_ID)).toThrow(/boolean/)
  })

  it('namespaces pins by vault id and keeps the Savings address directly available', () => {
    const storage = memoryStorage()
    pinEnrolledStatus(tenantStatus(), storage)
    expect(loadAddressPin(storage, 'tenant-b')).toMatchObject({
      vaultId: 'tenant-b',
      savingsAddress: tenantStatus().savingsAddress,
    })
  })

  it('clears only the requested vault pin', () => {
    const storage = memoryStorage()
    pinEnrolledStatus(tenantStatus(), storage)
    clearAddressPin(storage, 'tenant-b')
    expect(loadAddressPin(storage, 'tenant-b')).toBeNull()
  })
})

it('pins a mainnet policy against mainnet caps even in a Mutinynet build', () => {
  const storage = memoryStorage()
  const spendingPolicy = { ...defaultSpendingPolicy('mainnet'), absoluteFeeCapSats: 20000 }
  const status = {
    ...sampleStatus(),
    network: 'mainnet',
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy, 'mainnet'),
  }
  const pin = pinEnrolledStatus(status, storage)
  expect(loadAddressPin(storage, VAULT_ID)).toEqual(pin)
  expect(() => requireStatusMatchesPin(status, pin)).not.toThrow()
})
