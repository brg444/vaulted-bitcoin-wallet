import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { sharedSpendingRecoveryFixture } from './testdata/helpers'
import { ledgerFixtureSeed, ledgerRecoveryFixture } from './testdata/ledger'
import { sharedSpendingEnrollment } from '../vtxo/testdata/sharedSpending'
import { deriveBoardingKey, loadActiveBoardingKey } from '../vtxo/board'
import { scalarSecret } from '../program/fixtures'
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
      request: vi.fn(async (_name: string, options: unknown, callback?: (lock: unknown) => unknown) =>
        typeof options === 'function' ? options({}) : callback!({}),
      ),
    },
  })
})
async function fixture(advanced: boolean) {
  return (await ledgerRecoveryFixture(advanced)).file
}
describe('fresh-device program archive restore', () => {
  it('restores shared Spending with its device key and no Savings seed', async () => {
    const phone = new Uint8Array(32).fill(7)
    const initial = sharedSpendingRecoveryFixture().status
    const derived = await deriveBoardingKey(phone, initial.vaultId, initial.network)
    const { status, kit, archive } = sharedSpendingRecoveryFixture(derived.boardingPub)
    derived.secret.fill(0)
    const enrollment = { ...sharedSpendingEnrollment(), ...(await wrapPhoneSecret(scalarSecret(9), phone)) }
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
    await restoreVaultRecoveryFile(file, phone)
    expect(loadEnrollment(localStorage, status.vaultId)).toEqual(enrollment)
    const key = await loadActiveBoardingKey(status.vaultId)
    expect(key.boardingPub).toBe(status.vtxoBoardingDescriptor!.boardingPub)
    key.secret.fill(0)
    await expect(restoreVaultRecoveryFile(file, phone, ledgerFixtureSeed)).rejects.toThrow('Spending-only')
    expect(phone).toEqual(new Uint8Array(32).fill(7))
    phone.fill(0)
  })

  it.each([
    'vaulted-light-v1',
    'phone-hww-recovery-savings-v1',
    'phone-connector-recovery-savings-v1',
    'phone-connector-recovery-savings-v2',
  ])('rejects %s before opening storage or activating keys', async (templateVersion) => {
    const file = await fixture(false)
    file.archive.status.templateVersion = templateVersion
    await expect(restoreVaultRecoveryFile(file, scalarSecret(3), ledgerFixtureSeed)).rejects.toThrow('template version')
    expect(navigator.locks.request).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it.each([false, true])(
    'restores independently verified parent evidence and derives the enrolled boarding key, advanced=%s',
    async (advanced) => {
      const file = await fixture(advanced)
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('All services unavailable'))
      try {
        await restoreVaultRecoveryFile(file, scalarSecret(3), ledgerFixtureSeed)
        expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toEqual(file.header.enrollment)
        const key = await loadActiveBoardingKey(file.header.binding.vaultId)
        expect(key.boardingPub).toBe(file.header.status.vtxoBoardingDescriptor!.boardingPub)
        key.secret.fill(0)
        expect((await loadVaultRecoveryArchive(file.header.kit, file.header.status))?.spending.transactions).toEqual(
          file.archive.spending.transactions,
        )
        await restoreVaultRecoveryFile(file, scalarSecret(3), ledgerFixtureSeed)
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
    await restoreVaultRecoveryFile(old, scalarSecret(3), ledgerFixtureSeed)
    expect(await recoveryFileStore(key)).toEqual(newer)
  })
  it('refuses foreign keys or a missing journal without replacing enrollment', async () => {
    const file = await fixture(false)
    await expect(restoreVaultRecoveryFile(file, scalarSecret(4), ledgerFixtureSeed)).rejects.toThrow('phone key')
    await expect(
      restoreVaultRecoveryFile({ ...file, lightningJournal: undefined }, scalarSecret(3), ledgerFixtureSeed),
    ).rejects.toThrow()
    expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toBeNull()
  })
})
