import { afterEach, describe, expect, it, vi } from 'vitest'
import { lightBackupScheduler } from './backupScheduler'

afterEach(() => vi.useRealTimers())
describe('payment-driven backup scheduling', () => {
  it('coalesces bursts and reruns when a payment arrives during an upload', async () => {
    vi.useFakeTimers()
    let resolve!: () => void
    const work = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      )
      .mockResolvedValue(undefined)
    const failed = vi.fn()
    const scheduler = lightBackupScheduler(work, failed)
    scheduler.request()
    scheduler.request()
    scheduler.request()
    await vi.advanceTimersByTimeAsync(150)
    expect(work).toHaveBeenCalledTimes(1)
    scheduler.request()
    scheduler.request()
    resolve()
    await vi.advanceTimersByTimeAsync(1)
    expect(work).toHaveBeenCalledTimes(2)
    expect(failed).not.toHaveBeenCalled()
    scheduler.dispose()
  })
  it('reports failed path capture, then retries on reconnect without overlapping work', async () => {
    vi.useFakeTimers()
    const work = vi.fn().mockRejectedValueOnce(new Error('missing checkpoint')).mockResolvedValue(undefined)
    const failed = vi.fn()
    const scheduler = lightBackupScheduler(work, failed)
    scheduler.request()
    await vi.advanceTimersByTimeAsync(150)
    expect(failed).toHaveBeenCalledOnce()
    scheduler.request()
    await vi.advanceTimersByTimeAsync(150)
    expect(work).toHaveBeenCalledTimes(2)
    scheduler.dispose()
    scheduler.request()
    await vi.advanceTimersByTimeAsync(500)
    expect(work).toHaveBeenCalledTimes(2)
  })
})
