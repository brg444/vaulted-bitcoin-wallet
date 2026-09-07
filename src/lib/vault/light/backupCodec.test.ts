import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction, ChainTxType } from '@arkade-os/sdk'
import { lightTestEnrollment, testOwner, testDescriptor } from './testdata/helpers'
import { lightDescriptorDigest } from './contract'
import { networkPins } from '../networkPins'
import { encryptLightBackup, decryptLightBackup, lightBackupKey, openLocalLightBackup } from './backupCodec'
import { unlockLightWithPasskey } from './passkey'

vi.mock('./passkey', () => ({ unlockLightWithPasskey: vi.fn() }))
import { lightArchiveProviders, assertLightArchiveMatchesVtxos } from './recoveryArchive'
import type { LightRecoveryFile } from './recovery'

async function fixture(): Promise<LightRecoveryFile> {
  const record = await lightTestEnrollment()
  delete record.recoveryBackup
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: '01'.repeat(32), index: 0 })
  tx.addOutput({ amount: 40000n, script: hex.decode(testDescriptor.scriptPubKey) })
  const coin = {
    txid: tx.id,
    vout: 0,
    value: 40000,
    script: testDescriptor.scriptPubKey,
    isSpent: false,
    createdAt: new Date(),
  }
  const pins = networkPins(testDescriptor.network)
  return {
    ...record,
    name: 'vaulted-light-recovery',
    version: 1,
    createdAt: new Date().toISOString(),
    archive: {
      version: 1,
      descriptorHash: lightDescriptorDigest(testDescriptor),
      capturedAt: new Date().toISOString(),
      info: JSON.stringify({
        network: pins.operatorGetInfoNetwork,
        signerPubkey: pins.operatorSignerPub,
        checkpointTapscript: pins.checkpointTapscript,
        forfeitPubkey: pins.checkpointForfeitPub,
      }),
      coins: JSON.stringify([coin]),
      branches: {
        [`${tx.id}:0`]: [
          { txid: '01'.repeat(32), type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
          { txid: tx.id, type: ChainTxType.TREE, spends: ['01'.repeat(32)], expiresAt: '1789000000' },
        ],
      },
      transactions: { [tx.id]: base64.encode(tx.toPSBT()) },
    },
  }
}
describe('automatic Light backup and unilateral exit data', () => {
  it('round trips the complete VTXO paths without a manual recovery secret', async () => {
    const file = await fixture()
    const key = await lightBackupKey(testOwner, file)
    expect(key.extractable).toBe(false)
    const encrypted = await encryptLightBackup(file, key)
    const serialized = JSON.stringify(encrypted)
    expect(serialized).not.toContain('recovery-secret')
    expect(serialized).not.toContain(hex.encode(testOwner))
    expect(serialized).not.toContain(Object.keys(file.archive!.transactions)[0])
    const restored = await decryptLightBackup(JSON.parse(serialized), key)
    expect(restored.archive).toEqual(file.archive)
    const providers = lightArchiveProviders(restored.archive!, restored.descriptor)
    const ids = Object.keys(file.archive!.transactions)
    expect(await providers.source.getVirtualTxs(ids)).toEqual(new Map(Object.entries(file.archive!.transactions)))
    expect(
      (await providers.indexerProvider.getVtxos({ scripts: [restored.descriptor.scriptPubKey] })).vtxos,
    ).toHaveLength(1)
  })
  it('rejects ciphertext, descriptor and origin substitution before trusting any exit data', async () => {
    const file = await fixture()
    const key = await lightBackupKey(testOwner, file)
    const encrypted = await encryptLightBackup(file, key)
    for (const mutate of [
      (v: typeof encrypted) => {
        v.ciphertext = (v.ciphertext[0] === 'A' ? 'B' : 'A') + v.ciphertext.slice(1)
      },
      (v: typeof encrypted) => {
        v.header.descriptor.vaultId = '22'.repeat(32)
      },
      (v: typeof encrypted) => {
        v.header.origin = 'https://example.com'
        v.header.rpId = 'example.com'
      },
    ]) {
      const changed = structuredClone(encrypted)
      mutate(changed)
      await expect(decryptLightBackup(changed, key)).rejects.toThrow()
    }
  })
  it('refuses key-only and incomplete-path snapshots instead of claiming they are backed up', async () => {
    const file = await fixture()
    const key = await lightBackupKey(testOwner, file)
    await expect(encryptLightBackup({ ...file, archive: undefined }, key)).rejects.toThrow('transaction')
    file.archive!.transactions = {}
    await expect(encryptLightBackup(file, key)).rejects.toThrow('incomplete')
  })
  it('rejects an omitted ancestor and an equal-value replacement with a different outpoint', async () => {
    const file = await fixture()
    const archive = file.archive!
    const coin = JSON.parse(archive.coins)[0]
    expect(() =>
      assertLightArchiveMatchesVtxos(archive, file.descriptor, [{ ...coin, txid: '22'.repeat(32) }]),
    ).toThrow('catching up')
    const branch = Object.keys(archive.branches)[0]
    archive.branches[branch] = archive.branches[branch].filter((node) => node.type !== ChainTxType.COMMITMENT)
    const key = await lightBackupKey(testOwner, file)
    await expect(encryptLightBackup(file, key)).rejects.toThrow('commitment')
  })
})

describe('local restore owner ceremony', () => {
  it('authorizes only after authenticated decryption and wipes the same owner key', async () => {
    const file = await fixture()
    const encrypted = await encryptLightBackup(file, await lightBackupKey(testOwner, file))
    const owner = Uint8Array.from(testOwner)
    vi.mocked(unlockLightWithPasskey).mockResolvedValueOnce(owner)
    const authorize = vi.fn(async (key, record) => {
      expect(key).toBe(owner)
      expect(key).toEqual(testOwner)
      expect(record.descriptor).toEqual(file.descriptor)
    })
    const restored = await openLocalLightBackup(encrypted, authorize)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(restored.file.archive).toEqual(file.archive)
    expect(restored.key.extractable).toBe(false)
    expect(owner.every((byte) => byte === 0)).toBe(true)
  })

  it('wipes the owner after a failed authorization callback', async () => {
    const file = await fixture()
    const encrypted = await encryptLightBackup(file, await lightBackupKey(testOwner, file))
    const owner = Uint8Array.from(testOwner)
    vi.mocked(unlockLightWithPasskey).mockResolvedValueOnce(owner)
    await expect(
      openLocalLightBackup(encrypted, async () => {
        throw new Error('authorization unavailable')
      }),
    ).rejects.toThrow('authorization unavailable')
    expect(owner.every((byte) => byte === 0)).toBe(true)
  })

  it('never authorizes a tampered backup and still wipes the owner', async () => {
    const file = await fixture()
    const encrypted = await encryptLightBackup(file, await lightBackupKey(testOwner, file))
    encrypted.ciphertext = (encrypted.ciphertext[0] === 'A' ? 'B' : 'A') + encrypted.ciphertext.slice(1)
    const owner = Uint8Array.from(testOwner)
    vi.mocked(unlockLightWithPasskey).mockResolvedValueOnce(owner)
    const authorize = vi.fn()
    await expect(openLocalLightBackup(encrypted, authorize)).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
    expect(owner.every((byte) => byte === 0)).toBe(true)
  })
})
