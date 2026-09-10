import { requireSavingsRecoveryKit, parseRecoveryKit, inspectRecoveryKit } from '../program/kit'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerRecoveryFixture, ledgerFixturePRF, ledgerFixtureSeed } from './testdata/ledger'
import { buildRecoveryHeader, decryptRecoveryBackup, recoveryBackupKey, validateRecoveryHeader } from './backupCodec'
import { createPortableRecoveryPackage, parsePortableRecoveryPackage, portableRecoverySource } from './portable'
import { restoreVaultRecoveryFile } from './restore'
import { validateLedgerSavingsEnrollmentDescriptor } from '../program/ledgerRecoveryDescriptor'
import { loadEnrollment } from '../enrollmentStore'
import { loadLocalKit } from '../program/kitStore'
import { unlockLedgerPhoneSeed } from '../ledgerPhoneBackup'
import { unwrapPhoneSecret } from '../prfEnvelope'
import { scalarSecret } from '../program/fixtures'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (...args: unknown[]) =>
        (args.at(-1) as (lock: object) => Promise<unknown>)({ name: args[0], mode: 'exclusive' }),
    },
  })
})

describe('Ledger Savings complete recovery package', () => {
  for (const network of ['mainnet', 'mutinynet'] as const)
    for (const advanced of [false, true]) {
      it(`exports and restores distinct keys and complete paths ${network}/${advanced}`, async () => {
        const { file, kit } = await ledgerRecoveryFixture(advanced, network)
        expect(kit.version).toBe(4)
        expect(file.header.version).toBe(2)
        expect(inspectRecoveryKit(kit).trees).toHaveLength(advanced ? 8 : 6)
        const key = await recoveryBackupKey(scalarSecret(3), file.header)
        const portable = parsePortableRecoveryPackage(
          JSON.parse(JSON.stringify(await createPortableRecoveryPackage(file, key))),
        )
        expect(portableRecoverySource(portable).archive.spending.transactions).toEqual(
          file.archive.spending.transactions,
        )
        expect(portable.archive.onchain).toHaveLength(advanced ? 8 : 6)
        const opened = await decryptRecoveryBackup(portable.backup, key)
        const envelope = opened.header.enrollment
        const phone = await unwrapPhoneSecret(ledgerFixturePRF, envelope.nonce, envelope.ciphertext)
        const savings = await unlockLedgerPhoneSeed(
          envelope.ledgerSavings!.phoneSeedBackup,
          ledgerFixturePRF,
          'passkey-prf',
          envelope.ledgerSavings!.contract.context,
        )
        expect(phone).toEqual(scalarSecret(3))
        expect(savings).toEqual(ledgerFixtureSeed)
        expect(phone).not.toEqual(savings)
        const offline = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('services unavailable'))
        try {
          await restoreVaultRecoveryFile(opened, phone, savings)
          expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toEqual(envelope)
          expect(loadLocalKit(file.header.binding.vaultId)).toEqual(kit)
          await restoreVaultRecoveryFile(opened, phone, savings)
          expect(offline).not.toHaveBeenCalled()
        } finally {
          phone.fill(0)
          savings.fill(0)
          offline.mockRestore()
        }
      }, 90000)
    }

  it('rejects changed origins, policy, registration, seed binding and Spending authorities before restore writes', async () => {
    const { file, composite } = await ledgerRecoveryFixture()
    const mutations = [
      (f: typeof file) => {
        f.header.enrollment.ledgerSavings!.contract.context.hardware.fingerprint = '00000000'
      },
      (f: typeof file) => {
        f.header.enrollment.ledgerSavings!.contract.spendingPolicy.absoluteFeeCapSats++
      },
      (f: typeof file) => {
        f.header.enrollment.ledgerSavings!.registration.walletId = '00'.repeat(32)
      },
      (f: typeof file) => {
        f.header.enrollment.ledgerSavings!.registration.changeAddress = requireSavingsRecoveryKit(
          file.header.kit,
        ).descriptor.savings.address
      },
      (f: typeof file) => {
        f.header.enrollment.ledgerSavings!.phoneSeedBackup.contextDigest = '00'.repeat(32)
      },
      (f: typeof file) => {
        f.header.enrollment.phoneBip340Pub = '02' + '11'.repeat(32)
      },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(file)
      mutate(changed)
      expect(() => validateRecoveryHeader(changed.header)).toThrow()
    }
    expect(() => validateLedgerSavingsEnrollmentDescriptor({ ...composite, unexpected: 1 })).toThrow()
    expect(() => parseRecoveryKit({ ...file.header.kit, version: 3 })).toThrow()
    const missing = structuredClone(file.header.enrollment)
    delete missing.ledgerSavings
    expect(() => buildRecoveryHeader(file.header.kit, file.header.status, missing)).toThrow()
    await expect(restoreVaultRecoveryFile(file, scalarSecret(3))).rejects.toThrow('Savings HD seed')
    await expect(restoreVaultRecoveryFile(file, scalarSecret(3), scalarSecret(3))).rejects.toThrow('Savings HD seed')
    expect(loadEnrollment(localStorage, file.header.binding.vaultId)).toBeNull()
  }, 90000)
})
