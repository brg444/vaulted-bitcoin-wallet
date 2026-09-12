import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSpendingRenewals } from './useSpendingRenewals'
import { sharedSpendingEnrollment, sharedSpendingStatus } from '../lib/vault/vtxo/testdata/sharedSpending'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), clear: vi.fn(), load: vi.fn() }))
vi.mock('../lib/vault/vtxo/guardianRenewal', () => ({
  refreshSpendingRenewals: mocks.refresh,
  clearSpendingRenewalReads: mocks.clear,
}))
vi.mock('../lib/vault/vtxo/renewalStore', () => ({
  loadSpendingRenewals: mocks.load,
  SPENDING_RENEWAL_EVENT: 'vaulted-spending-renewal',
}))
const status = sharedSpendingStatus()
const enrollment = sharedSpendingEnrollment()
const saved = { version: 1, descriptorHash: 'bound', sets: {}, operations: {} }
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.load.mockResolvedValue(saved)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('defers automatic enrollment maintenance while hidden and shares its first foreground wake', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  mocks.refresh.mockResolvedValue(saved)
  const { result } = renderHook(() => useSpendingRenewals(status, enrollment, false))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.refresh).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible')
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(result.current).toEqual(saved)
})

it('shares foreground demand with its pending renewal read and discards its result after locking', async () => {
  let finish!: (value: typeof saved) => void
  mocks.refresh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { result, rerender } = renderHook(({ locked }) => useSpendingRenewals(status, enrollment, locked), {
    initialProps: { locked: false },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(mocks.refresh).toHaveBeenCalledOnce()
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(mocks.refresh).toHaveBeenCalledOnce()
  rerender({ locked: true })
  await act(async () => {
    finish(saved)
  })
  expect(result.current).toBeNull()
  expect(mocks.clear).toHaveBeenCalledWith(status.vaultId)
})

it('retains a saved renewal journal through refresh failure and reads local updates without another remote request', async () => {
  mocks.refresh.mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() => useSpendingRenewals(status, enrollment, false))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(result.current).toEqual(saved)
  await act(async () => {
    window.dispatchEvent(new CustomEvent('vaulted-spending-renewal', { detail: status.vaultId }))
  })
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(mocks.load).toHaveBeenCalledTimes(2)
})
