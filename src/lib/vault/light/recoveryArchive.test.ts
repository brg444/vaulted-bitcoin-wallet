import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChainTxType,
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  type ArkInfo,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { testDescriptor } from './testdata/helpers'
import { networkPins } from '../networkPins'
import {
  captureLightRecoveryArchive,
  loadLightRecoveryArchive,
  validateLightRecoveryArchive,
  lightArchiveProviders,
  normalizeLightRecoveryChain,
} from './recoveryArchive'

function fixture() {
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: '01'.repeat(32), index: 0 })
  tx.addOutput({ amount: 40000n, script: hex.decode(testDescriptor.scriptPubKey) })
  const pins = networkPins(testDescriptor.network)
  const info = {
    network: pins.operatorGetInfoNetwork,
    signerPubkey: pins.operatorSignerPub,
    checkpointTapscript: pins.checkpointTapscript,
    forfeitPubkey: pins.checkpointForfeitPub,
    unilateralExitDelay: 2048n,
  } as ArkInfo
  const coin = {
    txid: tx.id,
    vout: 0,
    value: 40000,
    script: testDescriptor.scriptPubKey,
    isSpent: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  } as VirtualCoin
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(info)
  const getCoins = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [coin] })
  const getChain = vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockResolvedValue({
    chain: [
      { txid: '01'.repeat(32), type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
      { txid: tx.id, type: ChainTxType.TREE, spends: ['01'.repeat(32)], expiresAt: '1789000000' },
    ],
  })
  const getTransactions = vi
    .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
    .mockResolvedValue({ txs: [base64.encode(tx.toPSBT())] })
  return { coin, tx, getCoins, getTransactions, getChain }
}
afterEach(() => vi.restoreAllMocks())
describe('Light recovery data retention', () => {
  it('deduplicates shared DAG ancestors while rejecting inconsistent repeated facts', () => {
    const node = { txid: '01'.repeat(32), type: ChainTxType.TREE, spends: ['02'.repeat(32)], expiresAt: '0' }
    expect(normalizeLightRecoveryChain([node, node])).toEqual([node])
    expect(normalizeLightRecoveryChain([{ ...node, spends: [`${node.spends[0]}:1`] }])).toEqual([node])
    expect(() => normalizeLightRecoveryChain([{ ...node, spends: [`${node.spends[0]}:4294967296`] }])).toThrow(
      'reference',
    )
    expect(() => normalizeLightRecoveryChain([node, { ...node, expiresAt: '1' }])).toThrow('disagrees')
  })
  it('atomically saves current outputs and serves exit data without any network access', async () => {
    const f = fixture()
    const archive = await captureLightRecoveryArchive(testDescriptor)
    expect(await loadLightRecoveryArchive(testDescriptor)).toEqual(archive)
    const local = lightArchiveProviders(JSON.parse(JSON.stringify(archive)), testDescriptor)
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect((await local.arkProvider.getInfo()).unilateralExitDelay).toBe(2048n)
    expect((await local.indexerProvider.getVtxos({ outpoints: [f.coin] })).vtxos[0].createdAt).toBeInstanceOf(Date)
    expect((await local.source.getVirtualTxs([f.tx.id])).size).toBe(1)
    expect(() =>
      local.arkProvider.registerIntent({
        proof: '',
        message: { type: 'register', valid_at: 0, expire_at: 0, onchain_output_indexes: [], cosigners_public_keys: [] },
      }),
    ).toThrow('cannot supply')
    expect(network).not.toHaveBeenCalled()
  })
  it('keeps the complete previous archive when one transaction is unavailable', async () => {
    const f = fixture()
    const previous = await captureLightRecoveryArchive(testDescriptor)
    const another = f.tx.clone()
    another.updateOutput(0, { amount: 20000n })
    const added = { ...f.coin, txid: another.id, value: 20000 }
    f.getCoins.mockResolvedValue({ vtxos: [f.coin, added] })
    f.getChain.mockResolvedValue({ chain: [{ txid: added.txid, type: ChainTxType.TREE, spends: [], expiresAt: '0' }] })
    f.getTransactions.mockResolvedValue({ txs: [] })
    await expect(captureLightRecoveryArchive(testDescriptor)).rejects.toThrow('incomplete')
    expect(await loadLightRecoveryArchive(testDescriptor)).toEqual(previous)
  })
  it('reuses complete paths and refuses to erase an output the indexer omits', async () => {
    const f = fixture()
    await captureLightRecoveryArchive(testDescriptor)
    f.getChain.mockClear()
    f.getTransactions.mockClear()
    const previous = await captureLightRecoveryArchive(testDescriptor)
    expect(f.getChain).not.toHaveBeenCalled()
    expect(f.getTransactions).not.toHaveBeenCalled()
    f.getCoins.mockResolvedValue({ vtxos: [] })
    await expect(captureLightRecoveryArchive(testDescriptor)).rejects.toThrow('missing')
    expect(await loadLightRecoveryArchive(testDescriptor)).toEqual(previous)
  })
  it('rejects changed amounts, identities and incomplete ancestry', async () => {
    fixture()
    const archive = await captureLightRecoveryArchive(testDescriptor)
    for (const mutate of [
      (a: typeof archive) => {
        a.descriptorHash = 'ff'.repeat(32)
      },
      (a: typeof archive) => {
        const coins = JSON.parse(a.coins)
        coins[0].value++
        a.coins = JSON.stringify(coins)
      },
      (a: typeof archive) => {
        a.transactions = {}
      },
      (a: typeof archive) => {
        a.branches = {}
      },
    ]) {
      const changed = structuredClone(archive)
      mutate(changed)
      expect(() => validateLightRecoveryArchive(changed, testDescriptor)).toThrow()
    }
  })
  it('does not replace recovery data with a mixed snapshot during a payment', async () => {
    const f = fixture()
    const previous = await captureLightRecoveryArchive(testDescriptor)
    f.getCoins.mockResolvedValueOnce({ vtxos: [f.coin] }).mockResolvedValueOnce({ vtxos: [] })
    await expect(captureLightRecoveryArchive(testDescriptor)).rejects.toThrow('balance changed')
    expect(await loadLightRecoveryArchive(testDescriptor)).toEqual(previous)
  })
})
