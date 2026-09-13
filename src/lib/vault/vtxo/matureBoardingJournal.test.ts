import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryFileStore } from '../recovery/fileStore'
import {
  canRetireMatureBoardingAttempt,
  loadMatureBoardingAttempt,
  loadMatureBoardingRecord,
  matureBoardingAttemptKey,
  matureBoardingOutputSats,
  persistMatureBoardingAttempt,
  restoreMatureBoardingAttempt,
  retireMatureBoardingAttempt,
  validateMatureBoardingAttempt,
} from './matureBoardingJournal'
import {
  chainProvider,
  exclusiveVaultLocks,
  matureBoardingFixture,
  matureCoin,
  scalar,
  signLiveMatureBoarding,
} from './testdata/matureBoarding'
import { validateMatureBoardingRecoveryFile } from './boardingRecoveryFile'
import { acknowledgeMatureBoardingRecovery, recoverMatureBoardingInputs } from './boardingRecovery'

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

async function signedAttempt() {
  const { enrollment, mature, status } = matureBoardingFixture()
  const signed = await signLiveMatureBoarding({
    enrollment,
    status,
    inputs: [mature],
    phoneSecret: scalar(2),
  })
  const record = signed.store.get()!
  return { status, record: { ...record, phase: 'signed' as const, conflictTxid: undefined } }
}

describe('mature boarding attempt journal', () => {
  it('persists signed bytes, rejects a different replacement, and advances phases', async () => {
    const { status, record } = await signedAttempt()
    const saved = await persistMatureBoardingAttempt(status, record)
    expect(saved.phase).toBe('signed')
    expect(await loadMatureBoardingAttempt(status)).toEqual(saved)
    expect(validateMatureBoardingRecoveryFile(saved.evidence).txid).toBe(saved.txid)

    const { enrollment, mature } = matureBoardingFixture()
    const replacement = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature, matureCoin(mature, '22'.repeat(32))],
      phoneSecret: scalar(2),
    })
    await expect(
      persistMatureBoardingAttempt(status, { ...replacement.store.get()!, phase: 'signed', conflictTxid: undefined }),
    ).rejects.toThrow(/already retained/)
    expect(await loadMatureBoardingAttempt(status)).toEqual(saved)

    const dispatched = await persistMatureBoardingAttempt(status, { ...saved, phase: 'dispatched' })
    expect(dispatched.phase).toBe('dispatched')
    await expect(persistMatureBoardingAttempt(status, { ...saved, phase: 'signed' })).rejects.toThrow(/backward/)
  })

  it('rejects an aborted write after put succeeded and keeps the previous record', async () => {
    const { status, record } = await signedAttempt()
    await persistMatureBoardingAttempt(status, record)
    const put = IDBObjectStore.prototype.put
    let putSucceeded = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const saved = put.call(this, value, key)
      if (typeof key === 'string' && key.startsWith('mature-boarding-attempt:')) {
        saved.addEventListener('success', () => {
          putSucceeded = true
          this.transaction.abort()
        })
      }
      return saved
    })
    const outcome = await persistMatureBoardingAttempt(status, { ...record, phase: 'dispatched' }).then(
      () => 'committed',
      () => 'aborted',
    )
    expect(outcome).toBe('aborted')
    expect(putSucceeded).toBe(true)
    expect((await loadMatureBoardingAttempt(status))?.phase).toBe('signed')
  })

  it('rejects malformed saved records and does not treat them as reusable inputs', async () => {
    const { status, record } = await signedAttempt()
    const key = matureBoardingAttemptKey(status.vaultId, record.evidence.network, record.evidence.descriptor.script)
    await recoveryFileStore(key, { ...record, txid: 'not-a-txid' })
    await expect(loadMatureBoardingAttempt(status)).rejects.toThrow(/changed|match|Invalid/)
    expect(() =>
      validateMatureBoardingAttempt(status, { ...record, evidence: { ...record.evidence, psbt: '00' } }),
    ).toThrow()
  })

  it('requires confirmation, destination receive amount and independent recovery evidence before retirement', async () => {
    const { status, record } = await signedAttempt()
    const confirmed = { ...record, phase: 'confirmed' as const }
    const amountSats = matureBoardingOutputSats(confirmed)
    expect(amountSats).toBeGreaterThan(1)
    const recovery = {
      vaultId: confirmed.vaultId,
      network: confirmed.network,
      descriptorHash: confirmed.descriptorHash,
      attemptTxid: confirmed.txid,
      attemptHex: confirmed.hex,
    }
    const valid = {
      confirmation: { txid: confirmed.txid, confirmed: true as const, blockHeight: 12 },
      history: { txid: confirmed.txid, kind: 'received' as const, amountSats },
      recovery,
    }
    expect(canRetireMatureBoardingAttempt(confirmed, valid)).toBe(true)
    expect(canRetireMatureBoardingAttempt(record, valid)).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        ...valid,
        confirmation: { ...valid.confirmation, txid: '00'.repeat(32) },
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        ...valid,
        history: { ...valid.history, amountSats: 1 },
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        ...valid,
        history: { ...valid.history, kind: 'sent' },
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        ...valid,
        recovery: { ...recovery, attemptHex: '00' },
      }),
    ).toBe(false)

    await persistMatureBoardingAttempt(status, record)
    await persistMatureBoardingAttempt(status, { ...record, phase: 'dispatched' })
    await persistMatureBoardingAttempt(status, { ...record, phase: 'confirmed' })
    await expect(
      retireMatureBoardingAttempt(status, {
        ...valid,
        history: { ...valid.history, txid: '00'.repeat(32) },
      }),
    ).rejects.toThrow(/not ready/)
    expect((await loadMatureBoardingAttempt(status))?.phase).toBe('confirmed')
    expect(await retireMatureBoardingAttempt(status, valid)).toMatchObject({ phase: 'retired', txid: confirmed.txid })
    expect(await loadMatureBoardingAttempt(status)).toBeNull()
    expect(await loadMatureBoardingRecord(status)).toMatchObject({ phase: 'retired', txid: confirmed.txid })
  })

  it('restores matching evidence and rejects a conflicting live record', async () => {
    const { status, record } = await signedAttempt()
    await persistMatureBoardingAttempt(status, record)
    await expect(restoreMatureBoardingAttempt(status, { ...record, phase: 'dispatched' })).resolves.toMatchObject({
      phase: 'dispatched',
    })
    const { enrollment, mature } = matureBoardingFixture()
    const replacement = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature, matureCoin(mature, '22'.repeat(32))],
      phoneSecret: scalar(2),
    })
    await expect(
      restoreMatureBoardingAttempt(status, {
        ...replacement.store.get()!,
        phase: 'signed',
        conflictTxid: undefined,
      }),
    ).rejects.toThrow(/Conflicting/)
    expect((await loadMatureBoardingAttempt(status))?.txid).toBe(record.txid)
  })
})

