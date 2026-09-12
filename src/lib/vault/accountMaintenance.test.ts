import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createVaultAccountMaintenance, type VaultAccountMaintenance } from './accountMaintenance'

const owners: VaultAccountMaintenance[] = []
function owner(visible = () => true) {
  const result = createVaultAccountMaintenance('account-a', visible)
  owners.push(result)
  return result
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(owners.splice(0).map((current) => current.dispose()))
  vi.useRealTimers()
})

it('shares the same result across three concurrent requests and permits an independent account task', async () => {
  const scheduler = owner()
  const pending = deferred<number>()
  const run = vi.fn(() => pending.promise)
  const savings = scheduler.observe('ledger-payment', run, { intervalMs: 20_000 })
  const spending = scheduler.observe('bitcoin-payment', async () => 'available', { intervalMs: 15_000 })
  const first = savings.refresh()
  expect(savings.refresh()).toBe(first)
  expect(savings.refresh()).toBe(first)
  expect(await spending.refresh()).toBe('available')
  expect(run).toHaveBeenCalledOnce()
  pending.resolve(42)
  expect(await first).toBe(42)
})

it('uses one clock for task deadlines and one listener for shared foreground events', async () => {
  const add = vi.spyOn(window, 'addEventListener')
  const scheduler = owner()
  const first = vi.fn(async () => undefined)
  const second = vi.fn(async () => undefined)
  scheduler.observe('spending-renewals', first, { intervalMs: 1000 }).request()
  scheduler.observe('bitcoin-payment', second, { intervalMs: 2000 }).request()
  expect(vi.getTimerCount()).toBe(1)
  expect(add.mock.calls.filter(([name]) => name === 'focus')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(150)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(150)
  expect(first).toHaveBeenCalledTimes(3)
  expect(second).toHaveBeenCalledTimes(2)
  await scheduler.dispose()
  expect(vi.getTimerCount()).toBe(0)
  add.mockRestore()
})

it('shares screen cadence requests and restores the owner interval when they leave', async () => {
  const scheduler = owner()
  const run = vi.fn(async () => undefined)
  scheduler.observe('lightning-observer', run, { intervalMs: 15_000 })
  const leaveSlow = scheduler.requestCadence('lightning-observer', 10_000)
  const leaveFast = scheduler.requestCadence('lightning-observer', 5000)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  expect(run).toHaveBeenCalledTimes(2)
  leaveFast()
  await vi.advanceTimersByTimeAsync(9999)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(3)
  leaveSlow()
  await vi.advanceTimersByTimeAsync(14999)
  expect(run).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(4)
})

it('retains cadence across SDK availability and owner replacement, with idempotent release', async () => {
  let visible = false
  const scheduler = owner(() => visible)
  const leave = scheduler.requestCadence('lightning-observer', 5000)
  const run = vi.fn(async () => undefined)
  const first = scheduler.observe('lightning-observer', run, { intervalMs: 15_000 })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(run).not.toHaveBeenCalled()
  visible = true
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledOnce()
  await first.dispose()
  scheduler.observe('lightning-observer', run, { intervalMs: 15_000 })
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(5000)
  expect(run).toHaveBeenCalledTimes(3)
  leave()
  leave()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(4)
})

it('coalesces receipt bursts and retains one follow-up when activity arrives during recovery capture', async () => {
  const scheduler = owner()
  const pending = deferred<void>()
  const run = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(undefined)
  const task = scheduler.observe('recovery-archive', run, {
    intervalMs: 30_000,
    events: ['wallet'],
    trailing: true,
  })
  task.request()
  task.request()
  task.request()
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledOnce()
  scheduler.invalidate('wallet')
  scheduler.invalidate('wallet')
  pending.resolve()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
})

it('does not queue the Lightning observer from events raised by its own active pass', async () => {
  const scheduler = owner()
  const run = vi.fn(async () => scheduler.invalidate('wallet'))
  const task = scheduler.observe('lightning-observer', run, { intervalMs: 15_000, events: ['wallet'] })
  await task.refresh()
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledOnce()
})

it('retains hidden activity and refreshes on visibility without running background timers', async () => {
  let visible = false
  const scheduler = owner(() => visible)
  const run = vi.fn(async () => undefined)
  const task = scheduler.observe('recovery-archive', run, {
    intervalMs: 1000,
    events: ['wallet', 'visibilitychange'],
    trailing: true,
  })
  task.request()
  scheduler.invalidate('wallet')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  visible = true
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledOnce()
  visible = false
  document.dispatchEvent(new Event('visibilitychange'))
  expect(vi.getTimerCount()).toBe(0)
})

it('reports capture failure and retries on reconnect without losing the previous result owner', async () => {
  const scheduler = owner()
  const run = vi.fn().mockRejectedValueOnce(new Error('missing checkpoint')).mockResolvedValue(undefined)
  const failed = vi.fn()
  const task = scheduler.observe('recovery-archive', run, { intervalMs: 30_000, failed })
  task.request()
  await vi.advanceTimersByTimeAsync(150)
  expect(failed).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledTimes(2)
  await task.dispose()
  task.request()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledTimes(2)
})

it('drains a running task before disposal and prevents its late publication', async () => {
  const scheduler = owner()
  const pending = deferred<void>()
  const notify = vi.fn()
  const task = scheduler.observe(
    'lightning-observer',
    async (signal) => {
      await pending.promise
      if (!signal.aborted) notify()
    },
    { intervalMs: 15_000 },
  )
  const flight = task.refresh()
  await Promise.resolve()
  let drained = false
  const disposal = scheduler.dispose().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  pending.resolve()
  await Promise.all([flight, disposal])
  expect(notify).not.toHaveBeenCalled()
  expect(drained).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for an obsolete observation before running its replacement with a distinct result', async () => {
  const scheduler = owner()
  const pending = deferred<string>()
  const first = scheduler.observe('ledger-payment', () => pending.promise, { intervalMs: 20_000 })
  const old = first.refresh()
  await Promise.resolve()
  const disposal = first.dispose()
  const run = vi.fn(async () => 'current')
  const second = scheduler.observe('ledger-payment', run, { intervalMs: 20_000 })
  const next = second.refresh()
  await Promise.resolve()
  expect(run).not.toHaveBeenCalled()
  pending.resolve('obsolete')
  expect(await old).toBe('obsolete')
  await disposal
  expect(await next).toBe('current')
  expect(run).toHaveBeenCalledOnce()
  await first.dispose()
  second.request()
  await vi.advanceTimersByTimeAsync(150)
  expect(run).toHaveBeenCalledTimes(2)
})

it('pauses task admission and drains active work before replacing SDK resources', async () => {
  const scheduler = owner()
  const pending = deferred<void>()
  const work = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(undefined)
  const task = scheduler.observe('bitcoin-payment', work, { intervalMs: 15_000 })
  const first = task.refresh()
  await Promise.resolve()
  const replaced = vi.fn(async () => undefined)
  const replacement = scheduler.withPaused(replaced)
  const second = task.refresh()
  await Promise.resolve()
  expect(replaced).not.toHaveBeenCalled()
  expect(work).toHaveBeenCalledOnce()
  pending.resolve()
  await Promise.all([first, replacement, second])
  expect(replaced).toHaveBeenCalledOnce()
  expect(work).toHaveBeenCalledTimes(2)
  expect(replaced.mock.invocationCallOrder[0]).toBeLessThan(work.mock.invocationCallOrder[1])
})

it('rejects a second task owner and ignores journal events addressed to another vault', async () => {
  const scheduler = owner()
  const work = vi.fn(async () => undefined)
  scheduler.observe('spending-renewals', work, { intervalMs: 30_000, events: ['renewals'] })
  expect(() => scheduler.observe('spending-renewals', work, { intervalMs: 30_000 })).toThrow('already owns')
  window.dispatchEvent(new CustomEvent('renewals', { detail: 'account-b' }))
  await vi.advanceTimersByTimeAsync(150)
  expect(work).not.toHaveBeenCalled()
  window.dispatchEvent(new CustomEvent('renewals', { detail: 'account-a' }))
  await vi.advanceTimersByTimeAsync(150)
  expect(work).toHaveBeenCalledOnce()
})
