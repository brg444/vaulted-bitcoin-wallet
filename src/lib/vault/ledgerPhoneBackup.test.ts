// @vitest-environment node
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveLedgerPhoneAccount,
  generateLedgerPhoneSeed,
  unlockLedgerPhoneSeed,
  validateLedgerPhoneSeedBackup,
  wrapLedgerPhoneSeed,
  type LedgerPhoneSeedBackup,
} from './ledgerPhoneBackup'
import { ledgerSavingsContextDigest, type LedgerSavingsKeyContext } from './program/ledgerNativeKeys'
import vectors from './program/ledger-key-vectors.json'

const seed = new Uint8Array(32).fill(0x43)
const material = new Uint8Array(32).fill(0x71)
const contexts = vectors.map((vector) => vector.input as LedgerSavingsKeyContext)
const context = contexts[0]
const changedHex = (value: string) => (value.startsWith('00') ? '01' : '00') + value.slice(2)

// A party possessing the wrapping key can authenticate a malformed payload;
// restoration must still prove that its seed owns the enrolled BIP86 account.
async function encryptPayload(backup: LedgerPhoneSeedBackup, plaintext: Uint8Array) {
  const header = Object.fromEntries(Object.entries(backup).filter(([key]) => key !== 'ciphertext'))
  const input = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Uint8Array.from(hex.decode(backup.salt)),
      info: new TextEncoder().encode(`vaulted-ledger-savings/phone-seed-encryption/v1/${backup.purpose}`),
    },
    input,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  return {
    ...backup,
    ciphertext: hex.encode(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: Uint8Array.from(hex.decode(backup.nonce)),
            additionalData: new TextEncoder().encode(JSON.stringify(header)),
            tagLength: 128,
          },
          key,
          Uint8Array.from(plaintext),
        ),
      ),
    ),
  }
}

