import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ledgerRecoveryFixture } from './testdata/ledger'
import { recoveryFileStore } from './fileStore'
import { readCommittedRecoveryCoverage } from './committedCoverage'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('only returns evidence for a committed, validated file belonging to the complete account identity', async () => {
  const f = await ledgerRecoveryFixture()
  const key = f.file.header.binding.descriptorHash
  expect(await readCommittedRecoveryCoverage(f.status)).toBeNull()
  await recoveryFileStore(key, f.file)
  const evidence = await readCommittedRecoveryCoverage(f.status)
  expect(evidence).toMatchObject({ vaultId: f.status.vaultId, network: f.status.network, descriptorHash: key })
  expect(evidence?.fileDigest).toMatch(/^[0-9a-f]{64}$/)
  const other = await ledgerRecoveryFixture(true)
  await recoveryFileStore(key, other.file)
  await expect(readCommittedRecoveryCoverage(f.status)).rejects.toThrow('another account')
})

it('rejects missing ancestors and preserves committed evidence when a replacement transaction aborts', async () => {
  const f = await ledgerRecoveryFixture()
  const key = f.file.header.binding.descriptorHash
  await recoveryFileStore(key, f.file)
  const evidence = await readCommittedRecoveryCoverage(f.status)
  const next = structuredClone(f.file)
  next.archive.spending.transactions = {}
  const put = IDBObjectStore.prototype.put
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    nextKey,
  ) {
    if (nextKey === key) throw new DOMException('Full', 'QuotaExceededError')
    return put.call(this, value, nextKey)
  })
  await expect(recoveryFileStore(key, next)).rejects.toThrow('Full')
  expect(await readCommittedRecoveryCoverage(f.status)).toEqual(evidence)
  failure.mockRestore()
  await recoveryFileStore(key, next)
  await expect(readCommittedRecoveryCoverage(f.status)).rejects.toThrow()
})
