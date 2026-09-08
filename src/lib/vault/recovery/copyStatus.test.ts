import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { recoveryFixture } from './testdata/helpers'
import { publicExitArchive } from './portable'
import { readRecoveryCopies, recordRecoveryCopy, recoveryCopyDescription, recoveryPathDigest } from './copyStatus'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => vi.unstubAllGlobals())
it('compares the readable export with local paths independently of capture time', () => {
  const archive = recoveryFixture().archive.spending
  expect(recoveryPathDigest(archive)).toBe(
    recoveryPathDigest({ ...publicExitArchive(archive), capturedAt: new Date(0).toISOString() }),
  )
})
it('keeps concurrent copy records across reload and identifies an older file without rolling back local status', async () => {
  const archive = recoveryFixture().archive.spending
  await Promise.all(
    ['local', 'downloaded', 'service'].map((kind) =>
      recordRecoveryCopy('wallet', 'mutinynet', kind as 'local' | 'downloaded' | 'service', archive),
    ),
  )
  const first = await readRecoveryCopies('wallet', 'mutinynet')
  expect(Object.keys(first)).toHaveLength(3)
  const newer = { ...archive, transactions: { ...archive.transactions, ['aa'.repeat(32)]: 'new path' } }
  await recordRecoveryCopy('wallet', 'mutinynet', 'local', newer)
  await recordRecoveryCopy('wallet', 'mutinynet', 'checked', archive)
  const copies = await readRecoveryCopies('wallet', 'mutinynet')
  expect(copies.local?.digest).toBe(recoveryPathDigest(newer))
  expect(recoveryCopyDescription(copies, 'checked')).toContain('Differs')
  expect(recoveryCopyDescription(copies, 'downloaded')).toContain('Differs')
  expect(await readRecoveryCopies('other', 'mutinynet')).toEqual({})
})
