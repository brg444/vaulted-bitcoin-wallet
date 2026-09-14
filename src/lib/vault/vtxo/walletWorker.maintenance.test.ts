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
  subscribeVaultWalletEvents,
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
  const registration = { active: worker, update: vi.fn(), unregister: vi.fn().mockResolvedValue(true) }
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

it('coalesces concurrent VTXO snapshot reads onto one connection pass', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(wallet as never)
  await ensureVaultWalletWorker(status)
  wallet.getActivityHistory.mockClear()
  wallet.getContractManager.mockClear()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  wallet.getActivityHistory.mockImplementation(async () => {
    await gate
    return []
  })
  const first = fetchVaultWalletVtxoSnapshot(status)
  const second = fetchVaultWalletVtxoSnapshot(status)
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a.balance).toBe(12_000)
  expect(b.balance).toBe(12_000)
  expect(wallet.getActivityHistory).toHaveBeenCalledOnce()
  expect(wallet.getContractManager).toHaveBeenCalledOnce()
})

it('reports verified balance before history enrichment resolves', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(wallet as never)
  await ensureVaultWalletWorker(status)
  wallet.getActivityHistory.mockClear()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  wallet.getActivityHistory.mockImplementation(async () => {
    await gate
    return []
  })
  const verified = vi.fn()
  const snapshot = fetchVaultWalletVtxoSnapshot(status, verified)
  await vi.waitFor(() => expect(verified).toHaveBeenCalledOnce())
  expect(verified).toHaveBeenCalledWith(expect.objectContaining({ balance: 12_000 }))
  expect(wallet.getActivityHistory).toHaveBeenCalledOnce()
  release()
  expect((await snapshot).balance).toBe(12_000)
})

it('delivers verified balance to a callback that joins a pass started without one', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(wallet as never)
  await ensureVaultWalletWorker(status)
  wallet.getActivityHistory.mockClear()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  wallet.getActivityHistory.mockImplementation(async () => {
    await gate
    return []
  })
  const first = fetchVaultWalletVtxoSnapshot(status)
  const verified = vi.fn()
  const second = fetchVaultWalletVtxoSnapshot(status, verified)
  await vi.waitFor(() => expect(verified).toHaveBeenCalledOnce())
  expect(verified).toHaveBeenCalledWith(expect.objectContaining({ balance: 12_000 }))
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a.balance).toBe(12_000)
  expect(b.balance).toBe(12_000)
  expect(wallet.getActivityHistory).toHaveBeenCalledOnce()
})

it('delivers verified balance to a callback that joins after verification', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(wallet as never)
  await ensureVaultWalletWorker(status)
  wallet.getActivityHistory.mockClear()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  wallet.getActivityHistory.mockImplementation(async () => {
    await gate
    return []
  })
  const firstVerified = vi.fn()
  const first = fetchVaultWalletVtxoSnapshot(status, firstVerified)
  await vi.waitFor(() => expect(firstVerified).toHaveBeenCalledOnce())
  // History is still unresolved; a late subscriber gets the verified facts.
  const lateVerified = vi.fn()
  const second = fetchVaultWalletVtxoSnapshot(status, lateVerified)
  await vi.waitFor(() => expect(lateVerified).toHaveBeenCalledOnce())
  expect(lateVerified).toHaveBeenCalledWith(expect.objectContaining({ balance: 12_000 }))
  release()
  await Promise.all([first, second])
  expect(firstVerified).toHaveBeenCalledOnce()
  expect(wallet.getActivityHistory).toHaveBeenCalledOnce()
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

it('stops an orphan registration before retrying a failed SDK initialization', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  const stop = vi.spyOn(ServiceWorkerWallet, 'stop').mockResolvedValue(undefined)
  const creation = vi
    .spyOn(ServiceWorkerWallet, 'create')
    .mockRejectedValueOnce(new Error('Operator unavailable during SDK initialization'))
    .mockResolvedValueOnce(wallet as never)
  await expect(ensureVaultWalletWorker(status)).rejects.toThrow('Operator unavailable')
  const registration = await vi.mocked(navigator.serviceWorker.register).mock.results[0].value
  vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(registration)
  await reviveVaultWalletWorker(status)
  expect(stop).toHaveBeenCalledWith(registration.active, 60_000)
  expect(stop.mock.invocationCallOrder[0]).toBeLessThan(creation.mock.invocationCallOrder[1])
  expect((await ensureVaultWalletWorker(status)).wallet).toBe(wallet)
})

