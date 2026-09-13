import { bindingFor } from '../../test/ledgerAccessFixture'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import * as webauthn from './webauthn'
import * as phoneBackup from './ledgerPhoneBackup'
import * as phoneEncryption from './signIn'
import { ledgerRecoveryFixture, ledgerFixturePRF, ledgerFixtureSeed } from './recovery/testdata/ledger'
import { unlockPhoneBip340, unlockLedgerSavingsSeed, unlockVaultPhoneKeys } from './savingsSpend'
import { scalarSecret } from './program/fixtures'
import {
  assertRecoveryBindingMatchesStatus,
  parseRecoveryBinding,
  recordFromRecoveryBinding,
  recoveryBindingDigest,
} from './passkeyBinding'
import type { EnrollmentSecrets } from './tenantEnrollment'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function credential(enrollment: EnrollmentSecrets, prf = ledgerFixturePRF.slice()) {
  return {
    rawId: hex.decode(enrollment.credId).buffer,
    getClientExtensionResults: () => ({ prf: { results: { first: prf.buffer } } }),
  }
}

describe('Spending phone access cancellation', () => {
  it.each(['before prompt', 'late PRF', 'late decryption'])('wipes owned material after %s', async (phase) => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    const abort = new AbortController()
    const prf = ledgerFixturePRF.slice()
    vi.spyOn(webauthn, 'prfFrom').mockReturnValue(prf)
    const decrypt = phoneEncryption.decryptPhoneSecret
    let secret: Uint8Array | undefined
    const decryptSpy = vi.spyOn(phoneEncryption, 'decryptPhoneSecret').mockImplementation(async (...args) => {
      secret = await decrypt(...args)
      abort.abort()
      return secret
    })
    const get = vi.fn(async (options: CredentialRequestOptions) => {
      expect(options.signal).toBe(abort.signal)
      if (phase === 'late PRF') abort.abort()
      return credential(enrollment)
    })
    vi.stubGlobal('navigator', { credentials: { get } })
    if (phase === 'before prompt') abort.abort()
    await expect(unlockPhoneBip340(enrollment, status, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    if (phase === 'before prompt') expect(get).not.toHaveBeenCalled()
    else expect(prf.every((byte) => byte === 0)).toBe(true)
    if (phase === 'late decryption') expect(secret!.every((byte) => byte === 0)).toBe(true)
    else expect(decryptSpy).not.toHaveBeenCalled()
  })
})

describe('Ledger passkey access keeps both phone identities', () => {
  it('does not prompt or decrypt after cancellation', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    const abort = new AbortController()
    abort.abort()
    const get = vi.fn()
    const decrypt = vi.spyOn(phoneBackup, 'unlockLedgerPhoneSeed')
    vi.stubGlobal('navigator', { credentials: { get } })
    await expect(unlockLedgerSavingsSeed(enrollment, status, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(get).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
  }, 60000)

  it('wipes an owned PRF returned after cancellation without decrypting a seed', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    const abort = new AbortController()
    const ownedPrf = ledgerFixturePRF.slice()
    vi.spyOn(webauthn, 'prfFrom').mockReturnValue(ownedPrf)
    const decrypt = vi.spyOn(phoneBackup, 'unlockLedgerPhoneSeed')
    const get = vi.fn(async (options: CredentialRequestOptions) => {
      expect(options.signal).toBe(abort.signal)
      abort.abort()
      return credential(enrollment)
    })
    vi.stubGlobal('navigator', { credentials: { get } })
    await expect(unlockLedgerSavingsSeed(enrollment, status, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(ownedPrf.every((byte) => byte === 0)).toBe(true)
    expect(decrypt).not.toHaveBeenCalled()
  }, 60000)

  it('wipes the decrypted seed and PRF when cancellation arrives during decryption', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    const abort = new AbortController()
    const ownedPrf = ledgerFixturePRF.slice()
    vi.spyOn(webauthn, 'prfFrom').mockReturnValue(ownedPrf)
    const decrypt = phoneBackup.unlockLedgerPhoneSeed
    let lateSeed: Uint8Array<ArrayBuffer> | undefined
    vi.spyOn(phoneBackup, 'unlockLedgerPhoneSeed').mockImplementation(async (...args) => {
      lateSeed = await decrypt(...args)
      expect(lateSeed).toEqual(ledgerFixtureSeed)
      abort.abort()
      return lateSeed
    })
    vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => credential(enrollment)) } })
    await expect(unlockLedgerSavingsSeed(enrollment, status, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(lateSeed).toBeDefined()
    expect(lateSeed!.every((byte) => byte === 0)).toBe(true)
    expect(ownedPrf.every((byte) => byte === 0)).toBe(true)
  }, 60000)

  it('unlocks both distinct secrets with one credential prompt and wipes the PRF', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    const prf = ledgerFixturePRF.slice(),
      get = vi.fn().mockResolvedValue(credential(enrollment, prf))
    const originalPrfFrom = webauthn.prfFrom
    let ownedPrf: Uint8Array | null = null
    vi.spyOn(webauthn, 'prfFrom').mockImplementation((value) => {
      ownedPrf = originalPrfFrom(value)
      return ownedPrf as Uint8Array<ArrayBuffer> | null
    })
    vi.stubGlobal('navigator', { credentials: { get } })
    const keys = await unlockVaultPhoneKeys(enrollment, status)
    try {
      expect(keys.spendingPhone).toEqual(scalarSecret(3))
      expect(keys.ledgerSavingsSeed).toEqual(ledgerFixtureSeed)
      expect(keys.spendingPhone).not.toEqual(keys.ledgerSavingsSeed)
      expect(get).toHaveBeenCalledTimes(1)
      expect(ownedPrf).not.toBeNull()
      expect(ownedPrf!.every((byte) => byte === 0)).toBe(true)
      expect(prf).toEqual(ledgerFixturePRF)
    } finally {
      keys.spendingPhone.fill(0)
      keys.ledgerSavingsSeed?.fill(0)
    }
  }, 60000)

  it('rejects changed Savings identity before any passkey prompt', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    const get = vi.fn()
    vi.stubGlobal('navigator', { credentials: { get } })
    enrollment.ledgerSavings.contract.context.phone.path[2] += 1
    await expect(unlockVaultPhoneKeys(enrollment, status)).rejects.toThrow()
    expect(get).not.toHaveBeenCalled()
  }, 60000)

  it('rejects missing or undecryptable Savings backups instead of returning only Spending', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    vi.stubGlobal('navigator', {
      credentials: { get: vi.fn().mockImplementation(() => Promise.resolve(credential(enrollment))) },
    })
    const missing: EnrollmentSecrets = { ...enrollment, ledgerSavings: undefined }
    await expect(unlockVaultPhoneKeys(missing, status)).rejects.toThrow()
    const broken = structuredClone(enrollment)
    broken.ledgerSavings.phoneSeedBackup.ciphertext = '00'.repeat(48)
    await expect(unlockVaultPhoneKeys(broken, status)).rejects.toThrow(/unlock/)
  }, 60000)

  it('retains the reviewed contract while a passkey prompt is open', async () => {
    const { enrollment, status } = await ledgerRecoveryFixture()
    Object.assign(status, { rpId: location.hostname, clientOrigin: location.origin })
    let resolve!: (value: unknown) => void
    const response = credential(enrollment)
    const get = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('navigator', { credentials: { get } })
    const pending = unlockLedgerSavingsSeed(enrollment, status)
    enrollment.ledgerSavings.phoneSeedBackup.ciphertext = 'ff'.repeat(48)
    status.ledgerSavings!.context.vaultId = '00'.repeat(16)
    resolve(response)
    const seed = await pending
    expect(seed).toEqual(ledgerFixtureSeed)
    seed.fill(0)
  }, 60000)
})

