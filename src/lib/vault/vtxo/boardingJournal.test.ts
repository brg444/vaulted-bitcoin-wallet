import 'fake-indexeddb/auto'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardingFinalRequest } from '../cosignerClient'
import { boardingJournalFixture } from '../recovery/testdata/helpers'
import {
  loadBoardingTranscripts,
  mergeBoardingTranscripts,
  persistBoardingTranscript,
  validateBoardingTranscripts,
  type BoardingTranscript,
} from './boardingJournal'

function transcript(request: BoardingFinalRequest): BoardingTranscript {
  return { requestHash: hex.encode(sha256(new TextEncoder().encode(JSON.stringify(request)))), request }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const pending = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', {
    locks: {
      request: (key: string, run: () => Promise<unknown>) => {
        const next = (pending.get(key) ?? Promise.resolve()).then(run)
        pending.set(
          key,
          next.catch(() => undefined),
        )
        return next
      },
    },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('boarding final evidence journal', () => {
  it('commits a detached exact request before resolving and retains concurrent attempts after reopening IndexedDB', async () => {
    const { status, descriptor, request } = boardingJournalFixture()
    const original = structuredClone(request)
    let writeCommitted = false
    const transaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, stores, mode) {
      const tx = transaction.call(this, stores, mode)
      if (mode === 'readwrite')
        tx.addEventListener('complete', () => {
          writeCommitted = true
        })
      return tx
    })
    const saving = persistBoardingTranscript(status.vaultId, descriptor, request).then(() => {
      expect(writeCommitted).toBe(true)
    })
    request.handle = 'mutated-after-call'
    await saving
    expect(await loadBoardingTranscripts(status.vaultId, descriptor)).toEqual([transcript(original)])

    const second = { ...original, handle: 'second-attempt' }
    const third = { ...original, handle: 'third-attempt' }
    await Promise.all([
      persistBoardingTranscript(status.vaultId, descriptor, second),
      persistBoardingTranscript(status.vaultId, descriptor, third),
    ])
    expect(await loadBoardingTranscripts(status.vaultId, descriptor)).toEqual([
      transcript(original),
      transcript(second),
      transcript(third),
    ])
    expect(await loadBoardingTranscripts('different-vault', descriptor)).toEqual([])
  })

  it('rejects an aborted write even after the put request succeeded, preserving the previous evidence', async () => {
    const { status, descriptor, request } = boardingJournalFixture()
    await persistBoardingTranscript(status.vaultId, descriptor, request)
    const put = IDBObjectStore.prototype.put
    let putSucceeded = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const saved = put.call(this, value, key)
      if (typeof key === 'string' && key.startsWith('boarding-transcripts:')) {
        saved.addEventListener('success', () => {
          putSucceeded = true
          this.transaction.abort()
        })
      }
      return saved
    })
    const outcome = await persistBoardingTranscript(status.vaultId, descriptor, { ...request, handle: 'aborted' }).then(
      () => 'committed',
      () => 'aborted',
    )
    expect(outcome).toBe('aborted')
    expect(putSucceeded).toBe(true)
    expect(await loadBoardingTranscripts(status.vaultId, descriptor)).toEqual([transcript(request)])
  })

  it('requires cross-context locking before writing', async () => {
    const { status, descriptor, request } = boardingJournalFixture()
    vi.stubGlobal('navigator', {})
    await expect(persistBoardingTranscript(status.vaultId, descriptor, request)).rejects.toThrow('Web Locks required')
    expect(await loadBoardingTranscripts(status.vaultId, descriptor)).toEqual([])
  })

  it('merges exact duplicates but rejects tampering and another deposit script', () => {
    const { descriptor, request } = boardingJournalFixture()
    const record = transcript(request)
    expect(mergeBoardingTranscripts(descriptor, [record], [structuredClone(record)])).toEqual([record])
    expect(() => validateBoardingTranscripts([{ ...record, requestHash: '00'.repeat(32) }], descriptor)).toThrow(
      /changed/,
    )
    expect(() => validateBoardingTranscripts([record], { ...descriptor, script: '5120' + '00'.repeat(32) })).toThrow(
      /different deposit script/,
    )
  })

  it('rejects malformed requests and unsigned, incomplete, duplicate, or changed tree evidence', () => {
    const { descriptor, request, unsignedTree } = boardingJournalFixture()
    const malformed: unknown[] = [
      null,
      { ...request, signedForfeits: null },
      { ...request, inputIndexes: [-1] },
      { ...request, validatedBatch: null },
      { ...request, validatedBatch: { ...request.validatedBatch, vtxoTree: [] } },
      { ...request, validatedBatch: { ...request.validatedBatch, expectedRecipients: [null] } },
      { ...request, validatedBatch: { ...request.validatedBatch, vtxoTree: [null] } },
      {
        ...request,
        validatedBatch: {
          ...request.validatedBatch,
          vtxoTree: [{ ...request.validatedBatch.vtxoTree[0], tx: unsignedTree }],
        },
      },
      {
        ...request,
        validatedBatch: {
          ...request.validatedBatch,
          vtxoTree: [...request.validatedBatch.vtxoTree, ...request.validatedBatch.vtxoTree],
        },
      },
      {
        ...request,
        validatedBatch: {
          ...request.validatedBatch,
          vtxoTree: [{ ...request.validatedBatch.vtxoTree[0], txid: '00'.repeat(32) }],
        },
      },
      {
        ...request,
        validatedBatch: {
          ...request.validatedBatch,
          vtxoTree: [{ ...request.validatedBatch.vtxoTree[0], children: { 0: '00'.repeat(32) } }],
        },
      },
    ]
    for (const value of malformed)
      expect(() => validateBoardingTranscripts([transcript(value as BoardingFinalRequest)], descriptor)).toThrow()
  })

  it('rejects oversized evidence before decoding an invalid PSBT', async () => {
    const { status, descriptor, request } = boardingJournalFixture()
    const oversized = { ...request, psbt: '!'.repeat(24_000_001) }
    expect(() => validateBoardingTranscripts([transcript(oversized)], descriptor)).toThrow(/storage limit/)
    await expect(persistBoardingTranscript(status.vaultId, descriptor, oversized)).rejects.toThrow(/storage limit/)
  })
})