describe('Ledger Savings phone HD seed backup', () => {
  it('generates fresh independent 32-byte seeds without exposing a private account', () => {
    const first = generateLedgerPhoneSeed()
    const second = generateLedgerPhoneSeed()
    try {
      expect(first).toHaveLength(32)
      expect(second).toHaveLength(32)
      expect(first).not.toEqual(second)
      expect(Object.keys(deriveLedgerPhoneAccount(first, 'mainnet')).sort()).toEqual(['fingerprint', 'path', 'xpub'])
    } finally {
      first.fill(0)
      second.fill(0)
    }
  })

  for (const enrolled of contexts) {
    const label = `${enrolled.network} ${enrolled.recovery ? 'Advanced' : 'Standard'}`
    it(`matches the independent shared phone account vector for ${label}`, () => {
      expect(deriveLedgerPhoneAccount(seed, enrolled.network)).toEqual(enrolled.phone)
    })

    it.each(['passkey-prf', 'recovery-secret'] as const)(`round trips ${label} using %s`, async (purpose) => {
      const backup = await wrapLedgerPhoneSeed(seed, material, purpose, enrolled)
      expect(JSON.stringify(backup)).not.toContain(hex.encode(seed))
      expect(JSON.stringify(backup)).not.toContain(hex.encode(material))
      expect(backup.contextDigest).toBe(hex.encode(ledgerSavingsContextDigest(enrolled)))
      expect(backup.phoneOrigin).toEqual(enrolled.phone)
      const parsed = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(backup))).reverse())
      const restored = await unlockLedgerPhoneSeed(parsed, material, purpose, enrolled)
      try {
        expect(restored).toEqual(seed)
        expect(deriveLedgerPhoneAccount(restored, enrolled.network)).toEqual(enrolled.phone)
      } finally {
        restored.fill(0)
      }
      expect(seed).toEqual(new Uint8Array(32).fill(0x43))
      expect(material).toEqual(new Uint8Array(32).fill(0x71))
    })
  }

  it('supports the enrolled account boundary and rejects arbitrary origins or networks', () => {
    for (const network of ['mainnet', 'mutinynet'] as const) {
      const origin = deriveLedgerPhoneAccount(seed, network, 100)
      expect(origin.path).toEqual([0x80000056, network === 'mainnet' ? 0x80000000 : 0x80000001, 0x80000064])
      expect(origin.fingerprint).toBe(context.phone.fingerprint)
      expect(origin.xpub).toMatch(network === 'mainnet' ? /^xpub/ : /^tpub/)
    }
    for (const account of [-1, 0.5, 101, NaN, 0x80000000])
      expect(() => deriveLedgerPhoneAccount(seed, 'mainnet', account)).toThrow('account')
    expect(() => deriveLedgerPhoneAccount(seed, 'testnet' as 'mainnet')).toThrow('unsupported Vault network')
    expect(() => deriveLedgerPhoneAccount(new Uint8Array(16), 'mainnet')).toThrow('32 bytes')
  })

  it('uses fresh salts and nonces, and binds the key to its backup purpose', async () => {
    const first = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    const second = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    expect(first.salt).not.toBe(second.salt)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    await expect(unlockLedgerPhoneSeed(first, material, 'recovery-secret', context)).rejects.toThrow('purpose')
    await expect(
      unlockLedgerPhoneSeed({ ...first, purpose: 'recovery-secret' }, material, 'recovery-secret', context),
    ).rejects.toThrow('Unable to unlock')
  })

  it('rejects incorrect wrapping keys and tampered encrypted fields', async () => {
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    await expect(unlockLedgerPhoneSeed(backup, new Uint8Array(32).fill(0x72), 'passkey-prf', context)).rejects.toThrow(
      'Unable to unlock',
    )
    for (const field of ['salt', 'nonce', 'ciphertext'] as const) {
      await expect(
        unlockLedgerPhoneSeed({ ...backup, [field]: changedHex(backup[field]) }, material, 'passkey-prf', context),
      ).rejects.toThrow('Unable to unlock')
    }
  })

  it('rejects another vault, policy, network, tier, phone origin or authentication binding', async () => {
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    const changed = [
      { ...context, vaultId: 'bb'.repeat(16) },
      { ...context, policyDigest: 'bb'.repeat(32) },
      { ...context, phone: { ...context.phone, fingerprint: changedHex(context.phone.fingerprint) } },
      { ...context, phone: deriveLedgerPhoneAccount(seed, context.network, 1) },
      { ...context, phoneDirectP256: `03${context.phoneDirectP256.slice(2)}` },
      ...contexts.slice(1),
    ]
    for (const other of changed) {
      expect(() => validateLedgerPhoneSeedBackup(backup, other)).toThrow()
      // Even replacing the public enrollment metadata cannot move this ciphertext to another context.
      await expect(
        unlockLedgerPhoneSeed(
          {
            ...backup,
            contextDigest: hex.encode(ledgerSavingsContextDigest(other)),
            phoneOrigin: other.phone,
          },
          material,
          'passkey-prf',
          other,
        ),
      ).rejects.toThrow('Unable to unlock')
    }
  })

  it('requires the seed to own the complete enrolled origin before encryption and after decryption', async () => {
    const wrongSeed = new Uint8Array(32).fill(0x45)
    await expect(wrapLedgerPhoneSeed(wrongSeed, material, 'passkey-prf', context)).rejects.toThrow('account origin')
    const wrongFingerprint = {
      ...context,
      phone: { ...context.phone, fingerprint: changedHex(context.phone.fingerprint) },
    }
    await expect(wrapLedgerPhoneSeed(seed, material, 'passkey-prf', wrongFingerprint)).rejects.toThrow('account origin')
    const wrongPath = { ...context, phone: { ...context.phone, path: [0x80000056, 0x80000001, 0x80000001] } }
    await expect(wrapLedgerPhoneSeed(seed, material, 'passkey-prf', wrongPath)).rejects.toThrow()
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    const wrongPayload = await encryptPayload(backup, wrongSeed)
    await expect(unlockLedgerPhoneSeed(wrongPayload, material, 'passkey-prf', context)).rejects.toThrow(
      'Unable to unlock',
    )
    const forged = await encryptPayload(
      {
        ...backup,
        contextDigest: hex.encode(ledgerSavingsContextDigest(wrongFingerprint)),
        phoneOrigin: wrongFingerprint.phone,
      },
      seed,
    )
    await expect(unlockLedgerPhoneSeed(forged, material, 'passkey-prf', wrongFingerprint)).rejects.toThrow(
      'Unable to unlock',
    )
  })

  it('strictly parses a versioned envelope and returns detached public metadata', async () => {
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    for (const patch of [
      { name: 'vaulted-light-owner-key' },
      { version: 0 },
      { purpose: 'password' },
      { contextDigest: backup.contextDigest.toUpperCase() },
      { salt: backup.salt.toUpperCase() },
      { nonce: '00' },
      { ciphertext: backup.ciphertext.slice(2) },
      { extra: true },
      { [Symbol('extra')]: true },
      { phoneOrigin: { ...backup.phoneOrigin, extra: true } },
      { phoneOrigin: { ...backup.phoneOrigin, path: [...backup.phoneOrigin.path, 0] } },
      { phoneOrigin: { ...backup.phoneOrigin, fingerprint: backup.phoneOrigin.fingerprint.toUpperCase() } },
      { phoneOrigin: { ...backup.phoneOrigin, xpub: context.hardware.xpub } },
    ]) {
      expect(() => validateLedgerPhoneSeedBackup({ ...backup, ...patch }, context)).toThrow()
    }
    for (const value of [null, [], JSON.stringify(backup), { ...backup, salt: undefined }])
      expect(() => validateLedgerPhoneSeedBackup(value, context)).toThrow()
    const missing = { ...backup }
    Reflect.deleteProperty(missing, 'nonce')
    expect(() => validateLedgerPhoneSeedBackup(missing, context)).toThrow()
    const parsed = validateLedgerPhoneSeedBackup(backup, context)
    parsed.phoneOrigin.path[0] = 0
    expect(backup.phoneOrigin.path).toEqual(context.phone.path)
  })

  it('rejects non-32-byte material without modifying caller-owned inputs', async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      await expect(wrapLedgerPhoneSeed(new Uint8Array(length), material, 'passkey-prf', context)).rejects.toThrow(
        '32 bytes',
      )
      await expect(wrapLedgerPhoneSeed(seed, new Uint8Array(length), 'passkey-prf', context)).rejects.toThrow(
        '32 bytes',
      )
    }
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    await expect(unlockLedgerPhoneSeed(backup, new Uint8Array(31), 'passkey-prf', context)).rejects.toThrow('32 bytes')
    expect(seed).toEqual(new Uint8Array(32).fill(0x43))
    expect(material).toEqual(new Uint8Array(32).fill(0x71))
  })

  it('wipes owned encryption material and every derived private node', async () => {
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt')
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const wipe = HDKey.prototype.wipePrivateData
    const privateKeys: Uint8Array[] = []
    vi.spyOn(HDKey.prototype, 'wipePrivateData').mockImplementation(function (this: HDKey) {
      privateKeys.push(this.privateKey!)
      return wipe.call(this)
    })
    await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    expect(privateKeys).toHaveLength(4)
    expect(privateKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(encrypt.mock.calls[0][2]).toEqual(new Uint8Array(32))
    expect(importKey.mock.calls[0][1]).toEqual(new Uint8Array(32))
    expect(seed[0]).toBe(0x43)
    expect(material[0]).toBe(0x71)
  })

  it('wipes partial private derivations when a child coordinate cannot be honored', () => {
    const deriveChild = HDKey.prototype.deriveChild
    const retained: Uint8Array[] = []
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementationOnce(function (this: HDKey, index) {
      retained.push(this.privateKey!)
      const child = deriveChild.call(this, index + 1)
      retained.push(child.privateKey!)
      return child
    })
    expect(() => deriveLedgerPhoneAccount(seed, 'mainnet')).toThrow('derivation')
    expect(retained).toHaveLength(2)
    expect(retained.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(seed[0]).toBe(0x43)
  })

  it('wipes decrypted plaintext when the authenticated payload has the wrong seed', async () => {
    const backup = await wrapLedgerPhoneSeed(seed, material, 'passkey-prf', context)
    const wrongPayload = await encryptPayload(backup, new Uint8Array(32).fill(0x45))
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    let plaintext: ArrayBuffer | undefined
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      plaintext = await decrypt(...args)
      return plaintext
    })
    await expect(unlockLedgerPhoneSeed(wrongPayload, material, 'passkey-prf', context)).rejects.toThrow(
      'Unable to unlock',
    )
    expect(new Uint8Array(plaintext!)).toEqual(new Uint8Array(32))
  })
})
