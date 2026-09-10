import { vaultExitRepository } from './vtxo/exitRepository'
import { importLightningAddressReceipts, validateLightningAddress, LNURL_ORIGIN } from './lnurl'
import 'fake-indexeddb/auto'
import { p2tr } from '@scure/btc-signer'
import { scalarSecret, compressedFromScalar } from './program/fixtures'
import { prepareLightningRecovery, validateLightningRecoveryPackage } from './recovery/lightningRecovery'
import {
  ArkAddress,
  ChainTxType,
  createExitChainResolver,
  Transaction,
  VHTLC,
  getNetwork,
  InMemoryContractRepository,
  type OnchainProvider,
  type IndexerProvider,
} from '@arkade-os/sdk'
import {
  InMemoryAssetSwapRepository,
  IndexedDbAssetSwapRepository,
  receiveVtxoScript,
  unilateralClaimDelay,
  type RfqQuote,
  type RfqTransport,
} from '@arkade-os/swap'
import { bech32, hex, base64 } from '@scure/base'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { memoryContracts, refundAddress, emptyIndexer } from './lightningTestUtils'
import {
  BITCOIN_LIGHTNING_SOLVER,
  discoverVaultLightningSolver,
  vaultLightningFundingForInvoice,
  vaultLightningReceivePlan,
  vaultLightningReceiveEnabled,
} from './lightningConfig'
import { requestVaultLightningReceive, receiveProfile, validateReceiveRecord } from './lightningReceive'
import {
  createVaultLightningObserver,
  refreshVaultLightningObserver,
  listVaultLightningActivityRecords,
} from './lightningLifecycle'
import { reconcileVaultLightningReceives } from './lightningReceiveClaim'
import { networkPins } from './networkPins'
import type { VaultStatus } from './types'
import {
  lightningExitBinding,
  validateLightningRecoveryJournal,
  restoreLightningRecoveryJournal,
} from './recovery/lightningArchive'
import { packExitArchive } from './recovery/exitArchive'
import { lightningRecoveryFixture } from './recovery/testdata/lightningFixtures'

