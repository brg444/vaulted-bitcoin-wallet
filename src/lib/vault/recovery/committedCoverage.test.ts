import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ledgerRecoveryFixture } from './testdata/ledger'
import { recoveryFileStore } from './fileStore'
import { readCommittedRecoveryCoverage, readCommittedRecoveryEvidence } from './committedCoverage'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { lightningRecoveryFixture } from './testdata/lightningFixtures'
import { lightningExitBinding } from './lightningArchive'
import { validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'

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
  const snapshot = await readCommittedRecoveryEvidence(f.status)
  expect(snapshot?.coverage).toEqual(evidence)
  expect(snapshot?.matureBoardingJournal).toBeNull()
  expect(snapshot?.lightningJournal).toEqual(f.file.lightningJournal)
  const other = await ledgerRecoveryFixture(true)
  await recoveryFileStore(key, other.file)
  await expect(readCommittedRecoveryCoverage(f.status)).rejects.toThrow('another account')
})

async function fundedLightningFile(network: 'mainnet' | 'mutinynet') {
  const f = await ledgerRecoveryFixture(false, network)
  const lightning = lightningRecoveryFixture({ network })
  const journal = f.file.lightningJournal!
  const entry = structuredClone(lightning.entry)
  entry.exit.descriptorHash = lightningExitBinding(entry, journal.binding).descriptorHash
  journal.entries = [entry]
  validateVaultRecoveryFile(f.file)
  return f
}

const fileDigest = (file: VaultRecoveryFile) => hex.encode(sha256(new TextEncoder().encode(JSON.stringify(file))))

it.each(['mainnet', 'mutinynet'] as const)(
  'keeps Lightning evidence and its digest on one committed generation during replacement (%s)',
  async (network) => {
    const f = await fundedLightningFile(network)
    const key = f.file.header.binding.descriptorHash
    await recoveryFileStore(key, f.file)
    const next = structuredClone(f.file)
    next.lightningJournal!.entries[0].record.state = 'needs_counterparty'
    next.lightningJournal!.entries[0].record.updatedAt++
    validateVaultRecoveryFile(next)
    const get = IDBObjectStore.prototype.get
    let replacement: Promise<unknown> | undefined
    let reads = 0
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, requestedKey) {
      const request = get.call(this, requestedKey)
      if (this.name === 'files' && this.transaction.mode === 'readonly' && requestedKey === key) {
        reads++
        if (reads === 1) request.addEventListener('success', () => (replacement = recoveryFileStore(key, next)))
      }
      return request
    })

    const snapshot = await readCommittedRecoveryEvidence(f.status)
    expect(replacement).toBeDefined()
    await replacement
    expect(reads).toBe(1)
    expect(snapshot?.lightningJournal).toEqual(f.file.lightningJournal)
    expect(snapshot?.coverage.fileDigest).toBe(fileDigest(f.file))
    expect(snapshot?.coverage.fileDigest).not.toBe(fileDigest(next))
    const latest = await readCommittedRecoveryEvidence(f.status)
    expect(latest?.lightningJournal).toEqual(next.lightningJournal)
    expect(latest?.coverage.fileDigest).toBe(fileDigest(next))
  },
)

it.each(['mainnet', 'mutinynet'] as const)(
  'rejects incomplete Lightning ancestry before returning any committed coverage (%s)',
  async (network) => {
    const f = await fundedLightningFile(network)
    const key = f.file.header.binding.descriptorHash
    f.file.lightningJournal!.entries[0].exit.transactions = {}
    await recoveryFileStore(key, f.file)
    await expect(readCommittedRecoveryEvidence(f.status)).rejects.toThrow()
    await expect(readCommittedRecoveryCoverage(f.status)).rejects.toThrow()
  },
)

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