describe('Ledger version-six sign-in binding', () => {
  it.each([false, true])(
    'restores both enrollments and rejects stripped metadata (advanced=%s)',
    async (advanced) => {
      const { enrollment, status } = await ledgerRecoveryFixture(advanced)
      const binding = bindingFor(enrollment, status)
      expect(new TextEncoder().encode(binding).length).toBeLessThan(16 * 1024)
      const parsed = parseRecoveryBinding(binding)
      expect(assertRecoveryBindingMatchesStatus(parsed, status)).toEqual(parsed)
      expect(recordFromRecoveryBinding(parsed, status)).toEqual(enrollment)
      expect(() => recordFromRecoveryBinding(parsed)).toThrow(/status/)
      const payload = JSON.parse(String(parsed.ledgerSavingsBackup))
      delete payload.phoneSeedBackup
      expect(() =>
        assertRecoveryBindingMatchesStatus({ ...parsed, ledgerSavingsBackup: JSON.stringify(payload) }, status),
      ).toThrow()
    },
    60000,
  )

  it.each(['ledgerSavingsContextDigest', 'ledgerSavingsDescriptorHash', 'savingsAddress', 'spendingArkScript'])(
    'rejects %s substitution',
    async (field) => {
      const { enrollment, status } = await ledgerRecoveryFixture()
      const parsed = parseRecoveryBinding(bindingFor(enrollment, status))
      expect(() => assertRecoveryBindingMatchesStatus({ ...parsed, [field]: '00'.repeat(32) }, status)).toThrow()
    },
    60000,
  )

  it('does not hash an unknown binding under a legacy domain', () => {
    expect(() => recoveryBindingDigest(JSON.stringify({ version: 7 }))).toThrow(/version/)
    expect(recoveryBindingDigest(JSON.stringify({ version: 6 }))).not.toEqual(
      recoveryBindingDigest(JSON.stringify({ version: 4 })),
    )
  })
})