const NOW = 1_788_880_000
const pins = networkPins('mainnet')
// Decoder fixture only. Funded qualification uses invoices signed by a solver.
function invoice(hash: string, sats: number, prefix = 'bc') {
  const words = Array.from({ length: 7 }, (_, i) => Math.floor(NOW / 32 ** (6 - i)) % 32)
  words.push(1, 1, 20, ...bech32.toWords(hex.decode(hash)), ...Array(104).fill(0))
  return bech32.encode(`ln${prefix}${sats * 10000}p`, words, 2000)
}
async function harness(
  nine = true,
  mutate: (q: RfqQuote) => void = () => {},
  tier?: 'standard' | 'advanced' | 'light',
) {
  const enrolled = tier
    ? lightningRecoveryFixture({ advanced: tier === 'advanced', light: tier === 'light', funded: false }).binding
    : undefined
  const payout = new ArkAddress(
    hex.decode(pins.operatorSignerPub).slice(1),
    enrolled ? hex.decode(enrolled.spendingScript).slice(2) : ArkAddress.decode(await refundAddress()).vtxoTaprootKey,
    'ark',
  ).encode()
  const status = {
    enrolled: true,
    vaultId: 'aa'.repeat(32),
    network: 'mainnet',
    phoneBip340Pub: enrolled?.phonePub ?? '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    spendingArkAddress: payout,
    spendingArkScript: hex.encode(ArkAddress.decode(payout).pkScript),
    arkadeCosignerOrigin: 'urn:vaulted:mainnet-signer:v1',
  } as VaultStatus
  const { contracts, rows, createContract } = memoryContracts()
  const repository = new InMemoryAssetSwapRepository()
  const transport = {
    requestQuote: vi.fn(async (request) => {
      const p = request.profile
      const quote: RfqQuote = {
        v: 1,
        type: 'rfq_quote',
        rfq_id: request.rfq_id,
        pair: request.pair,
        amount_side: 'to',
        from_amount: 1004,
        to_amount: 1000,
        solver_pubkey: compressedFromScalar(5).slice(2),
        valid_until: NOW + 300,
        refund_locktime: NOW + 3600,
        profile: { invoice: invoice(p.payment_hash, 1004), solver_refund_pk_script: status.spendingArkScript },
      }
      const eight = receiveVtxoScript({
        solverPubkey: hex.decode(quote.solver_pubkey),
        refundLocktime: quote.refund_locktime!,
        serverPubkey: hex.decode(pins.operatorSignerPub).slice(1),
        paymentHash: p.payment_hash,
        claimDelay: unilateralClaimDelay(605184),
        emulatorPubkey: hex.decode(pins.emulatorSignerPub).slice(1),
        solverRefundPkScript: hex.decode(status.spendingArkScript!),
        payoutPubkey: hex.decode(p.payout_pubkey),
        payoutPkScript: ArkAddress.decode(p.payout_address).pkScript,
      })
      const script = nine
        ? new VHTLC.ScriptV2({
            ...eight.options,
            nonInteractiveRefund: { ...eight.options.nonInteractiveRefund!, withoutReceiver: true },
          })
        : eight
      quote.profile!.lockup_address = script.address('ark', hex.decode(pins.operatorSignerPub).slice(1)).encode()
      mutate(quote)
      return quote
    }),
    close: vi.fn(),
  } as unknown as RfqTransport
  const request = () =>
    requestVaultLightningReceive({
      status,
      amountSats: 1000,
      profile: BITCOIN_LIGHTNING_SOLVER,
      transport,
      repository,
      contracts,
      operatorInfo: { network: 'bitcoin', signerPubkey: pins.operatorSignerPub, unilateralExitDelay: 605184 },
      now: NOW,
    })
  return { status, repository, contracts, rows, createContract, transport, request }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Lightning receive', () => {
  it('keeps incoming records outside the send observer after the claim window', async () => {
    const h = await harness()
    const r = await h.request()
    const manager = createVaultLightningObserver({
      repository: h.repository,
      contracts: h.contracts,
      indexer: emptyIndexer(),
      managerConfig: { now: () => NOW + 86400 },
    })
    const result = await refreshVaultLightningObserver(manager)
    expect(result.restored).toEqual([])
    expect(result.pruned).toEqual([])
    expect(await h.repository.getRfqSwap(r.rfqId)).toEqual(r)
    manager.stop()
  })
  it('enables a qualification build only for its selected enrolled wallet', () => {
    expect(vaultLightningReceiveEnabled('mainnet', 'aa', 'true', 'aa')).toBe(true)
    expect(vaultLightningReceiveEnabled('mainnet', 'bb', 'true', 'aa')).toBe(false)
    expect(vaultLightningReceiveEnabled('mainnet', undefined, 'true', 'aa')).toBe(false)
    expect(vaultLightningReceiveEnabled('mainnet', 'aa', 'false', 'aa')).toBe(false)
    expect(vaultLightningReceiveEnabled('mainnet', 'aa', 'true', '')).toBe(false)
    expect(vaultLightningReceiveEnabled('regtest', 'aa', 'true', 'aa')).toBe(false)
  })
  it('verifies the new signed card and prices the two directions independently', async () => {
    const profile = (await discoverVaultLightningSolver('mainnet'))!
    expect(profile).toBeDefined()
    expect(vaultLightningReceivePlan(500, profile)).toEqual({ receiveSats: 500, maxPaySats: 502 })
    expect(vaultLightningReceivePlan(50000, profile).maxPaySats).toBe(50151)
    expect(vaultLightningFundingForInvoice(50000, profile)).toBe(50151)
    for (const n of [0, 499, 50001, NaN, 1.5]) expect(() => vaultLightningReceivePlan(n, profile)).toThrow()
  })
  it.each(
    [false, true].flatMap((nine) => (['standard', 'advanced', 'light'] as const).map((tier) => ({ nine, tier }))),
  )('persists a reconstructible $tier receive (nine=$nine)', async ({ nine, tier }) => {
    const h = await harness(nine, undefined, tier)
    const r = await h.request()
    const p = receiveProfile(r)
    const contract = [...h.rows.values()][0]
    const binding = {
      vaultId: h.status.vaultId,
      network: 'mainnet',
      phonePub: h.status.phoneBip340Pub!,
      spendingScript: h.status.spendingArkScript!,
      descriptorHash: 'ee'.repeat(32),
    }
    const script = validateReceiveRecord(r, contract, binding)
    expect(script.options.nonInteractiveRefund?.withoutReceiver).toBe(nine ? true : undefined)
    expect(hex.encode(script.options.nonInteractiveClaim!.receiverPkScript)).toBe(binding.spendingScript)
    expect(p.invoiceExpiresAt).toBe(NOW + 300)
    expect(await h.repository.getRfqSwap(r.rfqId)).toEqual(r)
    const exitBinding = lightningExitBinding({ record: r, contract }, binding)
    const journal = {
      name: 'vaulted-lightning-recovery' as const,
      version: 1 as const,
      binding,
      entries: [
        {
          record: r,
          contract,
          exit: {
            ...lightningRecoveryFixture({ funded: false }).entry.exit,
            descriptorHash: exitBinding.descriptorHash,
            coins: packExitArchive([]),
          },
        },
      ],
    }
    expect(validateLightningRecoveryJournal(journal, binding)).toEqual(journal)
    const tampered = structuredClone(r)
    ;(tampered.profile.hashlock as { preimageHex: string }).preimageHex = 'ff'.repeat(32)
    expect(() => validateReceiveRecord(tampered, contract, binding)).toThrow(/recovery material/)
  })
  it.each([
    [
      'amount',
      (q: RfqQuote) => {
        q.to_amount = 999
      },
    ],
    [
      'id',
      (q: RfqQuote) => {
        q.rfq_id = 'ff'.repeat(32)
      },
    ],
    [
      'pair',
      (q: RfqQuote) => {
        q.pair = 'arkade:BTC->lightning:BTC'
      },
    ],
    [
      'address',
      (q: RfqQuote) => {
        q.profile!.lockup_address = 'ark1invalid'
      },
    ],
    [
      'hash',
      (q: RfqQuote) => {
        q.profile!.invoice = invoice('ff'.repeat(32), 1004)
      },
    ],
    [
      'network',
      (q: RfqQuote) => {
        q.profile!.invoice = invoice('ff'.repeat(32), 1004, 'tbs')
      },
    ],
    [
      'expiry',
      (q: RfqQuote) => {
        q.valid_until = NOW
      },
    ],
    [
      'claim window',
      (q: RfqQuote) => {
        q.valid_until = q.refund_locktime! - 1
      },
    ],
  ])('does not register or return an invoice after a bad %s', async (_, mutate) => {
    const h = await harness(true, mutate as (q: RfqQuote) => void)
    await expect(h.request()).rejects.toThrow()
    expect(h.createContract).not.toHaveBeenCalled()
    expect(await h.repository.getAllRfqSwaps()).toEqual([])
  })
  it('withholds the invoice when storage fails or readback loses its secret', async () => {
    const h = await harness()
    vi.spyOn(h.repository, 'saveRfqSwap').mockRejectedValue(new Error('disk full'))
    await expect(h.request()).rejects.toThrow('disk full')
    const b = await harness()
    vi.spyOn(b.repository, 'getRfqSwap').mockResolvedValue(undefined)
    await expect(b.request()).rejects.toThrow('durably stored')
  })

  it('gates preimage disclosure on actual funding, persists before submit and confirms via payout after a lost response', async () => {
    const h = await harness()
    const r = await h.request()
    const contract = [...h.rows.values()][0]
    const parent = new Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true })
    parent.addInput({ txid: '11'.repeat(32), index: 0 })
    parent.addOutput({ amount: 1000n, script: hex.decode(contract.script) })
    const coin = {
      txid: parent.id,
      vout: 0,
      value: 1000,
      script: contract.script,
      createdAt: new Date(),
      isPreconfirmed: true,
      isUnrolled: false,
      virtualStatus: 'preconfirmed',
    }
    let funding = [coin],
      payout: typeof funding = []
    const indexer = {
      getVtxos: vi.fn(async (q) => ({ vtxos: q.scripts[0] === contract.script ? funding : payout })),
      getVirtualTxs: vi.fn(async () => ({ txs: [base64.encode(parent.toPSBT())] })),
    }
    const operator = {
      getInfo: vi.fn(async () => ({
        network: 'bitcoin',
        signerPubkey: pins.operatorSignerPub,
        checkpointTapscript: pins.checkpointTapscript,
      })),
    }
    const emulator = {
      getInfo: vi.fn(async () => ({ signerPubkey: pins.emulatorSignerPub })),
      submitTx: vi.fn(async () => {
        const saved = receiveProfile((await h.repository.getRfqSwap(r.rfqId))!)
        expect(saved.claim?.txid).toMatch(/^[0-9a-f]{64}$/)
        throw new Error('response lost')
      }),
    }
    const run = () =>
      reconcileVaultLightningReceives({
        status: h.status,
        repository: h.repository,
        contracts: h.contracts as never,
        indexer: indexer as never,
        operator: operator as never,
        emulator: emulator as never,
      })
    funding = [{ ...coin, value: 999 }]
    await run()
    expect(emulator.submitTx).not.toHaveBeenCalled()
    funding = [coin]
    await expect(run()).rejects.toThrow('response lost')
    const saved = (await h.repository.getRfqSwap(r.rfqId))!
    const claim = receiveProfile(saved).claim!
    expect(saved.state).toBe('pending')
    const tx = Transaction.fromPSBT(base64.decode(claim.arkTx))
    expect(tx.getOutput(0).amount).toBe(1000n)
    expect(hex.encode(tx.getOutput(0).script!)).toBe(h.status.spendingArkScript)
    const forged = structuredClone(saved)
    receiveProfile(forged).claim!.txid = 'cc'.repeat(32)
    await h.repository.saveRfqSwap(forged)
    payout = [{ ...coin, txid: 'cc'.repeat(32), script: h.status.spendingArkScript! }]
    await expect(run()).rejects.toThrow('Saved Lightning claim')
    expect((await h.repository.getRfqSwap(r.rfqId))!.state).toBe('pending')
    await h.repository.saveRfqSwap(saved)
    payout = []
    funding = []
    await run()
    expect((await h.repository.getRfqSwap(r.rfqId))!.state).toBe('pending')
    payout = [{ ...coin, txid: claim.txid, script: h.status.spendingArkScript! }]
    await run()
    expect((await h.repository.getRfqSwap(r.rfqId))!.state).toBe('settled')
    expect(emulator.submitTx).toHaveBeenCalledOnce()
    await expect(listVaultLightningActivityRecords(h.repository)).resolves.toEqual([
      expect.objectContaining({
        rfqId: r.rfqId,
        fundingTxid: claim.txid,
        type: 'received',
        state: 'settled',
        amount: 1000,
        terminal: true,
      }),
    ])
  })
})

