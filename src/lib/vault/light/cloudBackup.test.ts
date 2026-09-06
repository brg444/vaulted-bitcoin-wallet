import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncLightCloudBackup, type LightBackupSession } from './cloudBackup'
import { lightBackupKey } from './backupCodec'
import { lightTestEnrollment, testOwner, testDescriptor } from './testdata/helpers'
import { lightDescriptorDigest } from './contract'
import { networkPins } from '../networkPins'
import type { LightRecoveryArchive } from './recoveryArchive'

async function fixture() {
  const record = await lightTestEnrollment()
  delete record.recoveryBackup
  const session: LightBackupSession = {
    token: 'aa'.repeat(32),
    record,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    key: await lightBackupKey(testOwner, record),
    revision: 0,
    fingerprint: '',
  }
  const pins = networkPins(testDescriptor.network)
  const archive: LightRecoveryArchive = {
    version: 1,
    descriptorHash: lightDescriptorDigest(testDescriptor),
    capturedAt: new Date().toISOString(),
    info: JSON.stringify({
      network: pins.operatorGetInfoNetwork,
      signerPubkey: pins.operatorSignerPub,
      checkpointTapscript: pins.checkpointTapscript,
      forfeitPubkey: pins.checkpointForfeitPub,
    }),
    coins: '[]',
    branches: {},
    transactions: {},
  }
  return { session, archive }
}
afterEach(() => vi.unstubAllGlobals())
describe('cloud recovery acknowledgments', () => {
  it('reads back and decrypts the saved snapshot before acknowledging backup', async () => {
    const { session, archive } = await fixture()
    let stored: unknown
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/write')) {
        const body = JSON.parse(String(init.body))
        expect(body.revision).toBe(0)
        stored = { revision: 1, payload: body.payload }
        return Response.json(stored)
      }
      return Response.json(stored)
    })
    vi.stubGlobal('fetch', fetch)
    expect((await syncLightCloudBackup(session, archive)).archive).toEqual(archive)
    expect(session.revision).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await syncLightCloudBackup(session, { ...archive, capturedAt: new Date(Date.now() + 1).toISOString() })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('retains the last acknowledged revision when a write or readback fails', async () => {
    for (const failReadback of [false, true]) {
      const { session, archive } = await fixture()
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          if (failReadback && url.endsWith('/write'))
            return Response.json({ revision: 1, payload: JSON.parse(String(init.body)).payload })
          return new Response('unavailable', { status: 503 })
        }),
      )
      await expect(syncLightCloudBackup(session, archive)).rejects.toThrow()
      expect(session.revision).toBe(0)
      expect(session.file).toBeUndefined()
    }
  })
  it('does not publish anything after the backup-only session expires', async () => {
    const { session, archive } = await fixture()
    session.expiresAt = '2000-01-01T00:00:00Z'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(syncLightCloudBackup(session, archive)).rejects.toThrow('Unlock')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('cloud backup retry and concurrency', () => {
  for (const lostPhase of ['write', 'read']) {
    it(`reuses the saved ciphertext after a lost ${lostPhase} response, then saves newer paths`, async () => {
      const { session, archive } = await fixture()
      let stored: { revision: number; payload: string } | undefined
      let loseResponse = true
      const writes: { revision: number; payload: string }[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith('/write')) {
            const body = JSON.parse(String(init.body))
            writes.push(body)
            if (stored && body.revision !== stored.revision) {
              if (body.revision + 1 !== stored.revision || body.payload !== stored.payload)
                return new Response('conflict', { status: 409 })
            } else stored = { revision: body.revision + 1, payload: body.payload }
          }
          if (loseResponse && url.endsWith('/' + lostPhase)) {
            loseResponse = false
            throw new TypeError('connection lost after commit')
          }
          return Response.json(stored)
        }),
      )
      await expect(syncLightCloudBackup(session, archive)).rejects.toThrow()
      expect(session.revision).toBe(0)
      expect(session.file).toBeUndefined()
      const newer = { ...archive, info: JSON.stringify({ ...JSON.parse(archive.info), dust: 500n.toString() }) }
      const result = await syncLightCloudBackup(session, newer)
      expect(writes).toHaveLength(3)
      expect(writes[1]).toEqual(writes[0])
      expect(writes[2].revision).toBe(1)
      expect(writes[2].payload).not.toBe(writes[0].payload)
      expect(result.archive).toEqual(newer)
      expect(session.revision).toBe(2)
      expect(session.pending).toBeUndefined()
    })
  }
  it('serializes simultaneous calls and uploads one snapshot for an unchanged archive', async () => {
    const { session, archive } = await fixture()
    let stored: unknown
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/write')) stored = { revision: 1, payload: JSON.parse(String(init.body)).payload }
      return Response.json(stored)
    })
    vi.stubGlobal('fetch', fetch)
    const [first, second] = await Promise.all([
      syncLightCloudBackup(session, archive),
      syncLightCloudBackup(session, archive),
    ])
    expect(first).toEqual(second)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(session.revision).toBe(1)
  })
})
