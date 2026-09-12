import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRecoveryAlerts } from './useRecoveryAlerts'
import { fetchAddressUtxos } from '../lib/vault/esplora'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime } from '../lib/vault/accountRuntime'
import { ledgerRecoveryFacts } from '../lib/vault/recovery/testdata/helpers'
import { saveLocalKit } from '../lib/vault/program/kitStore'
import { loadSeenOutpoints } from '../lib/vault/program/watch'

vi.mock('../lib/vault/esplora', () => ({ fetchAddressUtxos: vi.fn() }))
const facts = ledgerRecoveryFacts(false, 'mutinynet')
const read = vi.mocked(fetchAddressUtxos)
const coin = { txid: 'cd'.repeat(32), vout: 0, value: 20000, status: { confirmed: true } }

beforeEach(() => {
  localStorage.clear()
  saveLocalKit(facts.kit)
  vi.clearAllMocks()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  read.mockImplementation(async (address) =>
    address === facts.kit.descriptor.pending['savings-phone'].address ? [coin] : [],
  )
  vi.useFakeTimers()
})

afterEach(async () => {
  const account = activeVaultAccountRuntime(facts.status.vaultId)
  if (account) await disposeVaultAccountRuntime(account)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('subscribes once through Strict Mode and releases observation when the view leaves', async () => {
  const { result, unmount } = renderHook(() => useRecoveryAlerts(facts.status, false), { wrapper: StrictMode })
  await act(async () => vi.advanceTimersByTimeAsync(150))
  expect(read).toHaveBeenCalledTimes(2)
  expect(result.current).toContain('started recovery on Savings with this device')
  unmount()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(read).toHaveBeenCalledTimes(2)
})

it('cancels pending observation on lock and accepts fresh evidence after unlocking', async () => {
  let aborted = false
  read.mockImplementationOnce(
    (_address, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(signal!.reason)
          },
          { once: true },
        )
      }),
  )
  const { result, rerender } = renderHook(({ locked }) => useRecoveryAlerts(facts.status, locked), {
    initialProps: { locked: true },
  })
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(read).not.toHaveBeenCalled()
  rerender({ locked: false })
  await act(async () => vi.advanceTimersByTimeAsync(150))
  expect(read).toHaveBeenCalledOnce()
  rerender({ locked: true })
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(aborted).toBe(true)
  expect(result.current).toBe('')
  expect(
    loadSeenOutpoints({
      vaultId: facts.status.vaultId,
      network: facts.kit.descriptor.network,
      descriptorHash: facts.kit.descriptorHash,
    }).size,
  ).toBe(0)
  rerender({ locked: false })
  await act(async () => vi.advanceTimersByTimeAsync(150))
  expect(read).toHaveBeenCalledTimes(3)
  expect(result.current).toContain('started recovery on Savings with this device')
})
