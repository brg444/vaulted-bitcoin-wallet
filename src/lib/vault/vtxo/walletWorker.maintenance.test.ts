import 'fake-indexeddb/auto'
import { ServiceWorkerWallet } from '@arkade-os/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getLogs } from '../../logs'
import { sharedSpendingStatus } from './testdata/sharedSpending'
import {
  ensureVaultWalletWorker,
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
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

it('initializes and refreshes Spending while Lightning address receipts are stalled, then drains before teardown', async () => {
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
