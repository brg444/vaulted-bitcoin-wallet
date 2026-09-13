import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryFileStore } from '../recovery/fileStore'
import {
  canRetireMatureBoardingAttempt,
  loadMatureBoardingAttempt,
  loadMatureBoardingRecord,
  matureBoardingAttemptKey,
  persistMatureBoardingAttempt,
  restoreMatureBoardingAttempt,
  retireMatureBoardingAttempt,
  validateMatureBoardingAttempt,
} from './matureBoardingJournal'
import { matureBoardingFixture, matureCoin, scalar, signLiveMatureBoarding } from './testdata/matureBoarding'
import { validateMatureBoardingRecoveryFile } from './boardingRecoveryFile'

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

  it('requires confirmation, history and independent recovery evidence before retirement', async () => {
    const { status, record } = await signedAttempt()
    const confirmed = { ...record, phase: 'confirmed' as const }
    const recovery = {
      vaultId: confirmed.vaultId,
      network: confirmed.network,
      descriptorHash: confirmed.descriptorHash,
      attemptTxid: confirmed.txid,
      attemptHex: confirmed.hex,
    }
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 99_000 },
        recovery,
      }),
    ).toBe(true)
    expect(
      canRetireMatureBoardingAttempt(record, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 99_000 },
        recovery,
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        confirmation: { txid: '00'.repeat(32), confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 99_000 },
        recovery,
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 0 },
        recovery,
      }),
    ).toBe(false)
    expect(
      canRetireMatureBoardingAttempt(confirmed, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 99_000 },
        recovery: { ...recovery, attemptHex: '00' },
      }),
    ).toBe(false)

    await persistMatureBoardingAttempt(status, record)
    await persistMatureBoardingAttempt(status, { ...record, phase: 'dispatched' })
    await persistMatureBoardingAttempt(status, { ...record, phase: 'confirmed' })
    await expect(
      retireMatureBoardingAttempt(status, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: '00'.repeat(32), kind: 'received', amountSats: 99_000 },
        recovery,
      }),
    ).rejects.toThrow(/not ready/)
    expect((await loadMatureBoardingAttempt(status))?.phase).toBe('confirmed')
    expect(
      await retireMatureBoardingAttempt(status, {
        confirmation: { txid: confirmed.txid, confirmed: true, blockHeight: 12 },
        history: { txid: confirmed.txid, kind: 'received', amountSats: 99_000 },
        recovery,
      }),
    ).toMatchObject({ phase: 'retired', txid: confirmed.txid })
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
