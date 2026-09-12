import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useSpendingBitcoin } from './useSpendingBitcoin'
import type { VaultStatus } from '../lib/vault/types'

const mocks = vi.hoisted(() => ({ read: vi.fn(), check: vi.fn(), acknowledge: vi.fn() }))
vi.mock('../lib/vault/spendingBitcoinStore', () => ({
  readSpendingBitcoin: mocks.read,
  BITCOIN_PAYMENT_EVENT: 'vaulted-savings-setup',
}))
vi.mock('../lib/vault/spendingBitcoinFunding', () => ({
  checkSpendingBitcoin: mocks.check,
  acknowledgeSpendingBitcoinRecovery: mocks.acknowledge,
}))
const status = { vaultId: 'account', network: 'mainnet', enrolled: true } as VaultStatus
const coverage = { vaultId: 'account', network: 'mainnet', descriptorHash: 'aa', fileDigest: 'bb', outputs: [] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockReturnValue({ operationId: 'same-operation', stage: 'confirmed' })
  mocks.acknowledge.mockResolvedValue(false)
})

it('resumes a confirmed journal from durable coverage on mount without requiring another server response', async () => {
  mocks.acknowledge.mockImplementation(async () => {
    mocks.read.mockReturnValue(null)
    return true
  })
  const { result, unmount } = renderHook(() => useSpendingBitcoin(status, false))
  await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledWith(status))
  await waitFor(() => expect(result.current.snapshot.operation).toBeNull())
  expect(mocks.check).not.toHaveBeenCalled()
  unmount()
})

it('keeps failed acknowledgment resumable and prevents payment failure from failing a completed backup', async () => {
  mocks.acknowledge.mockRejectedValue(new Error('History unavailable'))
  const { result, unmount } = renderHook(() => useSpendingBitcoin(status, false))
  await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledTimes(1))
  await act(() => result.current.acknowledgeRecovery(coverage))
  expect(result.current.snapshot.operation?.operationId).toBe('same-operation')
  mocks.acknowledge.mockImplementation(async () => {
    mocks.read.mockReturnValue(null)
    return true
  })
  act(() => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(result.current.snapshot.operation).toBeNull())
  unmount()
})

it.each(['lock', 'unmount'])('does not begin acknowledgment after %s during reconciliation', async (change) => {
  mocks.read.mockReturnValue({ stage: 'submitted' })
  let finish!: () => void
  mocks.check.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const { rerender, unmount } = renderHook(({ locked }) => useSpendingBitcoin(status, locked), {
    initialProps: { locked: false },
  })
  await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce())
  if (change === 'lock') rerender({ locked: true })
  else unmount()
  await act(async () => {
    finish()
    await Promise.resolve()
  })
  expect(mocks.acknowledge).not.toHaveBeenCalled()
  unmount()
})

it('rejects callback evidence for another account and drops callback authority when locked', async () => {
  mocks.read.mockReturnValue(null)
  const { result, rerender, unmount } = renderHook(({ locked }) => useSpendingBitcoin(status, locked), {
    initialProps: { locked: false },
  })
  await act(() => result.current.acknowledgeRecovery({ ...coverage, vaultId: 'other' }))
  await act(() => result.current.acknowledgeRecovery({ ...coverage, network: 'mutinynet' }))
  rerender({ locked: true })
  await act(() => result.current.acknowledgeRecovery(coverage))
  expect(mocks.acknowledge).not.toHaveBeenCalled()
  unmount()
})
