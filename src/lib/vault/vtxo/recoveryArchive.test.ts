import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boardingJournalFixture, recoveryFixture } from '../recovery/testdata/helpers'
import {
  loadVaultRecoveryArchive,
  storeVaultRecoveryArchive,
  validateVaultRecoveryArchive,
  vaultArchiveProviders,
} from './recoveryArchive'
import { loadBoardingTranscripts, persistBoardingTranscript } from './boardingJournal'

describe('Standard and Advanced complete Spending archives', () => {
  it.each([false, true])(
    'validates independently and supplies transactions during both service outages (advanced=%s)',
    async (advanced) => {
      for (const network of ['mainnet', 'mutinynet'] as const) {
        const { archive, tx } = recoveryFixture(advanced, network)
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('all services unavailable'))
        try {
          const imported = JSON.parse(JSON.stringify(archive))
          const local = vaultArchiveProviders(imported)
          expect(local.coins).toHaveLength(1)
          expect((await local.source.getVirtualTxs([tx.id])).size).toBe(1)
          expect(fetch).not.toHaveBeenCalled()
        } finally {
          fetch.mockRestore()
        }
      }
    },
  )
  it('rejects changed tier, network, recovery key, Operator and missing graph evidence', () => {
    const { archive } = recoveryFixture()
    for (const mutate of [
      (a: typeof archive) => {
        a.status.protectionTier = 'standard'
      },
      (a: typeof archive) => {
        a.status.network = 'mainnet'
      },
      (a: typeof archive) => {
        a.status.recoveryPub = a.status.phoneBip340Pub
      },
      (a: typeof archive) => {
        a.status.vtxoBoardingDescriptor!.operatorPub = a.status.phoneBip340Pub!
      },
      (a: typeof archive) => {
        a.spending.transactions = {}
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(archive))
      mutate(changed)
      expect(() => validateVaultRecoveryArchive(changed)).toThrow()
    }
  })
})

describe('boarding evidence in complete program archive imports', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('navigator', { locks: { request: (_key: string, run: () => Promise<unknown>) => run() } })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('immediately includes all local evidence when importing an older file, including the first saved archive', async () => {
    const { archive, kit, status, descriptor, request } = boardingJournalFixture()
    expect(archive.boardingTranscripts).toBeUndefined()
    await persistBoardingTranscript(status.vaultId, descriptor, request)
    const first = await storeVaultRecoveryArchive(archive)
    expect(first.boardingTranscripts?.map((record) => record.request)).toEqual([request])
    expect((await loadVaultRecoveryArchive(kit, status))?.boardingTranscripts).toEqual(first.boardingTranscripts)

    const local = { ...request, handle: 'later-local-attempt' }
    const imported = { ...request, handle: 'another-device-attempt' }
    await persistBoardingTranscript(status.vaultId, descriptor, local)
    const incoming = {
      ...archive,
      boardingTranscripts: [
        {
          requestHash: hex.encode(sha256(new TextEncoder().encode(JSON.stringify(imported)))),
          request: imported,
        },
      ],
    }
    const restored = await storeVaultRecoveryArchive(incoming)
    expect(restored.boardingTranscripts?.map((record) => record.request.handle).sort()).toEqual([
      'another-device-attempt',
      'later-local-attempt',
      'test-handle',
    ])
    expect((await loadVaultRecoveryArchive(kit, status))?.boardingTranscripts).toEqual(restored.boardingTranscripts)
    expect(await loadBoardingTranscripts(status.vaultId, descriptor)).toEqual(restored.boardingTranscripts)
    expect((await storeVaultRecoveryArchive(archive)).boardingTranscripts).toEqual(restored.boardingTranscripts)
  })

  it('preserves the previous archive and local journal when the archive replacement fails', async () => {
    const { archive, kit, status, descriptor, request } = boardingJournalFixture()
    const first = await storeVaultRecoveryArchive(archive)
    await persistBoardingTranscript(status.vaultId, descriptor, request)
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'archive') throw new DOMException('Storage full', 'QuotaExceededError')
      return put.call(this, value, key)
    })
    await expect(storeVaultRecoveryArchive(archive)).rejects.toThrow('Storage full')
    expect(await loadVaultRecoveryArchive(kit, status)).toEqual(first)
    expect((await loadBoardingTranscripts(status.vaultId, descriptor)).map((record) => record.request)).toEqual([
      request,
    ])
  })

  it('checks the total archive size before parsing nested transaction or descriptor evidence', () => {
    const { archive } = recoveryFixture()
    archive.spending.transactions = { ['ab'.repeat(32)]: '!'.repeat(24_000_001) }
    expect(() => validateVaultRecoveryArchive(archive)).toThrow(/archive limit/)
  })
})
