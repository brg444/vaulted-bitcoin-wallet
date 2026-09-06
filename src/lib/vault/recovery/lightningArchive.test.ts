import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64 } from '@scure/base'
import {
  InMemoryContractRepository,
  InMemoryVirtualTxRepository,
  RestArkProvider,
  RestIndexerProvider,
  VHTLCV2ContractHandler,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { InMemoryAssetSwapRepository } from '@arkade-os/swap'
import { lightningRecoveryFixture } from './testdata/lightningFixtures'
import {
  captureLightningRecoveryJournal,
  validateLightningRecoveryJournal,
  restoreLightningRecoveryJournal,
  lightningArchiveProviders,
} from './lightningArchive'

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, run) => run({})) } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function stores(f = lightningRecoveryFixture()) {
  const swaps = new InMemoryAssetSwapRepository()
  const contracts = new InMemoryContractRepository()
  const virtualTxRepository = new InMemoryVirtualTxRepository()
  await swaps.saveRfqSwap(structuredClone(f.record))
  await contracts.saveContract(structuredClone(f.contract))
  return { swaps, contracts, virtualTxRepository }
}
async function chainFixture(f: ReturnType<typeof lightningRecoveryFixture>) {
  const local = lightningArchiveProviders(f.entry, f.binding)
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(await local.arkProvider.getInfo())
  const getCoins = vi
    .spyOn(RestIndexerProvider.prototype, 'getVtxos')
    .mockResolvedValue({ vtxos: local.coins as VirtualCoin[] })
  const getChain = vi
    .spyOn(RestIndexerProvider.prototype, 'getVtxoChain')
    .mockResolvedValue({ chain: f.entry.exit.branches[f.tx.id + ':0'] })
  const getTransactions = vi
    .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
    .mockResolvedValue({ txs: [base64.encode(f.tx.toPSBT())] })
  return { getCoins, getChain, getTransactions }
}

