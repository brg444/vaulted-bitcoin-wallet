// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCosignerClient } from './cosignerClient'
import {
  beginTenantEnrollment,
  completeLedgerTenantEnrollment,
  finishTenantEnrollment,
  reconcileStagedEnrollment,
  type EnrollmentRoles,
} from './tenantEnrollment'
import {
  ENROLL_STAGE_STORE,
  loadEnrollment,
  loadStagedEnrollment,
  saveStagedEnrollment,
  type StagedEnrollment,
} from './enrollmentStore'
import { ledgerFixturePRF, ledgerFixtureSeed, ledgerRecoveryFixture } from './recovery/testdata/ledger'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { hashLedgerSavingsEnrollment } from './program/ledgerRecoveryDescriptor'
import { scalarSecret } from './program/fixtures'
import { deleteBoardingKey, stageBoardingKey } from './vtxo/board'
import { generateLedgerPhoneSeed } from './ledgerPhoneBackup'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from './spendingPolicy'

vi.mock('./ledgerPhoneBackup', async (original) => ({
  ...(await original<typeof import('./ledgerPhoneBackup')>()),
  generateLedgerPhoneSeed: vi.fn(),
}))

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
}

type Fixture = Awaited<ReturnType<typeof ledgerRecoveryFixture>>
const cleanupVaults = new Set<string>()
const createCredential = vi.fn()
const getCredential = vi.fn()

function roles(f: Fixture): EnrollmentRoles {
  return {
    protectionTier: f.composite.savings.context.recovery ? 'advanced' : 'standard',
    hardwarePub: f.status.externalOwnerWalletPub!,
    ...(f.status.recoveryPub ? { recoveryPub: f.status.recoveryPub } : {}),
    spendingPolicy: f.composite.savings.spendingPolicy,
    ledger: {
      hardware: f.composite.savings.context.hardware,
      ...(f.composite.savings.context.recovery ? { recovery: f.composite.savings.context.recovery } : {}),
    },
  }
}

function staged(f: Fixture, registered = false): StagedEnrollment {
  const { ledgerSavings, ...enrollment } = f.enrollment
  const draft = {
    version: ledgerSavings.version,
    contract: ledgerSavings.contract,
    phoneSeedBackup: ledgerSavings.phoneSeedBackup,
  }
  return {
    ...enrollment,
    ...(registered ? { ledgerSavings } : {}),
    handle: 'saved-handle',
    userHandle: 'ab',
    clientDataJSON: '01',
    authenticatorData: '02',
    attestationObject: '03',
    hardwareXOnly: f.status.externalOwnerWalletPub!.slice(2),
    ...(f.status.recoveryPub ? { recoveryXOnly: f.status.recoveryPub.slice(2) } : {}),
    inviteToken: 'saved-enrollment-token',
    descriptorHash: hashLedgerSavingsEnrollment(f.composite),
    boardingPub: f.composite.boarding.boardingPub,
    boardingDescriptor: f.composite.boarding,
    boardingDescriptorHash: hashLedgerSavingsEnrollment(f.composite),
    savingsAddress: f.family.receive.address,
    savingsScript: f.status.savingsScript,
    protectionTier: f.composite.savings.context.recovery ? 'advanced' : 'standard',
    spendingPolicy: f.composite.savings.spendingPolicy,
    spendingPolicyDigest: f.composite.savings.context.policyDigest,
    ledgerSavingsDraft: draft,
    ledgerSavingsDescriptor: f.composite,
  }
}

async function fixture(advanced = false) {
  const f = await ledgerRecoveryFixture(advanced)
  cleanupVaults.add(f.status.vaultId)
  return f
}

function mockPublic(f: Fixture) {
  return vi.spyOn(vaultCosignerClient.enrollment, 'publicStatus').mockResolvedValue({
    ...f.status,
    enrollmentMode: 'invite',
    spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
    clientOrigin: location.origin,
    rpId: location.hostname,
    ledgerSavingsCapability: { version: 1, templateVersion: LEDGER_NATIVE_TEMPLATE },
  })
}

async function prepareBegin(f: Fixture) {
  mockPublic(f)
  vi.spyOn(vaultCosignerClient.enrollment, 'start').mockResolvedValue({
    vaultId: f.status.vaultId,
    challenge: 'ab'.repeat(32),
    handle: 'saved-handle',
    userId: 'ab',
    rpId: location.hostname,
    rpName: 'Vault',
    userName: 'fixture',
    timeoutMs: 60_000,
    protectionTier: f.composite.savings.context.recovery ? 'advanced' : 'standard',
    spendingPolicy: f.composite.savings.spendingPolicy,
    spendingPolicyDigest: f.composite.savings.context.policyDigest,
  })
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
  createCredential.mockResolvedValue({
    rawId: new Uint8Array(32).fill(0xab).buffer,
    getClientExtensionResults: () => ({ prf: { results: { first: Uint8Array.from(ledgerFixturePRF) } } }),
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getPublicKeyAlgorithm: () => -7,
      getPublicKey: () => spki,
      getAuthenticatorData: () => new Uint8Array([3]).buffer,
    },
  })
  vi.mocked(generateLedgerPhoneSeed).mockImplementation(() => Uint8Array.from(ledgerFixtureSeed))
  // Only the new Spending scalar uses 32 random bytes here. AES salts/nonces retain real randomness.
  const random = crypto.getRandomValues.bind(crypto)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (array instanceof Uint8Array && array.length === 32) {
      array.set(scalarSecret(3))
      return array
    }
    return random(array)
  })
  return vi.spyOn(vaultCosignerClient.enrollment, 'propose').mockResolvedValue({
    vaultId: f.status.vaultId,
    descriptor: f.composite,
    descriptorHash: hashLedgerSavingsEnrollment(f.composite),
  })
}