it.each(['light', 'standard', 'advanced'] as const)(
  'restores both funded incoming layouts for %s and prepares offline recovery',
  async (tier) => {
    for (const nine of [false, true]) {
      const h = await harness(nine, () => {}, tier)
      const record = await h.request()
      const contract = [...h.rows.values()][0]
      const base = lightningRecoveryFixture({ light: tier === 'light', advanced: tier === 'advanced' })
      const binding = {
        ...base.binding,
        vaultId: h.status.vaultId,
        phonePub: h.status.phoneBip340Pub!,
        spendingScript: h.status.spendingArkScript!,
      }
      const tx = new Transaction({ version: 3 })
      tx.addInput({ ...base.tx.getInput(0), tapKeySig: undefined })
      tx.addOutput({ amount: 1000n, script: hex.decode(contract.script) })
      tx.addOutput({ amount: 0n, script: hex.decode('51024e73') })
      tx.sign(scalarSecret(21))
      const exitBinding = lightningExitBinding({ record, contract }, binding)
      const entry = {
        record,
        contract,
        exit: {
          ...base.entry.exit,
          descriptorHash: exitBinding.descriptorHash,
          coins: packExitArchive([{ ...base.coin, txid: tx.id, script: contract.script, value: 1000 }]),
          branches: {
            [tx.id + ':0']: base.entry.exit.branches[base.tx.id + ':0'].map((node) => ({
              ...node,
              txid: node.txid === base.tx.id ? tx.id : node.txid,
            })),
          },
          transactions: { [tx.id]: base64.encode(tx.toPSBT()) },
        },
      }
      const journal = validateLightningRecoveryJournal(
        { name: 'vaulted-lightning-recovery', version: 1, binding, entries: [entry] },
        binding,
      )
      vi.stubGlobal('navigator', {
        locks: { request: async (_name: unknown, _options: unknown, run: (lock: object) => unknown) => run({}) },
      })
      vi.useRealTimers()
      // Reopen a new SDK repository handle, then restore into a second empty database.
      const dbName = `receive-restore-${tier}-${nine}-${crypto.randomUUID()}`
      let swaps = new IndexedDbAssetSwapRepository(dbName)
      const contracts = new InMemoryContractRepository()
      await restoreLightningRecoveryJournal(JSON.parse(JSON.stringify(journal)), binding, { swaps, contracts })
      await swaps[Symbol.asyncDispose]()
      swaps = new IndexedDbAssetSwapRepository(dbName)
      expect(await swaps.getRfqSwap(record.rfqId)).toEqual(record)
      expect(await contracts.getContracts({ script: contract.script })).toHaveLength(1)
      expect(await restoreLightningRecoveryJournal(journal, binding, { swaps, contracts })).toEqual({
        restored: 0,
        retained: 1,
      })
      const restored = JSON.parse(JSON.stringify(journal))
      const fresh = new IndexedDbAssetSwapRepository(dbName + '-fresh')
      await restoreLightningRecoveryJournal(restored, binding, {
        swaps: fresh,
        contracts: new InMemoryContractRepository(),
      })
      expect(await fresh.getRfqSwap(record.rfqId)).toEqual(record)
      await Promise.all([swaps[Symbol.asyncDispose](), fresh[Symbol.asyncDispose]()])
      const chain = {
        getCoins: async () => [],
        getFeeRate: async () => 1,
        getTxStatus: async () => ({ confirmed: true, blockTime: 1, blockHeight: 1 }),
        getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: '01'.repeat(32) }),
        getTxOutspends: async () => [{ spent: false }],
        getTransactions: async () => [],
        watchAddresses: async () => () => {},
        broadcastTransaction: vi.fn(async () => {
          throw new Error('no broadcasting')
        }),
      } satisfies OnchainProvider
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
      const limits = { absoluteFeeCapSats: 5000, feerateCapSatVb: 10 }
      const destination = p2tr(hex.decode(compressedFromScalar(23)).slice(1), undefined, getNetwork('bitcoin')).address!
      const file = await prepareLightningRecovery(
        restored.entries[0],
        binding,
        destination,
        async ({ psbt }) => {
          const tx = Transaction.fromPSBT(hex.decode(psbt))
          tx.sign(scalarSecret(tier === 'light' ? 1 : 3))
          return hex.encode(tx.toPSBT())
        },
        limits,
        chain,
      )
      expect(validateLightningRecoveryPackage(file, binding, limits)).toEqual(file)
      expect(file.exitPackage.steps.map((step) => step.kind)).toEqual(['bump', 'sweep'])
      expect(fetch).not.toHaveBeenCalled()
      expect(chain.broadcastTransaction).not.toHaveBeenCalled()
      fetch.mockRestore()
    }
  },
  60000,
)

