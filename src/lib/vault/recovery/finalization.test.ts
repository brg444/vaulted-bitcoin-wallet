import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RestArkProvider, RestIndexerProvider, Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { recoveryFixture } from './testdata/helpers'
import { retainFinalizationRecovery } from './finalization'
import { recoveryFileStore } from './fileStore'
import { vaultExitRepository } from '../vtxo/exitRepository'
import type { PersistedVtxoSpend } from '../vtxo/spend'
import type { ExitArchive } from './exitArchive'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function fixture() {
  const f = recoveryFixture()
  const checkpoint = new Transaction({ version: 3 })
  checkpoint.addInput({ txid: f.coin.txid, index: f.coin.vout })
  checkpoint.addOutput({ amount: BigInt(f.coin.value), script: hex.decode(f.coin.script) })
  const next = new Transaction({ version: 3 })
  next.addInput({ txid: checkpoint.id, index: 0 })
  next.addOutput({ amount: BigInt(f.coin.value - 1000), script: hex.decode(f.coin.script) })
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(JSON.parse(f.archive.spending.info))
  vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
    chain: f.archive.spending.branches[`${f.coin.txid}:${f.coin.vout}`],
  })
  const fetchTxs = vi
    .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
    .mockResolvedValue({ txs: Object.values(f.archive.spending.transactions) })
  const pending = {
    vaultId: f.status.vaultId,
    operationId: '01'.repeat(32),
    arkTxid: next.id,
    operatorArkPsbt: base64.encode(next.toPSBT()),
    checkpointPsbts: [base64.encode(checkpoint.toPSBT())],
    reservedInputs: [{ txid: f.coin.txid, vout: f.coin.vout, valueSats: f.coin.value, scriptHex: f.coin.script }],
  } as PersistedVtxoSpend
  return { ...f, next, pending, fetchTxs }
}
it('retains the exact successor and ancestors independently of payment-journal deletion', async () => {
  const f = fixture()
  await retainFinalizationRecovery(f.status, f.pending)
  const saved = await recoveryFileStore<ExitArchive>(
    `finalization:${f.status.network}:${f.status.vaultId}:${f.next.id}`,
  )
  expect(saved?.transactions[f.next.id]).toBe(f.pending.operatorArkPsbt)
  const repository = vaultExitRepository(f.status.vaultId, f.status.network)
  expect(await repository.hasBranch({ txid: f.next.id, vout: 0 })).toBe(true)
  await repository.pruneForSpentVtxo({ txid: f.next.id, vout: 0 })
  expect(await repository.hasBranch({ txid: f.next.id, vout: 0 })).toBe(true)
  await repository[Symbol.asyncDispose]()
})
it('rejects missing ancestry before finalization can be released', async () => {
  const f = fixture()
  f.fetchTxs.mockResolvedValue({ txs: [] })
  await expect(retainFinalizationRecovery(f.status, f.pending)).rejects.toThrow()
})
it('propagates storage failure before finalization and preserves an already saved copy', async () => {
  const f = fixture()
  await retainFinalizationRecovery(f.status, f.pending)
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (String(key).startsWith('finalization:')) throw new DOMException('Full', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  await expect(retainFinalizationRecovery(f.status, f.pending)).rejects.toThrow('Full')
  expect(await recoveryFileStore(`finalization:${f.status.network}:${f.status.vaultId}:${f.next.id}`)).toBeTruthy()
})