beforeEach(() => {
  vi.stubGlobal('Storage', MemoryStorage)
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('location', { hostname: 'localhost', origin: 'http://localhost:3003' })
  vi.stubGlobal('navigator', { credentials: { create: createCredential, get: getCredential } })
  localStorage.clear()
  createCredential.mockReset()
  getCredential.mockReset()
  vi.mocked(generateLedgerPhoneSeed).mockReset()
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: createCredential, get: getCredential },
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  localStorage.clear()
  for (const vaultId of cleanupVaults) await deleteBoardingKey(vaultId)
  cleanupVaults.clear()
  vi.unstubAllGlobals()
})

describe('Ledger enrollment commitment and interruption recovery', () => {
  it.each(['missing', 'version', 'template'] as const)(
    'rejects %s capability before allocating credentials or seeds',
    async (kind) => {
      const f = await fixture()
      const capability =
        kind === 'missing'
          ? undefined
          : {
              version: kind === 'version' ? 2 : 1,
              templateVersion: kind === 'template' ? 'retired-ledger-template' : LEDGER_NATIVE_TEMPLATE,
            }
      const publicStatus = mockPublic(f)
      publicStatus.mockResolvedValue({
        ...f.status,
        enrollmentMode: 'invite',
        spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
        ledgerSavingsCapability: capability,
      } as unknown as Awaited<ReturnType<typeof vaultCosignerClient.enrollment.publicStatus>>)
      const start = vi.spyOn(vaultCosignerClient.enrollment, 'start')
      await expect(beginTenantEnrollment('token', roles(f))).rejects.toThrow('not available')
      expect(start).not.toHaveBeenCalled()
      expect(createCredential).not.toHaveBeenCalled()
      expect(generateLedgerPhoneSeed).not.toHaveBeenCalled()
      expect(loadStagedEnrollment()).toBeNull()
    },
  )

  it('rejects a Spending key outside the selected account before creating a credential', async () => {
    const f = await fixture()
    mockPublic(f)
    const selected = roles(f)
    selected.hardwarePub = f.status.phoneBip340Pub!
    await expect(beginTenantEnrollment('token', selected)).rejects.toThrow('selected Ledger account')
    expect(createCredential).not.toHaveBeenCalled()
    expect(generateLedgerPhoneSeed).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'stages the exact proposal and encrypted seed without activating it (advanced=%s)',
    async (advanced) => {
      const f = await fixture(advanced)
      const propose = await prepareBegin(f)
      const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
      await expect(beginTenantEnrollment('token', roles(f))).resolves.toMatchObject({ ledgerDescriptor: f.composite })
      expect(propose).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({
          phoneBip340Pub: f.status.phoneBip340Pub,
          ledgerSavings: {
            templateVersion: LEDGER_NATIVE_TEMPLATE,
            phone: f.composite.savings.context.phone,
            ...roles(f).ledger,
          },
        }),
      )
      const saved = loadStagedEnrollment()!
      expect(saved.ledgerSavingsDescriptor).toEqual(f.composite)
      expect(saved.ledgerSavingsDraft!.phoneSeedBackup.phoneOrigin).toEqual(f.composite.savings.context.phone)
      expect(saved.ledgerSavings).toBeUndefined()
      expect(saved.credId).toBe('ab'.repeat(32))
      expect(finish).not.toHaveBeenCalled()
      expect(loadEnrollment(localStorage, f.status.vaultId)).toBeNull()
      expect(createCredential).toHaveBeenCalledTimes(1)
      expect(getCredential).not.toHaveBeenCalled()
    },
  )

  it.each(['hash', 'phone', 'hardware', 'recovery', 'vault', 'phone-direct', 'boarding', 'spending-script'] as const)(
    'rejects substituted proposal %s before staging or finish',
    async (field) => {
      const f = await fixture(true)
      const propose = await prepareBegin(f)
      const changed = structuredClone(f.composite)
      if (field === 'phone' || field === 'hardware' || field === 'recovery')
        changed.savings.context[field]!.fingerprint = 'ffffffff'
      if (field === 'vault') {
        changed.vaultId = 'ff'.repeat(16)
        changed.savings.context.vaultId = changed.vaultId
      }
      if (field === 'phone-direct')
        changed.savings.context.phoneDirectP256 = f.enrollment.webauthnP256.replace(
          /^0[23]/,
          f.enrollment.webauthnP256.startsWith('02') ? '03' : '02',
        )
      if (field === 'boarding') changed.boarding.boardingPub = changed.spendingAuthorities.phoneBip340Pub
      if (field === 'spending-script') changed.spendingAuthorities.spendingArkScript = '5120' + '11'.repeat(32)
      // An attacker can recompute the descriptor hash; the selected origins must still be pinned.
      propose.mockResolvedValue({
        vaultId: f.status.vaultId,
        descriptor: changed,
        descriptorHash:
          field === 'hash'
            ? '00'.repeat(32)
            : ['phone', 'hardware', 'recovery', 'vault'].includes(field)
              ? hashLedgerSavingsEnrollment(changed)
              : hashLedgerSavingsEnrollment(f.composite),
      })
      const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
      await expect(beginTenantEnrollment('token', roles(f))).rejects.toThrow()
      expect(loadStagedEnrollment()).toBeNull()
      expect(finish).not.toHaveBeenCalled()
    },
  )

  it('refuses finish and reconciliation until a matching registration is durably saved', async () => {
    const f = await fixture()
    saveStagedEnrollment(staged(f))
    const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
    vi.spyOn(vaultCosignerClient.enrollment, 'status').mockResolvedValue(f.status)
    await expect(finishTenantEnrollment('saved-enrollment-token')).rejects.toThrow()
    await expect(reconcileStagedEnrollment()).rejects.toThrow()
    expect(finish).not.toHaveBeenCalled()
    expect(loadStagedEnrollment()!.ledgerSavings).toBeUndefined()
    expect(loadEnrollment(localStorage, f.status.vaultId)).toBeNull()
  })

  it('persists registration before finish and resumes the same credential after a lost response', async () => {
    const f = await fixture(true)
    await stageBoardingKey({ vaultId: f.status.vaultId, network: 'mutinynet', phoneSecret: scalarSecret(3) })
    saveStagedEnrollment(staged(f))
    const registration = f.enrollment.ledgerSavings.registration
    const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish').mockImplementation(async (_token, request) => {
      expect(loadStagedEnrollment()!.ledgerSavings!.registration).toEqual(registration)
      expect(request.credentialId).toBe(f.enrollment.credId)
      expect(request.ledgerSavings).toEqual({
        templateVersion: LEDGER_NATIVE_TEMPLATE,
        phone: f.composite.savings.context.phone,
        ...roles(f).ledger,
      })
      throw new Error('response lost after server activation')
    })
    await expect(completeLedgerTenantEnrollment(registration)).rejects.toThrow('response lost')
    const saved = localStorage.getItem(ENROLL_STAGE_STORE)
    expect(saved).not.toBeNull()
    vi.spyOn(vaultCosignerClient.enrollment, 'status').mockResolvedValue(f.status)
    await expect(reconcileStagedEnrollment()).resolves.toMatchObject({ status: f.status })
    expect(finish).toHaveBeenCalledTimes(1)
    expect(loadStagedEnrollment()).toBeNull()
    expect(loadEnrollment(localStorage, f.status.vaultId)).toEqual(
      expect.objectContaining({
        credId: f.enrollment.credId,
        ledgerSavings: f.enrollment.ledgerSavings,
      }),
    )
    expect(createCredential).not.toHaveBeenCalled()
    expect(generateLedgerPhoneSeed).not.toHaveBeenCalled()
  })

  it('does not finish when durable registration storage fails', async () => {
    const f = await fixture()
    saveStagedEnrollment(staged(f))
    const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === ENROLL_STAGE_STORE) throw new Error('storage full')
      original.call(this, key, value)
    })
    await expect(completeLedgerTenantEnrollment(f.enrollment.ledgerSavings.registration)).rejects.toThrow(
      'storage full',
    )
    expect(finish).not.toHaveBeenCalled()
    expect(loadStagedEnrollment()!.ledgerSavings).toBeUndefined()
  })

  it.each(['receiveAddress', 'changeAddress', 'walletId', 'contextDigest'] as const)(
    'rejects foreign registration %s without overwriting the draft',
    async (field) => {
      const f = await fixture()
      saveStagedEnrollment(staged(f))
      const before = localStorage.getItem(ENROLL_STAGE_STORE)
      const registration = structuredClone(f.enrollment.ledgerSavings.registration)
      registration[field] = field.endsWith('Address') ? f.composite.boarding.address : '00'.repeat(32)
      const finish = vi.spyOn(vaultCosignerClient.enrollment, 'finish')
      await expect(completeLedgerTenantEnrollment(registration)).rejects.toThrow('registration does not match')
      expect(localStorage.getItem(ENROLL_STAGE_STORE)).toBe(before)
      expect(finish).not.toHaveBeenCalled()
    },
  )
})