it('drains failed initialization and its orphan worker before a locked account can reopen', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  let rejectCreation!: (error: Error) => void
  let finishStop!: () => void
  const stop = vi
    .spyOn(ServiceWorkerWallet, 'stop')
    .mockImplementation(() => new Promise<void>((resolve) => (finishStop = resolve)))
  const wallet = mockWallet()
  const creation = vi
    .spyOn(ServiceWorkerWallet, 'create')
    .mockImplementationOnce(() => new Promise((_, reject) => (rejectCreation = reject)))
    .mockResolvedValueOnce(wallet as never)
  const starting = ensureVaultWalletWorker(status)
  const failed = expect(starting).rejects.toThrow('Operator unavailable')
  await vi.waitFor(() => expect(creation).toHaveBeenCalledOnce())
  const registration = await vi.mocked(navigator.serviceWorker.register).mock.results[0].value
  vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(registration)
  const closing = shutdownVaultWalletWorker(status.vaultId)
  const reopened = ensureVaultWalletWorker(status)
  rejectCreation(new Error('Operator unavailable during SDK initialization'))
  await failed
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
  expect(creation).toHaveBeenCalledOnce()
  finishStop()
  await closing
  expect((await reopened).wallet).toBe(wallet)
  expect(creation).toHaveBeenCalledTimes(2)
})

it('finishes a late SDK read from draining maintenance before reconnecting after a cold failure', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  vi.spyOn(ServiceWorkerWallet, 'stop').mockResolvedValue(undefined)
  let rejectCreation!: (error: Error) => void
  const creation = vi
    .spyOn(ServiceWorkerWallet, 'create')
    .mockImplementationOnce(() => new Promise((_, reject) => (rejectCreation = reject)))
    .mockResolvedValueOnce(mockWallet() as never)
  const failed = expect(ensureVaultWalletWorker(status)).rejects.toThrow('Operator unavailable')
  await vi.waitFor(() => expect(creation).toHaveBeenCalledOnce())
  const account = vaultAccountRuntime(status)
  let read!: () => void
  let escape!: () => void
  let readFinished = false
  const gate = new Promise<void>((resolve) => (read = resolve))
  const rescue = new Promise<void>((resolve) => (escape = resolve))
  const task = account.maintenance.observe(
    'recovery-archive',
    async () => {
      await gate
      await Promise.race([ensureVaultWalletWorker(status).catch(() => undefined), rescue])
      readFinished = true
    },
    { intervalMs: 30_000 },
  )
  const flight = task.refresh()
  const replacing = reviveVaultWalletWorker(status)
  rejectCreation(new Error('Operator unavailable'))
  await failed
  read()
  try {
    await vi.waitFor(() => expect(readFinished).toBe(true), { timeout: 200 })
  } finally {
    escape()
    await Promise.all([flight, replacing])
    await task.dispose()
  }
  expect(creation).toHaveBeenCalledTimes(2)
})

it('retries a failed cold start while independent recovery capture remains pending', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  const wallet = mockWallet()
  vi.spyOn(ServiceWorkerWallet, 'create')
    .mockRejectedValueOnce(new Error('Operator unavailable'))
    .mockResolvedValueOnce(wallet as never)
  await expect(ensureVaultWalletWorker(status)).rejects.toThrow('Operator unavailable')
  let finishCapture!: () => void
  const capture = vi.fn(() => new Promise<void>((resolve) => (finishCapture = resolve)))
  const task = vaultAccountRuntime(status).maintenance.observe('recovery-archive', capture, { intervalMs: 30_000 })
  const flight = task.refresh()
  await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
  let reconnected = false
  const reconnecting = reviveVaultWalletWorker(status).then(() => (reconnected = true))
  try {
    await vi.waitFor(() => expect(reconnected).toBe(true), { timeout: 200 })
    expect((await ensureVaultWalletWorker(status)).wallet).toBe(wallet)
  } finally {
    finishCapture()
    await Promise.all([flight, reconnecting])
    await task.dispose()
  }
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

it('preserves account subscribers across SDK replacement and clears them on account shutdown', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  vi.spyOn(ServiceWorkerWallet, 'create')
    .mockResolvedValueOnce(mockWallet() as never)
    .mockResolvedValueOnce(mockWallet() as never)
  const changed = vi.fn()
  const unsubscribe = subscribeVaultWalletEvents(status, changed)
  const first = await ensureVaultWalletWorker(status)
  first.notify()
  expect(changed).toHaveBeenCalledOnce()
  const second = await reviveVaultWalletWorker(status)
  changed.mockClear()
  second.notify()
  expect(changed).toHaveBeenCalledOnce()
  unsubscribe()
  second.notify()
  expect(changed).toHaveBeenCalledOnce()
  subscribeVaultWalletEvents(status, changed)
  await shutdownVaultWalletWorker(status.vaultId)
  changed.mockClear()
  second.notify()
  expect(changed).not.toHaveBeenCalled()
})

it('publishes receive reconciliation failure and recovery through the shared connection state', async () => {
  mocks.receipts.mockResolvedValue(undefined)
  mocks.receives.mockRejectedValueOnce(new Error('Claim service unavailable')).mockResolvedValue(undefined)
  vi.spyOn(ServiceWorkerWallet, 'create').mockResolvedValue(mockWallet() as never)
  const current = await ensureVaultWalletWorker(status)
  await current.lightningObserver.refresh()
  expect(current.lightningReceiveError).toBe('Claim service unavailable')
  await current.lightningObserver.refresh()
  expect(current.lightningReceiveError).toBe('')
})
