import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Transaction, RestArkProvider, RestIndexerProvider, ChainTxType } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { delegationFixture } from './testdata/delegation'
import { testOwner } from './testdata/helpers'
import { lightDescriptorDigest } from './contract'
import { prepareGuardianDelegation, validateGuardianSchedule, type GuardianScheduleRequest } from './delegationRequest'
import { loadGuardianDelegations, type GuardianDelegationStatus } from './delegationStore'
import {
  authorizeGuardianRenewals,
  clearGuardianDelegationReads,
  refreshGuardianRenewals,
  guardianRenewalCoverage,
} from './guardianDelegation'

function environment() {
  const f = delegationFixture()
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: f.coin.commitmentTxIds![0], index: 0 })
  tx.addOutput({ script: hex.decode(f.d.scriptPubKey), amount: BigInt(f.coin.value) })
  f.coin.txid = tx.id
  f.coin.isPreconfirmed = true
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
  const indexer = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [f.coin] })
  const chain = vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
    chain: [
      { txid: f.coin.commitmentTxIds![0], type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
      {
        txid: tx.id,
        type: ChainTxType.TREE,
        spends: f.coin.commitmentTxIds!,
        expiresAt: String(f.coin.expiresAt!.getTime() / 1000),
      },
    ],
  })
  vi.spyOn(RestIndexerProvider.prototype, 'getVirtualTxs').mockResolvedValue({ txs: [base64.encode(tx.toPSBT())] })
  let operations: GuardianDelegationStatus[] = [],
    loseResponse = false
  const submissions: GuardianScheduleRequest[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/info')) return Response.json(f.capability)
    if (url.endsWith('/list')) {
      const remaining = operations.filter((s) => s.operationId > body.afterOperationId)
      const page = remaining.slice(0, 100)
      return Response.json({
        version: 1,
        operations: page,
        nextCursor: remaining.length > 100 ? page.at(-1)!.operationId : '',
      })
    }
    if (url.endsWith('/schedule')) {
      // The exact owner-signed request must already be durable at dispatch.
      expect((await loadGuardianDelegations(f.d)).operations[body.operationId].plan!.request).toEqual(body)
      submissions.push(body)
      const facts = validateGuardianSchedule(body, f.d)
      const status: GuardianDelegationStatus = {
        version: 1,
        descriptorHash: lightDescriptorDigest(f.d),
        operationId: body.operationId,
        state: 'armed',
        validAt: facts.message.valid_at,
        expiresAt: body.expiresAt,
        txid: facts.txid,
        vout: facts.vout,
        inputValueSats: facts.valueSats,
        receiverSats: facts.receiverSats,
      }
      operations = [status]
      if (loseResponse) {
        loseResponse = false
        throw new TypeError('response lost after server commit')
      }
      return Response.json(status)
    }
    if (url.endsWith('/status')) return Response.json(operations.find((s) => s.operationId === body.operationId))
    throw new Error('Unexpected endpoint')
  })
  vi.stubGlobal('fetch', fetch)
  return {
    ...f,
    indexer,
    chain,
    fetch,
    submissions,
    loseNext: () => {
      loseResponse = true
    },
    setRemote: (values: GuardianDelegationStatus[]) => {
      operations = values
    },
    remote: () => operations,
  }
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}),
    },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('Guardian renewal lifecycle using actual SDK requests and durable journal', () => {
  it('authorizes committed received/change outputs and retries the exact request after response loss', async () => {
    const f = environment()
    f.loseNext()
    const first = await authorizeGuardianRenewals(f.d, testOwner)
    expect(f.submissions).toHaveLength(1)
    expect(first!.operations[f.submissions[0].operationId].status).toBeUndefined()
    expect(guardianRenewalCoverage(f.d, first, [f.coin]).scheduled).toBe(0)
    const retried = await refreshGuardianRenewals(f.d)
    expect(f.submissions).toHaveLength(2)
    expect(f.submissions[1]).toEqual(f.submissions[0])
    expect(guardianRenewalCoverage(f.d, retried, [f.coin]).scheduled).toBe(1)
    await authorizeGuardianRenewals(f.d, testOwner)
    expect(f.submissions).toHaveLength(2)
    expect(testOwner[31]).toBe(1)
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it('discovers an existing authorization on a fresh browser instead of signing a duplicate', async () => {
    const f = environment()
    const plan = await prepareGuardianDelegation(f.d, f.coin, f.info, f.capability, testOwner)
    f.setRemote([
      {
        version: 1,
        operationId: plan.request.operationId,
        descriptorHash: lightDescriptorDigest(f.d),
        state: 'register_dispatched',
        validAt: plan.validAt,
        expiresAt: plan.request.expiresAt,
        txid: plan.txid,
        vout: plan.vout,
        inputValueSats: plan.valueSats,
        receiverSats: plan.receiverSats,
      },
    ])
    const result = await authorizeGuardianRenewals(f.d, testOwner)
    expect(f.submissions).toHaveLength(0)
    expect(guardianRenewalCoverage(f.d, result, [f.coin])).toMatchObject({ scheduled: 0, renewing: 1, pending: 0 })
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it('never treats a dispatch timeout as releasing an input, even beyond the dispatch window', async () => {
    const f = environment()
    await authorizeGuardianRenewals(f.d, testOwner)
    f.setRemote(f.remote().map((s) => ({ ...s, state: 'register_dispatched' })))
    const result = await refreshGuardianRenewals(f.d)
    const later = Date.now() + 30 * 86400000
    expect(guardianRenewalCoverage(f.d, result, [f.coin], later).renewing).toBe(1)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later)
    const calls = f.fetch.mock.calls.length
    await refreshGuardianRenewals(f.d)
    expect(f.fetch.mock.calls.length).toBe(calls)
    spy.mockRestore()
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it('keeps missing ancestry and reserved inputs pending without owner signatures', async () => {
    const f = environment()
    f.chain.mockResolvedValue({ chain: [] })
    const incomplete = await authorizeGuardianRenewals(f.d, testOwner)
    expect(incomplete!.error).toContain('ancestry is incomplete')
    expect(f.submissions).toHaveLength(0)
    await authorizeGuardianRenewals(f.d, testOwner, new Set([`${f.coin.txid}:${f.coin.vout}`]))
    expect(f.submissions).toHaveLength(0)
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it('keeps ambiguous cancellation distinct from renewal confirmation and never releases it by timeout', async () => {
    const f = environment()
    await authorizeGuardianRenewals(f.d, testOwner)
    f.setRemote(f.remote().map((s) => ({ ...s, state: 'cleanup_pending' })))
    const result = await refreshGuardianRenewals(f.d)
    expect(guardianRenewalCoverage(f.d, result, [f.coin], Date.now() + 90 * 86400000)).toMatchObject({
      scheduled: 0,
      renewing: 0,
      cancelling: 1,
      pending: 0,
    })
    await authorizeGuardianRenewals(f.d, testOwner)
    expect(f.submissions).toHaveLength(1)
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it('rejects changed source identity and preserves the earlier acknowledged operation', async () => {
    const f = environment()
    const first = await authorizeGuardianRenewals(f.d, testOwner)
    const id = f.submissions[0].operationId
    f.setRemote(f.remote().map((s) => ({ ...s, txid: 'ff'.repeat(32) })))
    const next = await refreshGuardianRenewals(f.d)
    expect(next!.error).toContain('changed the authorized output')
    expect(next!.operations[id].status).toEqual(first!.operations[id].status)
    clearGuardianDelegationReads(f.d.vaultId)
  })
  it.each(['cancelled', 'confirmed'])(
    'streams more than 512 %s records without exhausting future renewal coverage',
    async (state) => {
      const f = environment()
      const plan = await prepareGuardianDelegation(f.d, f.coin, f.info, f.capability, testOwner)
      const base: GuardianDelegationStatus = {
        version: 1,
        operationId: 'ff'.repeat(16),
        descriptorHash: lightDescriptorDigest(f.d),
        state: 'armed',
        validAt: plan.validAt,
        expiresAt: plan.request.expiresAt,
        txid: plan.txid,
        vout: plan.vout,
        inputValueSats: plan.valueSats,
        receiverSats: plan.receiverSats,
      }
      f.setRemote([
        ...Array.from({ length: 600 }, (_, i) => ({
          ...base,
          operationId: i.toString(16).padStart(32, '0'),
          state,
          ...(state === 'confirmed' ? { receiverTxid: i.toString(16).padStart(64, '0'), receiverVout: 0 } : {}),
        })),
        base,
      ])
      f.indexer.mockImplementation(async (filter) => ({
        vtxos: filter?.outpoints ? filter.outpoints.map((p) => ({ ...f.coin, ...p, isSpent: true })) : [f.coin],
      }))
      const result = await authorizeGuardianRenewals(f.d, testOwner)
      expect(result!.error).toBeUndefined()
      expect(Object.keys(result!.operations)).toEqual([base.operationId])
      expect(guardianRenewalCoverage(f.d, result, [f.coin]).scheduled).toBe(1)
      expect(f.fetch.mock.calls.filter(([url]) => url.endsWith('/list'))).toHaveLength(7)
      expect(f.submissions).toHaveLength(0)
      clearGuardianDelegationReads(f.d.vaultId)
    },
  )
  it('keeps an unsupported Guardian optional and clears read authority on lock', async () => {
    const f = environment()
    f.fetch.mockResolvedValueOnce(Response.json({ version: 1, enabled: false }))
    const unsupported = await authorizeGuardianRenewals(f.d, testOwner)
    expect(unsupported!.available).toBe(false)
    expect(f.submissions).toHaveLength(0)
    await authorizeGuardianRenewals(f.d, testOwner)
    clearGuardianDelegationReads(f.d.vaultId)
    const calls = f.fetch.mock.calls.length
    await refreshGuardianRenewals(f.d)
    expect(f.fetch.mock.calls.length).toBe(calls)
  })
})