describe('outbound Lightning recovery journal', () => {
  it.each(['light', 'standard', 'advanced'] as const)(
    'preserves both lockup variants and sender exits for %s on both networks',
    async (tier) => {
      for (const network of ['mainnet', 'mutinynet'] as const)
        for (const nine of [false, true]) {
          const f = lightningRecoveryFixture({ network, nine, light: tier === 'light', advanced: tier === 'advanced' })
          const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('all services unavailable'))
          try {
            const recovered = JSON.parse(JSON.stringify(f.journal))
            expect(validateLightningRecoveryJournal(recovered, f.binding)).toEqual(f.journal)
            const local = lightningArchiveProviders(recovered.entries[0], f.binding)
            expect(local.coins[0].txid).toBe(f.tx.id)
            expect(await local.source.getVirtualTxs([f.tx.id])).toEqual(
              new Map([[f.tx.id, base64.encode(f.tx.toPSBT())]]),
            )
            const script = VHTLCV2ContractHandler.createScript(local.contract.params)
            expect(script.options.nonInteractiveRefund?.withoutReceiver === true).toBe(nine)
            const paths = VHTLCV2ContractHandler.getAllSpendingPaths(script, local.contract, {
              collaborative: false,
              currentTime: Date.now(),
              walletDescriptor: local.signingDescriptor,
            })
            expect(paths).toHaveLength(1)
            expect(paths[0].leaf).toEqual(script.unilateralRefundWithoutReceiver())
            expect(paths[0].sequence).toBe(Number(f.contract.params.refundNoReceiverDelay))
            expect(fetch).not.toHaveBeenCalled()
          } finally {
            fetch.mockRestore()
          }
        }
    },
  )

  it('captures actual funded graph and preserves ambiguous funding without a txid', async () => {
    const f = lightningRecoveryFixture({ nine: true }),
      storage = await stores(f)
    await chainFixture(f)
    const journal = await captureLightningRecoveryJournal({ binding: f.binding, ...storage })
    expect(journal.entries[0].record).toEqual(f.record)
    expect(journal.entries[0].record.fundingArkTxid).toBeUndefined()
    expect(journal.entries[0].record.profile.vaultLightning).toMatchObject({
      fundingState: 'funding',
      fundingProof: { operationId: 'aa'.repeat(16) },
    })
    expect(journal.entries[0].contract.params).toEqual(f.contract.params)
    expect(journal.entries[0].exit.transactions).toEqual(f.entry.exit.transactions)
  })

  it('rejects incomplete/outage captures without touching the last complete journal', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f),
      snapshot = JSON.stringify(f.journal)
    const chain = await chainFixture(f)
    chain.getCoins.mockResolvedValue({ vtxos: [] })
    await expect(
      captureLightningRecoveryJournal({ binding: f.binding, ...storage, previous: f.journal }),
    ).rejects.toThrow('missing')
    expect(JSON.stringify(f.journal)).toBe(snapshot)
    vi.spyOn(RestArkProvider.prototype, 'getInfo').mockRejectedValue(new Error('Operator unavailable'))
    await expect(
      captureLightningRecoveryJournal({ binding: f.binding, ...storage, previous: f.journal }),
    ).rejects.toThrow('unavailable')
    expect(JSON.stringify(f.journal)).toBe(snapshot)
  })

  it('refuses a newly funded lockup with incomplete transaction evidence', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f),
      chain = await chainFixture(f)
    chain.getTransactions.mockResolvedValue({ txs: [] })
    await expect(captureLightningRecoveryJournal({ binding: f.binding, ...storage })).rejects.toThrow()
    expect(await storage.swaps.getRfqSwap(f.record.rfqId)).toEqual(f.record)
  })

  it('does not drop records absent locally or turn known funding back into a quote', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f)
    await chainFixture(f)
    const local = structuredClone(f.record)
    local.updatedAt++
    const profile = local.profile.vaultLightning as Record<string, unknown>
    profile.fundingState = 'quoted'
    delete profile.fundingProof
    await storage.swaps.saveRfqSwap(local)
    await expect(
      captureLightningRecoveryJournal({ binding: f.binding, ...storage, previous: f.journal }),
    ).rejects.toThrow('missing saved funding')
    const empty = new InMemoryAssetSwapRepository()
    const retained = await captureLightningRecoveryJournal({
      binding: f.binding,
      ...storage,
      swaps: empty,
      previous: f.journal,
    })
    expect(retained).toEqual(f.journal)
  })

  it('restores a fresh repository, then preserves locally newer and resolved records and contract watch state', async () => {
    const f = lightningRecoveryFixture()
    const swaps = new InMemoryAssetSwapRepository(),
      contracts = new InMemoryContractRepository()
    expect(await restoreLightningRecoveryJournal(f.journal, f.binding, { swaps, contracts })).toEqual({
      restored: 1,
      retained: 0,
    })
    expect(await swaps.getRfqSwap(f.record.rfqId)).toEqual(f.record)
    const local = structuredClone(f.record)
    local.updatedAt += 10
    local.state = 'settled'
    local.lockupSpendArkTxids = ['cc'.repeat(32)]
    await swaps.saveRfqSwap(local)
    await contracts.saveContract({ ...f.contract, state: 'inactive', watch: 'retained' })
    expect(await restoreLightningRecoveryJournal(f.journal, f.binding, { swaps, contracts })).toEqual({
      restored: 0,
      retained: 1,
    })
    expect(await swaps.getRfqSwap(local.rfqId)).toEqual(local)
    expect((await contracts.getContracts())[0]).toMatchObject({ state: 'inactive', watch: 'retained' })
  })

  it('rejects contract/funding conflicts before any restore mutation', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f)
    const contract = {
      ...f.contract,
      params: {
        ...f.contract.params,
        refundNoReceiverDelay: String(Number(f.contract.params.refundNoReceiverDelay) + 1),
      },
    }
    await storage.contracts.saveContract(contract)
    const saveContract = vi.spyOn(storage.contracts, 'saveContract'),
      saveSwap = vi.spyOn(storage.swaps, 'saveRfqSwap')
    await expect(restoreLightningRecoveryJournal(f.journal, f.binding, storage)).rejects.toThrow('Conflicting local')
    expect(saveContract).not.toHaveBeenCalled()
    expect(saveSwap).not.toHaveBeenCalled()
    await storage.contracts.saveContract(f.contract)
    const local = structuredClone(f.record)
    ;((local.profile.vaultLightning as Record<string, unknown>).fundingProof as Record<string, unknown>).operationId =
      'ff'.repeat(16)
    await storage.swaps.saveRfqSwap(local)
    saveSwap.mockClear()
    saveContract.mockClear()
    await expect(restoreLightningRecoveryJournal(f.journal, f.binding, storage)).rejects.toThrow('funding evidence')
    expect(saveContract).not.toHaveBeenCalled()
    expect(saveSwap).not.toHaveBeenCalled()
  })

  it('rejects substituted enrollment, sender, refund destination, variant and graph', () => {
    const f = lightningRecoveryFixture({ nine: true })
    for (const binding of [
      { ...f.binding, network: 'mutinynet' },
      { ...f.binding, vaultId: 'another' },
      { ...f.binding, phonePub: '02' + 'ee'.repeat(32) },
      { ...f.binding, spendingScript: '5120' + 'ee'.repeat(32) },
    ])
      expect(() => validateLightningRecoveryJournal(f.journal, binding)).toThrow()
    for (const mutate of [
      (j: typeof f.journal) => {
        ;(j.entries[0].record.profile.signer as Record<string, unknown>).signingDescriptor = `tr(${'ff'.repeat(32)})`
      },
      (j: typeof f.journal) => {
        delete j.entries[0].contract.params.nonInteractiveRefundWithoutReceiver
      },
      (j: typeof f.journal) => {
        j.entries[0].exit.transactions = {}
      },
      (j: typeof f.journal) => {
        j.entries.push(structuredClone(j.entries[0]))
      },
    ]) {
      const changed = structuredClone(f.journal)
      mutate(changed)
      expect(() => validateLightningRecoveryJournal(changed, f.binding)).toThrow()
    }
  })
  it('keeps quoted and ambiguous funding states when the first output has not appeared', async () => {
    const quoted = lightningRecoveryFixture({ funded: false }),
      storage = await stores(quoted)
    const chain = await chainFixture(quoted)
    chain.getCoins.mockResolvedValue({ vtxos: [] })
    const first = await captureLightningRecoveryJournal({ binding: quoted.binding, ...storage })
    expect(first.entries[0].record.profile.vaultLightning).toMatchObject({ fundingState: 'quoted' })
    const ambiguous = lightningRecoveryFixture()
    await storage.swaps.saveRfqSwap(ambiguous.record)
    const pending = await captureLightningRecoveryJournal({ binding: quoted.binding, ...storage, previous: first })
    expect(pending.entries[0].record.profile.vaultLightning).toMatchObject({ fundingState: 'funding' })
    expect(lightningArchiveProviders(pending.entries[0], quoted.binding).coins).toEqual([])
  })

  it('adds a later resolution without deleting earlier funding proof and makes interrupted restore retryable', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f)
    const later = structuredClone(f.journal)
    const record = later.entries[0].record
    record.updatedAt += 10
    record.state = 'refunded'
    record.refundArkTxid = 'dd'.repeat(32)
    ;(record.profile.vaultLightning as Record<string, unknown>).fundingState = 'quoted'
    delete (record.profile.vaultLightning as Record<string, unknown>).fundingProof
    record.fundingArkTxid = 'ee'.repeat(32)
    expect(await restoreLightningRecoveryJournal(later, f.binding, storage)).toEqual({ restored: 1, retained: 0 })
    expect(await storage.swaps.getRfqSwap(record.rfqId)).toMatchObject({
      state: 'refunded',
      fundingArkTxid: record.fundingArkTxid,
      profile: {
        vaultLightning: {
          fundingState: 'funding',
          fundingProof: (f.record.profile.vaultLightning as Record<string, unknown>).fundingProof,
        },
      },
    })
    const swaps = new InMemoryAssetSwapRepository(),
      contracts = new InMemoryContractRepository()
    vi.spyOn(swaps, 'saveRfqSwap').mockRejectedValueOnce(new Error('storage interrupted'))
    await expect(restoreLightningRecoveryJournal(f.journal, f.binding, { swaps, contracts })).rejects.toThrow(
      'interrupted',
    )
    expect(await contracts.getContracts()).toHaveLength(1)
    expect(await restoreLightningRecoveryJournal(f.journal, f.binding, { swaps, contracts })).toEqual({
      restored: 1,
      retained: 0,
    })
    expect(await restoreLightningRecoveryJournal(f.journal, f.binding, { swaps, contracts })).toEqual({
      restored: 0,
      retained: 1,
    })
  })

  it('rejects a lockup already assigned to another local RFQ, before creating missing records', async () => {
    const f = lightningRecoveryFixture(),
      storage = await stores(f)
    const duplicate = structuredClone(f.record)
    duplicate.rfqId = 'cd'.repeat(32)
    await storage.swaps.saveRfqSwap(duplicate)
    const save = vi.spyOn(storage.swaps, 'saveRfqSwap')
    await expect(restoreLightningRecoveryJournal(f.journal, f.binding, storage)).rejects.toThrow('lockup owner')
    expect(save).not.toHaveBeenCalled()
  })
  it('retains an observed output but never restores it as a new unfunded quote', async () => {
    const f = lightningRecoveryFixture()
    const stale = structuredClone(f.journal)
    const profile = stale.entries[0].record.profile.vaultLightning as Record<string, unknown>
    profile.fundingState = 'quoted'
    delete profile.fundingProof
    expect(validateLightningRecoveryJournal(stale, f.binding)).toBe(stale)
    expect(lightningArchiveProviders(stale.entries[0], f.binding).coins).toHaveLength(1)
    const swaps = new InMemoryAssetSwapRepository(),
      contracts = new InMemoryContractRepository()
    await expect(restoreLightningRecoveryJournal(stale, f.binding, { swaps, contracts })).rejects.toThrow(
      'no funding journal',
    )
    expect(await swaps.getAllRfqSwaps()).toEqual([])
    expect(await contracts.getContracts()).toEqual([])
  })
})
