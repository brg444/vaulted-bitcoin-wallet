import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { scalarSecret, FIXTURE_PHONE_DIRECT_P256 } from '../program/fixtures'
import { wrapPhoneSecret } from '../prfEnvelope'
import { deriveDirectP256 } from '../ceremony/directauth'
import { recoveryFixture } from './testdata/helpers'
import { buildRecoveryHeader, recoveryBackupKey, encryptRecoveryBackup, type VaultRecoveryFile } from './backupCodec'
import { openRecoveryCloudBackup, syncRecoveryCloudBackup, type RecoveryBackupSession } from './cloudBackup'

async function fixture() {
  const prf = scalarSecret(9)
  const direct = await deriveDirectP256(prf)
  const { archive, status, kit } = recoveryFixture(false, 'mutinynet', hex.encode(direct.pub))
  direct.scalar.fill(0)
  status.clientOrigin = location.origin
  status.rpId = location.hostname
  const enrollment = {
    vaultId: status.vaultId,
    credId: 'ab'.repeat(32),
    webauthnP256: FIXTURE_PHONE_DIRECT_P256,
    phoneBip340Pub: kit.descriptor.keys.phoneBip340,
    phoneDirectP256: kit.descriptor.keys.phoneDirectP256,
    ...(await wrapPhoneSecret(prf, scalarSecret(3))),
  }
  const header = buildRecoveryHeader(kit, status, enrollment)
  const file: VaultRecoveryFile = { name: 'vaulted-recovery', version: 1, header, archive }
  const session: RecoveryBackupSession = {
    token: 'aa'.repeat(32),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    header,
    key: await recoveryBackupKey(scalarSecret(3), header),
    revision: 0,
    fingerprint: '',
  }
  return { file, session, prf }
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('authenticated program archive transport', () => {
  it('reads back and decrypts before acknowledging and retries the exact ciphertext after a lost response', async () => {
    const { file, session } = await fixture()
    let stored: { revision: number; payload: string } | undefined
    let lost = true
    const writes: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain('/v1/recovery-archive/')
        const body = JSON.parse(String(init.body))
        if (url.endsWith('/write')) {
          writes.push(body.payload)
          stored = { revision: 1, payload: body.payload }
          if (lost) {
            lost = false
            throw new Error('lost response')
          }
        }
        return Response.json(stored)
      }),
    )
    await expect(syncRecoveryCloudBackup(session, file)).rejects.toThrow('lost response')
    expect(session.revision).toBe(0)
    expect(session.pending).toBeDefined()
    expect(await syncRecoveryCloudBackup(session, file)).toEqual(file)
    expect(writes[0]).toBe(writes[1])
    expect(session.revision).toBe(1)
    expect(session.pending).toBeUndefined()
  })
  it('restores a discoverable 32-character Savings vault with the existing header and original PRF', async () => {
    const { file, session, prf } = await fixture()
    const encrypted = await encryptRecoveryBackup(file, session.key)
    const credential = {
      rawId: hex.decode(file.header.enrollment.credId).buffer,
      response: {
        userHandle: new TextEncoder().encode(file.header.binding.vaultId).buffer,
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
      },
      getClientExtensionResults: () => ({ prf: { results: { first: Uint8Array.from(prf).buffer } } }),
    }
    vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => credential) } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/challenge'))
          return Response.json({ challengeId: '12'.repeat(16), challenge: 'cd'.repeat(32) })
        expect(JSON.parse(String(init.body)).vaultId).toBe(file.header.binding.vaultId)
        return Response.json({
          token: session.token,
          expiresAt: session.expiresAt,
          vaultId: file.header.binding.vaultId,
          binding: file.header.binding,
          backup: { revision: 3, payload: JSON.stringify(encrypted) },
        })
      }),
    )
    const restored = await openRecoveryCloudBackup()
    expect(restored.file).toEqual(file)
    expect(restored.header).toEqual(file.header)
    expect(restored.key.extractable).toBe(false)
    expect(restored.revision).toBe(3)
  })
  it('retains the acknowledged revision when readback is inconsistent or the session has expired', async () => {
    const { file, session } = await fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) =>
        Response.json({
          revision: url.endsWith('/write') ? 1 : 2,
          payload: JSON.parse(String(init.body)).payload ?? '{}',
        }),
      ),
    )
    await expect(syncRecoveryCloudBackup(session, file)).rejects.toThrow('read could not be verified')
    expect(session.revision).toBe(0)
    session.expiresAt = new Date(Date.now() - 1).toISOString()
    await expect(syncRecoveryCloudBackup(session, file)).rejects.toThrow('original passkey')
    expect(session.pending).toBeDefined()
  })
})
