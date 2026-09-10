import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  IndexedDBWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { RecoveryWalletRepository } from './walletRepository'
import { RetainedExitRepository } from './retainedRepository'
import { recoveryFixture } from './testdata/helpers'
import { validateExitArchive } from './exitArchive'
import { loadLifecycleArchive, readRecoveryTransition } from './lifecycleStore'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const queues = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, run: () => Promise<unknown>) => {
        const next = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(run)
        queues.set(name, next)
        return next
      },
    },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  const f = recoveryFixture()
  const { info, coins } = validateExitArchive(f.archive.spending, {
    descriptorHash: f.archive.spending.descriptorHash,
    scriptPubKey: f.coin.script,
    network: f.status.network,
  })
  const coin = {
    ...coins[0],
    status: { confirmed: true },
    virtualStatus: { state: 'settled' },
    isUnrolled: false,
    tapTree: f.spending.encode(),
    forfeitTapLeafScript: f.spending.forfeit(),
    intentTapLeafScript: f.spending.forfeit(),
  } as ExtendedVirtualCoin
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(info)
  vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [coin] })
  const chains = vi.spyOn(RestIndexerProvider.prototype, 'getVtxoChain').mockImplementation(async (outpoint) => ({
    chain: f.archive.spending.branches[`${outpoint.txid}:${outpoint.vout}`],
  }))
  const txs = vi
    .spyOn(RestIndexerProvider.prototype, 'getVirtualTxs')
    .mockResolvedValue({ txs: Object.values(f.archive.spending.transactions) })
  const paths = new RetainedExitRepository('test-paths')
  const wallet = new RecoveryWalletRepository('test-wallet')
  wallet.configureRecovery(f.status.network, paths)
  const binding = {
    descriptorHash: f.archive.spending.descriptorHash,
    scriptPubKey: coin.script,
    network: f.status.network,
  }
  return { ...f, coin, wallet, paths, binding, chains, txs }
}

it('persists complete paths before balance publication and exports them with Operator access denied', async () => {
  const f = fixture()
  const save = IndexedDBWalletRepository.prototype.saveVtxos
  vi.spyOn(IndexedDBWalletRepository.prototype, 'saveVtxos').mockImplementation(async function (
    this: IndexedDBWalletRepository,
    address,
    coins,
  ) {
    const staged = await readRecoveryTransition('test-wallet', f.coin.script)
    expect(staged?.pending).toBe(true)
    expect(staged?.prepared?.transactions).toEqual(f.archive.spending.transactions)
    return save.call(this, address, coins)
  })
  await f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Operator unavailable'))
  const archive = await loadLifecycleArchive('test-wallet', f.binding)
  expect(archive?.transactions).toEqual(f.archive.spending.transactions)
  expect((await readRecoveryTransition('test-wallet', f.coin.script))?.pending).toBe(false)
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})

it('keeps a receipt visible and pending evidence durable when capture fails, then repairs without a payment', async () => {
  const f = fixture()
  f.chains.mockRejectedValueOnce(new Error('offline'))
  await f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])
  expect((await f.wallet.getVtxosForScript(f.coin.script))[0].txid).toBe(f.coin.txid)
  expect((await readRecoveryTransition('test-wallet', f.coin.script))?.pending).toBe(true)
  await expect(loadLifecycleArchive('test-wallet', f.binding)).rejects.toThrow('syncing')
  const save = vi.spyOn(IndexedDBWalletRepository.prototype, 'saveVtxos')
  const restarted = new RecoveryWalletRepository('test-wallet')
  restarted.configureRecovery(f.status.network, f.paths)
  restarted.watchRecoveryScripts([f.coin.script])
  await restarted.repairRecovery()
  expect(save).not.toHaveBeenCalled()
  expect((await loadLifecycleArchive('test-wallet', f.binding))?.coins).toBeTruthy()
  await restarted[Symbol.asyncDispose]()
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})

it('stops publication if the pending marker cannot be saved', async () => {
  const f = fixture()
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (String(key).startsWith('lifecycle:')) throw new DOMException('Full', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  await expect(f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])).rejects.toThrow('Full')
  expect(await f.wallet.getVtxosForScript(f.coin.script)).toEqual([])
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})

it('bounds an unavailable ancestry request while publishing the observed balance as recovery pending', async () => {
  const f = fixture()
  f.chains.mockImplementation(() => new Promise(() => {}))
  await f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])
  expect((await f.wallet.getVtxosForScript(f.coin.script))[0].txid).toBe(f.coin.txid)
  expect((await readRecoveryTransition('test-wallet', f.coin.script))?.pending).toBe(true)
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})

it('keeps prepared ancestry through a failed balance write and retries it without Operator access', async () => {
  const f = fixture()
  vi.spyOn(IndexedDBWalletRepository.prototype, 'saveVtxos').mockRejectedValueOnce(new Error('balance commit failed'))
  await expect(f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])).rejects.toThrow('balance commit failed')
  await expect(loadLifecycleArchive('test-wallet', f.binding)).rejects.toThrow('catching up')
  f.chains.mockRejectedValue(new Error('Operator unavailable'))
  f.txs.mockRejectedValue(new Error('Operator unavailable'))
  const restarted = new RecoveryWalletRepository('test-wallet')
  restarted.configureRecovery(f.status.network, f.paths)
  await restarted.saveVtxos(f.status.spendingArkAddress!, [f.coin])
  expect((await loadLifecycleArchive('test-wallet', f.binding))?.transactions).toEqual(f.archive.spending.transactions)
  await restarted[Symbol.asyncDispose]()
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})

it('recovers a prepared graph after a crash between balance commit and acknowledgement', async () => {
  const f = fixture()
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (String(key).startsWith('lifecycle:') && value.pending === false)
      throw new DOMException('Full', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  await expect(f.wallet.saveVtxos(f.status.spendingArkAddress!, [f.coin])).resolves.toBeUndefined()
  expect((await readRecoveryTransition('test-wallet', f.coin.script))?.pending).toBe(true)
  spy.mockRestore()
  await expect(loadLifecycleArchive('test-wallet', f.binding)).resolves.toMatchObject({ coins: expect.any(String) })
  expect((await readRecoveryTransition('test-wallet', f.coin.script))?.pending).toBe(false)
  await f.wallet[Symbol.asyncDispose]()
  await f.paths[Symbol.asyncDispose]()
})