describe('producer through the real mature boarding journal', () => {
  it.each([false, true])('fences dispatch after persisted dispatched bytes when cancel=%s', async (cancel) => {
    const f = matureBoardingFixture()
    const abort = new AbortController()
    const provider = chainProvider()
    const result = await recoverMatureBoardingInputs(f.enrollment, f.status, {
      getBoardingUtxos: async () => [f.mature],
      unlockPhone: async () => f.phoneSecret,
      onchainProvider: provider,
      locks: exclusiveVaultLocks(),
      signal: abort.signal,
      persistAttempt: async (status, next) => {
        const saved = await persistMatureBoardingAttempt(status, next)
        if (cancel && next.phase === 'dispatched') abort.abort(new DOMException('Session ended', 'AbortError'))
        return saved
      },
    }).then(
      (txid) => ({ txid, aborted: false }),
      (error) => ({ aborted: error instanceof DOMException && error.name === 'AbortError' }),
    )
    expect((await loadMatureBoardingAttempt(f.status))?.hex).toBeTruthy()
    expect(provider.broadcast).toHaveBeenCalledTimes(cancel ? 0 : 1)
    expect(result.aborted).toBe(cancel)
  })

  it('resumes exact bytes through the journal and fences a cancelled dispatched persist', async () => {
    const { status, record } = await signedAttempt()
    await persistMatureBoardingAttempt(status, record)
    const abort = new AbortController()
    const provider = chainProvider()
    const { enrollment, mature } = matureBoardingFixture()
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => scalar(2),
        onchainProvider: provider,
        locks: exclusiveVaultLocks(),
        signal: abort.signal,
        persistAttempt: async (nextStatus, next) => {
          const saved = await persistMatureBoardingAttempt(nextStatus, next)
          if (next.phase === 'dispatched') abort.abort(new DOMException('Session ended', 'AbortError'))
          return saved
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.broadcast).not.toHaveBeenCalled()
    expect(await loadMatureBoardingAttempt(status)).toMatchObject({
      txid: record.txid,
      hex: record.hex,
      phase: 'dispatched',
    })
  })

  it('confirms, acknowledges from committed evidence, and then allows a later sweep', async () => {
    const f = matureBoardingFixture()
    const first = await recoverMatureBoardingInputs(f.enrollment, f.status, {
      getBoardingUtxos: async () => [f.mature],
      unlockPhone: async () => scalar(2),
      onchainProvider: chainProvider(),
      locks: exclusiveVaultLocks(),
    })
    const live = (await loadMatureBoardingAttempt(f.status))!
    expect(live.phase).toBe('dispatched')
    expect(live.hex).toBeTruthy()
    const amountSats = matureBoardingOutputSats(live)
    const coverage = {
      vaultId: live.vaultId,
      network: live.network,
      descriptorHash: live.descriptorHash,
      fileDigest: 'aa'.repeat(32),
      outputs: [],
    }
    const confirmedProvider = chainProvider({
      txStatus: async (txid) =>
        txid === live.txid ? { confirmed: true, blockHeight: 12, blockTime: 1 } : Promise.reject(new Error('404')),
      transactions: async () => [
        {
          txid: live.txid,
          vout: [{ scriptpubkey_address: live.evidence.destination, value: String(amountSats) }],
          status: { confirmed: true, block_time: 1 },
        },
      ],
    })
    await expect(
      acknowledgeMatureBoardingRecovery(f.status, {
        coverage,
        onchainProvider: confirmedProvider,
        locks: exclusiveVaultLocks(),
        readCommittedJournal: async () => live,
        readCoverage: async () => coverage,
      }),
    ).resolves.toBe(true)
    expect(await loadMatureBoardingAttempt(f.status)).toBeNull()
    expect(await loadMatureBoardingRecord(f.status)).toMatchObject({ phase: 'retired', txid: live.txid })

    const later = await recoverMatureBoardingInputs(f.enrollment, f.status, {
      getBoardingUtxos: async () => [matureCoin(f.mature, '22'.repeat(32))],
      unlockPhone: async () => scalar(2),
      onchainProvider: chainProvider(),
      locks: exclusiveVaultLocks(),
    })
    const next = (await loadMatureBoardingAttempt(f.status))!
    expect(next.txid).toBe(later)
    expect(next.txid).not.toBe(live.txid)
    expect(next.phase).toBe('dispatched')
    expect(first).toBe(live.txid)
  })

  it('retains the journal when the committed file, history, chain or retire write is missing', async () => {
    const { status, record } = await signedAttempt()
    await persistMatureBoardingAttempt(status, record)
    await persistMatureBoardingAttempt(status, { ...record, phase: 'dispatched' })
    const amountSats = matureBoardingOutputSats(record)
    const coverage = {
      vaultId: record.vaultId,
      network: record.network,
      descriptorHash: record.descriptorHash,
      fileDigest: 'aa'.repeat(32),
      outputs: [],
    }
    const confirmed = chainProvider({
      txStatus: async () => ({ confirmed: true, blockHeight: 12, blockTime: 1 }),
      transactions: async () => [
        {
          txid: record.txid,
          vout: [{ scriptpubkey_address: record.evidence.destination, value: String(amountSats) }],
          status: { confirmed: true, block_time: 1 },
        },
      ],
    })
    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: confirmed,
        locks: exclusiveVaultLocks(),
        persistAttempt: persistMatureBoardingAttempt,
        readCommittedJournal: async () => null,
        readCoverage: async () => coverage,
      }),
    ).resolves.toBe(false)
    expect((await loadMatureBoardingAttempt(status))?.phase).toBe('confirmed')

    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: chainProvider({
          txStatus: async () => {
            throw new Error('indexer timeout')
          },
        }),
        locks: exclusiveVaultLocks(),
        readCommittedJournal: async () => ({ ...record, phase: 'confirmed' }),
        readCoverage: async () => coverage,
      }),
    ).resolves.toBe(false)

    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: chainProvider({
          txStatus: async () => ({ confirmed: true, blockHeight: 12, blockTime: 1 }),
          transactions: async () => [],
        }),
        locks: exclusiveVaultLocks(),
        readCommittedJournal: async () => ({ ...record, phase: 'confirmed' }),
        readCoverage: async () => coverage,
      }),
    ).resolves.toBe(false)

    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: confirmed,
        locks: exclusiveVaultLocks(),
        readCommittedJournal: async () => ({ ...record, phase: 'confirmed', txid: 'ff'.repeat(32), hex: '00' }),
        readCoverage: async () => coverage,
      }),
    ).resolves.toBe(false)

    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: confirmed,
        locks: exclusiveVaultLocks(),
        readCommittedJournal: async () => ({ ...record, phase: 'confirmed' }),
        readCoverage: async () => coverage,
        retireAttempt: async () => {
          throw new Error('Storage is full')
        },
      }),
    ).resolves.toBe(false)
    expect((await loadMatureBoardingAttempt(status))?.txid).toBe(record.txid)
  })
})
