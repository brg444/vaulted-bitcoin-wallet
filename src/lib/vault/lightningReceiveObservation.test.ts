import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { disposeVaultAccountRuntime, vaultAccountRuntime } from './accountRuntime'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import { observeVaultLightningReceive } from './lightningReceiveObservation'

const mocks = vi.hoisted(() => ({ read: vi.fn(), error: '', subscribers: new Set<() => void>() }))
vi.mock('./vtxo/walletWorker', () => ({
  subscribeVaultWalletEvents: (_status: unknown, listener: () => void) => {
    mocks.subscribers.add(listener)
    return () => mocks.subscribers.delete(listener)
  },
  withVaultWalletState: async (_status: unknown, run: (value: object) => Promise<unknown>) =>
    run({ swapRepository: { getRfqSwap: mocks.read }, lightningReceiveError: mocks.error }),
}))
const status = sharedSpendingStatus()
const update = () => mocks.subscribers.forEach((listener) => listener())
beforeEach(() => {
  vi.useFakeTimers()
  mocks.error = ''
  mocks.read.mockReset().mockResolvedValue({ rfqId: 'invoice', state: 'pending' })
})
afterEach(async () => {
  await disposeVaultAccountRuntime(vaultAccountRuntime(status))
  mocks.subscribers.clear()
  vi.useRealTimers()
})

it('observes the account result with one reconciliation pass for competing invoice views', async () => {
  const account = vaultAccountRuntime(status)
  const reconcile = vi.fn(async () => {
    mocks.read.mockResolvedValue({ rfqId: 'invoice', state: 'settled' })
    update()
  })
  account.maintenance.observe('lightning-observer', reconcile, { intervalMs: 15_000 })
  const first = vi.fn(),
    second = vi.fn()
  const leaveFirst = observeVaultLightningReceive(status, 'invoice', first)
  const leaveSecond = observeVaultLightningReceive(status, 'invoice', second)
  await vi.advanceTimersByTimeAsync(150)
  expect(reconcile).toHaveBeenCalledOnce()
  expect(first).toHaveBeenLastCalledWith({ record: { rfqId: 'invoice', state: 'settled' }, error: '' })
  expect(second).toHaveBeenLastCalledWith({ record: { rfqId: 'invoice', state: 'settled' }, error: '' })
  leaveFirst()
  await vi.advanceTimersByTimeAsync(5000)
  expect(reconcile).toHaveBeenCalledTimes(2)
  leaveSecond()
  await vi.advanceTimersByTimeAsync(5000)
  expect(reconcile).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(reconcile).toHaveBeenCalledTimes(3)
  expect(mocks.subscribers.size).toBe(0)
})

it('retains reconciliation errors until the shared owner reports recovery', async () => {
  mocks.error = 'Claim service unavailable'
  const publish = vi.fn()
  const leave = observeVaultLightningReceive(status, 'invoice', publish)
  await vi.advanceTimersByTimeAsync(0)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'Claim service unavailable' }))
  mocks.error = ''
  update()
  await vi.advanceTimersByTimeAsync(0)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ error: '' }))
  leave()
})

it.each(['unsubscribe', 'account-switch'])('discards a pending record after %s', async (end) => {
  let finish!: (value: object) => void
  mocks.read.mockReturnValue(new Promise((resolve) => (finish = resolve)))
  const publish = vi.fn()
  const leave = observeVaultLightningReceive(status, 'invoice', publish)
  await vi.advanceTimersByTimeAsync(0)
  if (end === 'unsubscribe') leave()
  else vaultAccountRuntime({ ...status, vaultId: 'another-account' })
  finish({ rfqId: 'invoice', state: 'settled' })
  await vi.advanceTimersByTimeAsync(0)
  expect(publish).not.toHaveBeenCalled()
  leave()
})

it('coalesces a burst during a pending local read and publishes the later saved receipt', async () => {
  let finish!: (value: object) => void
  mocks.read.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  const publish = vi.fn()
  const leave = observeVaultLightningReceive(status, 'invoice', publish)
  update()
  update()
  update()
  expect(mocks.read).toHaveBeenCalledOnce()
  mocks.read.mockResolvedValue({ rfqId: 'invoice', state: 'settled' })
  finish({ rfqId: 'invoice', state: 'pending' })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(publish).toHaveBeenLastCalledWith({ record: { rfqId: 'invoice', state: 'settled' }, error: '' })
  leave()
})
