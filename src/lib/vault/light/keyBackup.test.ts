import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { buildLightDescriptor, lightDescriptorDigest, type LightDescriptor } from './contract'
import { unlockLightOwnerKey, validateLightKeyBackup, wrapLightOwnerKey } from './keyBackup'
import vectors from './testdata/contracts.json'

const descriptor = vectors[0].descriptor as LightDescriptor
const owner = hex.decode('00'.repeat(31) + '01')
const material = new Uint8Array(32).fill(7)

describe('Light encrypted owner-key backup', () => {
  it.each(['passkey-prf', 'recovery-secret'] as const)(
    'restores with %s and leaves caller-owned input intact',
    async (purpose) => {
      const backup = await wrapLightOwnerKey(owner, material, purpose, descriptor)
      expect(JSON.stringify(backup)).not.toContain(hex.encode(owner))
      expect(JSON.stringify(backup)).not.toContain(hex.encode(material))
      const restored = await unlockLightOwnerKey(JSON.parse(JSON.stringify(backup)), material, purpose, descriptor)
      expect(restored).toEqual(owner)
      expect(hex.encode(schnorr.getPublicKey(restored))).toBe(descriptor.ownerPub)
      restored.fill(0)
      expect(owner[31]).toBe(1)
      expect(material).toEqual(new Uint8Array(32).fill(7))
    },
  )

  it('uses fresh salts and nonces for repeated backups', async () => {
    const first = await wrapLightOwnerKey(owner, material, 'passkey-prf', descriptor)
    const second = await wrapLightOwnerKey(owner, material, 'passkey-prf', descriptor)
    expect(first.salt).not.toBe(second.salt)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('rejects wrong secrets, altered ciphertext, nonce, salt and purpose', async () => {
    const backup = await wrapLightOwnerKey(owner, material, 'passkey-prf', descriptor)
    await expect(unlockLightOwnerKey(backup, new Uint8Array(32).fill(8), 'passkey-prf', descriptor)).rejects.toThrow(
      'Unable to unlock',
    )
    for (const field of ['ciphertext', 'nonce', 'salt'] as const) {
      const changed = { ...backup, [field]: (backup[field].startsWith('00') ? '01' : '00') + backup[field].slice(2) }
      await expect(unlockLightOwnerKey(changed, material, 'passkey-prf', descriptor)).rejects.toThrow(
        'Unable to unlock',
      )
    }
    await expect(unlockLightOwnerKey(backup, material, 'recovery-secret', descriptor)).rejects.toThrow('purpose')
    await expect(
      unlockLightOwnerKey({ ...backup, purpose: 'recovery-secret' }, material, 'recovery-secret', descriptor),
    ).rejects.toThrow('Unable to unlock')
  })

  it('rejects another vault, policy, network or malformed envelope', async () => {
    const backup = await wrapLightOwnerKey(owner, material, 'passkey-prf', descriptor)
    const different = buildLightDescriptor({ ...descriptor, vaultId: 'bb'.repeat(32) })
    expect(() => validateLightKeyBackup(backup, different)).toThrow()
    const changedPolicy = buildLightDescriptor({
      ...descriptor,
      spendingPolicy: { ...descriptor.spendingPolicy, txRecipientCapSats: 25000 },
    })
    expect(() => validateLightKeyBackup(backup, changedPolicy)).toThrow()
    await expect(
      unlockLightOwnerKey(
        { ...backup, descriptorDigest: lightDescriptorDigest(changedPolicy) },
        material,
        'passkey-prf',
        changedPolicy,
      ),
    ).rejects.toThrow('Unable to unlock')
    expect(() => validateLightKeyBackup(backup, vectors[1].descriptor as LightDescriptor)).toThrow()
    for (const patch of [
      { nonce: '00' },
      { ciphertext: backup.ciphertext.slice(2) },
      { salt: '' },
      { version: 3 },
      { name: 'arkade-recovery-kit' },
      { extra: true },
    ]) {
      expect(() => validateLightKeyBackup({ ...backup, ...patch }, descriptor)).toThrow()
    }
  })

  it('rejects wrong owner keys and arbitrary length key material', async () => {
    await expect(wrapLightOwnerKey(new Uint8Array(32).fill(2), material, 'passkey-prf', descriptor)).rejects.toThrow(
      'owner key',
    )
    await expect(wrapLightOwnerKey(owner, new Uint8Array(16), 'passkey-prf', descriptor)).rejects.toThrow('32 bytes')
    await expect(wrapLightOwnerKey(new Uint8Array(31), material, 'passkey-prf', descriptor)).rejects.toThrow('32 bytes')
  })
})
