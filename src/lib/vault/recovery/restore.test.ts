import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { recoveryFixture } from './testdata/helpers'
import { deriveBoardingKey, loadActiveBoardingKey } from '../vtxo/board'
import { scalarSecret, PROGRAM_FIXTURE } from '../program/fixtures'
import { wrapPhoneSecret } from '../prfEnvelope'
import { buildRecoveryHeader, type VaultRecoveryFile } from './backupCodec'
import { recoveryLightningBinding } from './journals'
import { restoreVaultRecoveryFile } from './restore'
import { loadVaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { recoveryFileStore } from './fileStore'
import { loadEnrollment } from '../enrollmentStore'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, options: unknown, callback?: (lock: unknown) => unknown) =>
        typeof options === 'function' ? options({}) : callback!({}),
    },
  })
})
async function fixture(advanced: boolean) {
  const derived = await deriveBoardingKey(scalarSecret(3), PROGRAM_FIXTURE.vaultId, 'mutinynet')
  const { kit, status, archive } = recoveryFixture(advanced, 'mutinynet', undefined, derived.boardingPub)
  derived.secret.fill(0)
  const enrollment = {
    vaultId: status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: PROGRAM_FIXTURE.phoneDirectP256,
    phoneDirectP256: PROGRAM_FIXTURE.phoneDirectP256,
    phoneBip340Pub: status.phoneBip340Pub!,
    ...(await wrapPhoneSecret(scalarSecret(9), scalarSecret(3))),
  }
  const file: VaultRecoveryFile = {
    name: 'vaulted-recovery',
    version: 1,
    header: buildRecoveryHeader(kit, status, enrollment),
    archive,
    spendingJournal: { version: 1, vaultId: status.vaultId, operations: [] },
    lightningJournal: {
      name: 'vaulted-lightning-recovery',
      version: 1,
      binding: recoveryLightningBinding(status),
      entries: [],
    },
  }
  return file
}
describe('fresh-device program archive restore', () => {
  it.each([false, true])(
    'restores independently verified parent evidence and derives the enrolled boarding key, advanced=%s',
    async (advanced) => {
      const file = await fixture(advanced)
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('All services unavailable'))
      try {
        await restoreVaultRecoveryFile(file, scalarSecret(3))
        expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toEqual(file.header.enrollment)
        const key = await loadActiveBoardingKey(file.header.binding.vaultId)
        expect(key.boardingPub).toBe(file.header.status.vtxoBoardingDescriptor!.boardingPub)
        key.secret.fill(0)
        expect((await loadVaultRecoveryArchive(file.header.kit, file.header.status))?.spending.transactions).toEqual(
          file.archive.spending.transactions,
        )
        await restoreVaultRecoveryFile(file, scalarSecret(3))
        expect(network).not.toHaveBeenCalled()
      } finally {
        network.mockRestore()
      }
    },
  )
  it('keeps a newer complete snapshot when restoring an older file', async () => {
    const old = await fixture(false)
    const newer = structuredClone(old)
    newer.archive.spending.capturedAt = '2026-09-07T00:00:00Z'
    const key = newer.header.binding.descriptorHash
    await recoveryFileStore(key, newer)
    await restoreVaultRecoveryFile(old, scalarSecret(3))
    expect(await recoveryFileStore(key)).toEqual(newer)
  })
  it('refuses foreign keys or a missing journal without replacing enrollment', async () => {
    const file = await fixture(false)
    await expect(restoreVaultRecoveryFile(file, scalarSecret(4))).rejects.toThrow('phone key')
    await expect(restoreVaultRecoveryFile({ ...file, lightningJournal: undefined }, scalarSecret(3))).rejects.toThrow()
    expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toBeNull()
  })
})
