import 'fake-indexeddb/auto'
import { ServiceWorkerWallet } from '@arkade-os/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getLogs } from '../../logs'
import { sharedSpendingStatus } from './testdata/sharedSpending'
import { vaultAccountRuntime } from '../accountRuntime'
import {
  ensureVaultWalletWorker,
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
  reviveVaultWalletWorker,
  shutdownVaultWalletWorker,
} from './walletWorker'

const mocks = vi.hoisted(() => ({
  receipts: vi.fn(),
  receives: vi.fn(),
  maintenance: vi.fn(),
  stop: vi.fn(),
}))
vi.mock('../lnurl', () => ({ importLightningAddressReceipts: mocks.receipts }))
vi.mock('../lightningReceiveClaim', () => ({ reconcileVaultLightningReceives: mocks.receives }))
vi.mock('../lightningLifecycle', async (original) => ({
  ...(await original<typeof import('../lightningLifecycle')>()),
  createVaultLightningObserver: () => ({
    onSwapUpdate: () => () => {},
    onSwapCompleted: () => () => {},
    onSwapFailed: () => () => {},
    stop: mocks.stop,
  }),
  maintainVaultLightningObserver: mocks.maintenance,
}))

const status = sharedSpendingStatus()
let finishReceipts: (error?: Error) => void

beforeEach(() => {
  localStorage.clear()
  const worker = { state: 'activated' }
  const registration = { active: worker, update: vi.fn(), unregister: vi.fn() }
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    locks: { request: vi.fn(async (_name, _options, run) => run({})) },
  })
  mocks.receipts.mockImplementation(
    () => new Promise<void>((resolve, reject) => (finishReceipts = (error) => (error ? reject(error) : resolve()))),
  )
  mocks.receives.mockResolvedValue(undefined)
  mocks.maintenance.mockResolvedValue({ restoreFailures: [], retirementFailures: [] })
  mocks.stop.mockResolvedValue(undefined)
})

afterEach(async () => {
  finishReceipts?.()
  await shutdownVaultWalletWorker(status.vaultId)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockWallet() {
  const contracts = {
    getContracts: vi.fn().mockResolvedValue([{ script: status.spendingArkScript, state: 'active', watch: 'watched' }]),
    getContractsWithVtxos: vi.fn().mockResolvedValue([{ vtxos: [{ txid: '12'.repeat(32), vout: 0, value: 12_000 }] }]),
    onContractEvent: vi.fn(() => () => {}),
  }
  const wallet = {
    getBoardingAddress: vi.fn().mockResolvedValue(status.vtxoBoardingAddress),
    getContractManager: vi.fn().mockResolvedValue(contracts),
    activity: { use: vi.fn() },
    getActivityHistory: vi.fn().mockResolvedValue([]),
    getBoardingUtxos: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ boarding: { confirmed: 0, total: 0 } }),
    reload: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
  return wallet
}

it('initializes and refreshes Spending while Lightning address receipts are stalled, then drains before teardown', async () => {
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(wallet as never)
  let ready = false
  const starting = ensureVaultWalletWorker(status).then(() => (ready = true))
  await vi.waitFor(() => expect(ready).toBe(true), { timeout: 1000 })
  await starting
  await vi.waitFor(() => expect(mocks.receipts).toHaveBeenCalledOnce())
  expect(mocks.receipts).toHaveBeenCalledOnce()
  expect(mocks.receives).not.toHaveBeenCalled()
  let reloaded = false
  const refreshing = reloadVaultWalletWorker(status).then(() => (reloaded = true))
  await vi.waitFor(() => expect(reloaded).toBe(true), { timeout: 1000 })
  await refreshing
  expect(wallet.reload).toHaveBeenCalledOnce()
  expect((await fetchVaultWalletVtxoSnapshot(status)).balance).toBe(12_000)

  // Disposal must still wait for the observer before closing its MessageBus.
  const disposed = shutdownVaultWalletWorker(status.vaultId)
  expect(wallet.dispose).not.toHaveBeenCalled()
  finishReceipts(new DOMException('Fetch is aborted', 'AbortError'))
  await disposed
  expect(mocks.receives).toHaveBeenCalledOnce()
  expect(mocks.maintenance).toHaveBeenCalledOnce()
  expect(getLogs()).toContainEqual(
    expect.objectContaining({ msg: 'Lightning address reconciliation: Fetch is aborted' }),
  )
  expect(wallet.dispose).toHaveBeenCalledOnce()
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(wallet.dispose.mock.invocationCallOrder[0])
})

it('runs account maintenance while SDK initialization is pending', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  let connect!: (value: typeof wallet) => void
  const creation = vi.spyOn(ServiceWorkerWallet, 'create').mockImplementation(
    () =>
      new Promise((resolve) => {
        connect = resolve as never
      }),
  )
  const account = vaultAccountRuntime(status)
  const read = vi.fn(async () => 12_000)
  const savings = account.maintenance.observe('ledger-payment', read, { intervalMs: 20_000 })
  const starting = ensureVaultWalletWorker(status)
  await vi.waitFor(() => expect(creation).toHaveBeenCalledOnce())
  expect(account.connection).toBeUndefined()
  expect(await savings.refresh()).toBe(12_000)
  connect(wallet)
  await starting
  expect(account.connection?.wallet).toBe(wallet)
  await savings.dispose()
})

it('drains account consumers before one shared SDK replacement and preserves their task owners', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const first = mockWallet(),
    second = mockWallet()
  const creation = vi
    .spyOn(ServiceWorkerWallet, 'create')
    .mockResolvedValueOnce(first as never)
    .mockResolvedValueOnce(second as never)
  await ensureVaultWalletWorker(status)
  const account = vaultAccountRuntime(status)
  let finishCapture!: () => void
  const capture = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCapture = resolve
        }),
    )
    .mockResolvedValue(undefined)
  const recovery = account.maintenance.observe('recovery-archive', capture, { intervalMs: 30_000 })
  const flight = recovery.refresh()
  await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
  const replacing = reviveVaultWalletWorker(status)
  const duplicate = reviveVaultWalletWorker(status)
  await Promise.resolve()
  expect(first.dispose).not.toHaveBeenCalled()
  finishCapture()
  await Promise.all([flight, replacing, duplicate])
  expect(creation).toHaveBeenCalledTimes(2)
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(vaultAccountRuntime(status)).toBe(account)
  expect((await ensureVaultWalletWorker(status)).wallet).toBe(second)
  await recovery.refresh()
  expect(capture).toHaveBeenCalledTimes(2)
  await recovery.dispose()
})