it('persists the exact invoice total alongside the lower card estimate', async () => {
  const h = await harness(true, (q) => {
    q.from_amount = 1006
  })
  // Use the original decoded invoice hash so this models an actual wrapped invoice.
  const original = h.transport.requestQuote.bind(h.transport)
  h.transport.requestQuote = async (request) => {
    const q = await original(request)
    q.profile!.invoice = invoice((request.profile as { payment_hash: string }).payment_hash, 1006)
    return q
  }
  const r = await h.request()
  expect(receiveProfile(r).estimatedPaySats).toBe(1004)
  expect(receiveProfile(r).quote.from_amount).toBe(1006)
  expect(receiveProfile((await h.repository.getRfqSwap(r.rfqId))!).quote.from_amount).toBe(1006)
})

describe('Lightning address receipt import', () => {
  it.each(['light', 'standard', 'advanced'] as const)(
    'imports %s receipts into the existing recovery journal without trusting remote settlement',
    async (tier) => {
      const h = await harness(true, () => {}, tier)
      const r = await h.request()
      vi.useRealTimers()
      const p = receiveProfile(r)
      const id = 'v' + '12'.repeat(8)
      const address = {
        id,
        address: `${id}@ln.getvaulted.xyz`,
        active: true,
        readToken: 'ab'.repeat(32),
        maxFeeSats: 25,
        lnurl: bech32
          .encode('lnurl', bech32.toWords(new TextEncoder().encode(`${LNURL_ORIGIN}/.well-known/lnurlp/${id}`)), 1023)
          .toUpperCase(),
        binding: {
          vaultId: h.status.vaultId,
          network: h.status.network,
          templateVersion: h.status.templateVersion,
          protectionTier: h.status.protectionTier,
          policyVersion: h.status.policyVersion,
          descriptorHash: 'cd'.repeat(32),
          spendingPolicyDigest: h.status.spendingPolicyDigest,
          spendingAddress: h.status.spendingArkAddress,
          spendingScript: h.status.spendingArkScript,
          claimPublicKey: h.status.phoneBip340Pub,
        },
      }
      const store = new Map<string, string>()
      store.set(`vaulted:lnurl:v1:mainnet:${h.status.vaultId}`, JSON.stringify(address))
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value)
        },
      })
      const target = new InMemoryAssetSwapRepository()
      const receipts = [
        {
          sequence: 1,
          swapId: r.rfqId,
          invoice: p.invoice,
          preimage: (r.profile.hashlock as { preimageHex: string }).preimageHex,
          preimageHash: (r.profile.hashlock as { paymentHash: string }).paymentHash,
          lockupAddress: r.lockupAddress,
          recovery: { quote: p.quote, claimDelay: unilateralClaimDelay(605184), invoiceExpiresAt: p.invoiceExpiresAt },
          settled: true,
        },
      ]
      const recoveryBase = lightningRecoveryFixture({ advanced: tier === 'advanced', light: tier === 'light' })
      const funding = new Transaction({ version: 3 })
      const parent = p2tr(hex.decode(compressedFromScalar(21)).slice(1))
      funding.addInput({
        txid: '01'.repeat(32),
        index: 0,
        witnessUtxo: { script: parent.script, amount: 1000n },
        tapInternalKey: parent.tapInternalKey,
      })
      funding.addOutput({ amount: 1000n, script: ArkAddress.decode(r.lockupAddress).pkScript })
      funding.sign(scalarSecret(21))
      const coin = {
        txid: funding.id,
        vout: 0,
        value: 1000,
        script: hex.encode(ArkAddress.decode(r.lockupAddress).pkScript),
        isSpent: true,
        spentBy: 'historical-claim',
        createdAt: new Date().toISOString(),
      }
      const graph = {
        info: recoveryBase.entry.exit!.info,
        coin: packExitArchive(coin),
        chain: [
          { txid: '01'.repeat(32), type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
          { txid: funding.id, type: ChainTxType.TREE, spends: ['01'.repeat(32)], expiresAt: '1789000000' },
        ],
        transactions: { [funding.id]: base64.encode(funding.toPSBT()) },
      }
      Object.assign(receipts[0], { graphs: { funding: true } })
      const fetcher = vi.fn(
        async (url: string) => new Response(JSON.stringify(url.includes('/recovery/') ? graph : { receipts })),
      )
      vi.stubGlobal('fetch', fetcher)
      const input = {
        status: h.status,
        repository: target,
        contracts: h.contracts as unknown as import('@arkade-os/sdk').IContractManager,
      }
      await importLightningAddressReceipts(input)
      const saved = await target.getRfqSwap(r.rfqId)
      expect(saved?.state).toBe('pending')
      expect(saved?.profile.hashlock).toEqual(r.profile.hashlock)
      expect(saved?.profile['lnurlGraph:funding']).toEqual({ txid: funding.id, vout: 0 })
      const cache = vaultExitRepository(h.status.vaultId, 'mainnet')
      try {
        const resolver = createExitChainResolver({
          repository: cache,
          indexer: emptyIndexer() as unknown as IndexerProvider,
        })
        expect(await resolver.getVirtualTxs([funding.id])).toEqual([graph.transactions[funding.id]])
        await cache.clear()
      } finally {
        await cache[Symbol.asyncDispose]()
      }
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining(LNURL_ORIGIN),
        expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
      )
      await importLightningAddressReceipts(input)
      expect(await target.getAllRfqSwaps()).toHaveLength(1)
      expect(fetcher.mock.calls.filter(([url]) => url.includes('/recovery/'))).toHaveLength(2)
      receipts[0].preimage = '00'.repeat(32)
      await expect(importLightningAddressReceipts(input)).rejects.toThrow('Invalid Lightning address recovery record')
      expect((await target.getAllRfqSwaps())[0].profile.hashlock).toEqual(r.profile.hashlock)
      const custom = {
        ...address,
        name: 'alex',
        address: 'alex@ln.getvaulted.xyz',
        lnurl: bech32
          .encode('lnurl', bech32.toWords(new TextEncoder().encode(`${LNURL_ORIGIN}/.well-known/lnurlp/alex`)), 1023)
          .toUpperCase(),
      }
      expect(validateLightningAddress(custom as never, h.status).id).toBe(address.id)
      expect(() => validateLightningAddress({ ...custom, name: 'someone-else' } as never, h.status)).toThrow()
      expect(() => validateLightningAddress({ ...custom, name: '../alex' } as never, h.status)).toThrow()
      expect(() => validateLightningAddress({ ...address, lnurl: 'LNURL1WRONG' } as never, h.status)).toThrow(
        'does not match',
      )
    },
  )
})
