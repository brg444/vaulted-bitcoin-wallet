import { describe, expect, it, vi } from 'vitest'
import { scalarSecret, FIXTURE_PHONE_DIRECT_P256 } from '../program/fixtures'
import { wrapPhoneSecret } from '../prfEnvelope'
import { recoveryFixture } from './testdata/helpers'
import {
  buildRecoveryHeader,
  encryptRecoveryBackup,
  decryptRecoveryBackup,
  recoveryBackupKey,
  openLocalRecoveryBackup,
  type VaultRecoveryFile,
} from './backupCodec'

async function fixture(advanced = true) {
  const { archive, status, kit } = recoveryFixture(advanced)
  const enrollment = {
    vaultId: status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: FIXTURE_PHONE_DIRECT_P256,
    phoneBip340Pub: kit.descriptor.keys.phoneBip340,
    phoneDirectP256: kit.descriptor.keys.phoneDirectP256,
    ...(await wrapPhoneSecret(scalarSecret(9), scalarSecret(3))),
  }
  const header = buildRecoveryHeader(kit, status, enrollment)
  const file: VaultRecoveryFile = { name: 'vaulted-recovery', version: 1, header, archive }
  return { file, key: await recoveryBackupKey(scalarSecret(3), header) }
}

describe('program recovery encrypted archives', () => {
  it.each([false, true])(
    'round trips complete transaction data without retaining a signing key (advanced=%s)',
    async (advanced) => {
      const { file, key } = await fixture(advanced)
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('services unavailable'))
      try {
        expect(key.extractable).toBe(false)
        expect(key.usages).toEqual(['encrypt', 'decrypt'])
        const encrypted = await encryptRecoveryBackup(file, key)
        expect(await decryptRecoveryBackup(JSON.parse(JSON.stringify(encrypted)), key)).toEqual(file)
        expect(network).not.toHaveBeenCalled()
      } finally {
        network.mockRestore()
      }
    },
  )
  it('keeps the header stable across balance updates, binds the passkey envelope and refuses a foreign key', async () => {
    const { file, key } = await fixture()
    const changed = { ...file.archive.status, periodSpent: 9999, periodRemaining: 1 }
    expect(buildRecoveryHeader(file.header.kit, changed, file.header.enrollment)).toEqual(file.header)
    await expect(recoveryBackupKey(scalarSecret(4), file.header)).rejects.toThrow('does not belong')
    const encrypted = await encryptRecoveryBackup(file, key)
    encrypted.header = { ...encrypted.header, enrollment: { ...encrypted.header.enrollment, nonce: 'cc'.repeat(12) } }
    await expect(decryptRecoveryBackup(encrypted, key)).rejects.toThrow()
  })
  it('requires the original passkey origin before prompting and rejects incomplete transaction evidence', async () => {
    const { file, key } = await fixture()
    const encrypted = await encryptRecoveryBackup(file, key)
    await expect(openLocalRecoveryBackup(encrypted)).rejects.toThrow('original passkey')
    const changed = structuredClone(file)
    changed.archive.spending.transactions = {}
    await expect(encryptRecoveryBackup(changed, key)).rejects.toThrow('incomplete')
  })
})
