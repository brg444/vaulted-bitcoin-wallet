import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { hapticSubtle } from '../lib/haptics'
import { claimArrivalDelivery } from '../lib/vault/arrivalDelivery'
import { saveArrivalBanners, saveArrivalHaptics } from '../lib/vault/prefs'
import type { VaultHistoryItem } from '../lib/vault/history'
import { usePaymentArrivals, type ArrivalDeliveryPrefs } from './usePaymentArrivals'
import { useNotificationPrefs } from './useNotificationPrefs'

vi.mock('../lib/haptics', () => ({ hapticSubtle: vi.fn() }))
vi.mock('../lib/vault/arrivalDelivery', () => ({
  claimArrivalDelivery: vi.fn(async (keys: readonly string[]) => keys),
}))

const mockedHaptic = vi.mocked(hapticSubtle)
const mockedClaim = vi.mocked(claimArrivalDelivery)

function row(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 12_000, confirmed: true, account: 'spend', ...partial }
}

const ENABLED: ArrivalDeliveryPrefs = { bannersEnabled: true, hapticsEnabled: true }
const NO_BANNERS: ArrivalDeliveryPrefs = { bannersEnabled: false, hapticsEnabled: true }
const NO_HAPTICS: ArrivalDeliveryPrefs = { bannersEnabled: true, hapticsEnabled: false }

describe('arrival delivery preferences', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.clearAllMocks()
  })

  it('hides banners while disabled without claiming delivery or losing dedup state', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-1' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: ENABLED } },
    )
    rerender({ rows: [stored, row({ txid: 'fresh' })], delivery: ENABLED })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh']))
    expect(mockedClaim).toHaveBeenCalled()

    mockedClaim.mockClear()
    rerender({ rows: [stored, row({ txid: 'fresh' }), row({ txid: 'hidden' })], delivery: NO_BANNERS })
    await waitFor(() => expect(mockedClaim).not.toHaveBeenCalled())
    // Disabling dismisses visible and pending notices; nothing new is added.
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
  })

  it('never replays disabled-period payments after re-enabling', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-2' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: NO_BANNERS } },
    )
    rerender({ rows: [stored, row({ txid: 'while-off' })], delivery: NO_BANNERS })
    await waitFor(() => expect(mockedClaim).not.toHaveBeenCalled())
    expect(result.current.arrivals).toEqual([])

    rerender({ rows: [stored, row({ txid: 'while-off' })], delivery: ENABLED })
    await waitFor(() => expect(mockedClaim).not.toHaveBeenCalled())
    expect(result.current.arrivals).toEqual([])

    rerender({ rows: [stored, row({ txid: 'while-off' }), row({ txid: 'while-on' })], delivery: ENABLED })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['while-on']))
  })

  it('keeps visual banners while arrival haptics are off', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-3' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: NO_HAPTICS } },
    )
    rerender({ rows: [stored, row({ txid: 'quiet' })], delivery: NO_HAPTICS })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['quiet']))
    expect(mockedHaptic).not.toHaveBeenCalled()

    // A later payment folds the visible banner into one summary so two
    // notices never stack, with a single haptic pulse for the summary.
    rerender({ rows: [stored, row({ txid: 'quiet' }), row({ txid: 'loud' })], delivery: ENABLED })
    await waitFor(() => expect(result.current.catchUp).toMatchObject({ count: 2 }))
    expect(result.current.arrivals).toEqual([])
    expect(mockedHaptic).toHaveBeenCalledTimes(1)
  })

  it('drops a pending claim announcement when banners are disabled mid-flight', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-4' }
    const stored = row({ txid: 'stored' })
    let resolveClaim!: (keys: readonly string[]) => void
    mockedClaim.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveClaim = (keys) => resolve([...keys])
        }),
    )
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: ENABLED } },
    )
    rerender({ rows: [stored, row({ txid: 'inflight' })], delivery: ENABLED })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalledTimes(1))
    rerender({ rows: [stored, row({ txid: 'inflight' })], delivery: NO_BANNERS })
    await act(async () => {
      resolveClaim(['tx:mutinynet:vault-prefs-4:spend:inflight:received'])
    })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
  })

  it('drops approval-buffered arrivals on disable and stays quiet after re-enable', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-5' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, paused, delivery }) => usePaymentArrivals(rows, scope, paused, true, new Set(), delivery),
      { initialProps: { rows: [stored], paused: true, delivery: ENABLED } },
    )
    rerender({ rows: [stored, row({ txid: 'buffered' })], paused: true, delivery: ENABLED })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalled())
    rerender({ rows: [stored, row({ txid: 'buffered' })], paused: true, delivery: NO_BANNERS })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
    rerender({ rows: [stored, row({ txid: 'buffered' })], paused: false, delivery: NO_BANNERS })
    expect(result.current.arrivals).toEqual([])
    rerender({ rows: [stored, row({ txid: 'buffered' })], paused: false, delivery: ENABLED })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
  })

  it('drops a stale claim across disable and re-enable but announces new payments', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-7' }
    const stored = row({ txid: 'stored' })
    let resolveClaim!: (keys: readonly string[]) => void
    mockedClaim.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveClaim = (keys) => resolve([...keys])
        }),
    )
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: ENABLED } },
    )
    rerender({ rows: [stored, row({ txid: 'stale' })], delivery: ENABLED })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalledTimes(1))
    // Disable advances the delivery generation; re-enable before resolution.
    rerender({ rows: [stored, row({ txid: 'stale' })], delivery: NO_BANNERS })
    rerender({ rows: [stored, row({ txid: 'stale' })], delivery: ENABLED })
    await act(async () => {
      resolveClaim(['tx:mutinynet:vault-prefs-7:spend:stale:received'])
    })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))

    rerender({ rows: [stored, row({ txid: 'stale' }), row({ txid: 'genuine' })], delivery: ENABLED })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['genuine']))
  })

  it('reads haptics at delivery time, not at detection time', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-6' }
    const stored = row({ txid: 'stored' })
    let resolveClaim!: (keys: readonly string[]) => void
    mockedClaim.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveClaim = (keys) => resolve([...keys])
        }),
    )
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: NO_HAPTICS } },
    )
    rerender({ rows: [stored, row({ txid: 'retimed' })], delivery: NO_HAPTICS })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalledTimes(1))
    rerender({ rows: [stored, row({ txid: 'retimed' })], delivery: ENABLED })
    await act(async () => {
      resolveClaim(['tx:mutinynet:vault-prefs-6:spend:retimed:received'])
    })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['retimed']))
    expect(mockedHaptic).toHaveBeenCalled()
  })

  it('unions two deferred batches resolving in the same act into one summary', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-prefs-8' }
    const stored = row({ txid: 'stored' })
    const resolvers: ((keys: readonly string[]) => void)[] = []
    mockedClaim.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolvers.push((keys) => resolve([...keys]))
        }),
    )
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    rerender({ rows: [stored, row({ txid: 'batch-a', amount: 1_000 }), row({ txid: 'batch-b', amount: 2_000 })] })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalledTimes(1))
    rerender({
      rows: [
        stored,
        row({ txid: 'batch-a', amount: 1_000 }),
        row({ txid: 'batch-b', amount: 2_000 }),
        row({ txid: 'batch-c', amount: 4_000 }),
      ],
    })
    await waitFor(() => expect(mockedClaim).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolvers[0]([
        'tx:mutinynet:vault-prefs-8:spend:batch-a:received',
        'tx:mutinynet:vault-prefs-8:spend:batch-b:received',
      ])
      resolvers[1](['tx:mutinynet:vault-prefs-8:spend:batch-c:received'])
    })
    await waitFor(() => expect(result.current.catchUp).toMatchObject({ count: 3, totalSats: 7_000 }))
    expect(result.current.arrivals).toEqual([])
  })
})

describe('notification preferences scope', () => {
  beforeEach(() => {
    window.localStorage.clear()
    saveArrivalBanners(true)
    saveArrivalHaptics(true)
  })

  function keyedStorageEvent(key: string | null): Event {
    try {
      return new StorageEvent('storage', { key })
    } catch {
      const event = new Event('storage')
      Object.defineProperty(event, 'key', { value: key })
      return event
    }
  }

  it('defaults on, persists per device, and picks up other tabs', async () => {
    const { result } = renderHook(() => useNotificationPrefs())
    expect(result.current).toEqual({ bannersEnabled: true, arrivalHapticsEnabled: true })

    window.localStorage.setItem('arkade-vault-arrival-banners', '0')
    window.dispatchEvent(keyedStorageEvent('arkade-vault-arrival-banners'))
    await waitFor(() => expect(result.current.bannersEnabled).toBe(false))
    expect(result.current.arrivalHapticsEnabled).toBe(true)
  })

  it('ignores unrelated storage keys from other documents', async () => {
    const { result } = renderHook(() => useNotificationPrefs())
    expect(result.current.bannersEnabled).toBe(true)

    window.localStorage.setItem('unrelated-key', '0')
    window.dispatchEvent(keyedStorageEvent('unrelated-key'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current).toEqual({ bannersEnabled: true, arrivalHapticsEnabled: true })
  })

  it('keeps the session consistent when the storage write itself fails', async () => {
    const { saveArrivalBanners } = await import('../lib/vault/prefs')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      const { result } = renderHook(() => useNotificationPrefs())
      expect(result.current.bannersEnabled).toBe(true)
      act(() => {
        saveArrivalBanners(false)
      })
      await waitFor(() => expect(result.current.bannersEnabled).toBe(false))
    } finally {
      setItem.mockRestore()
    }
  })

  it('survives remount and unrelated storage events after failed writes', async () => {
    const { saveArrivalBanners } = await import('../lib/vault/prefs')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      const first = renderHook(() => useNotificationPrefs())
      act(() => {
        saveArrivalBanners(false)
      })
      await waitFor(() => expect(first.result.current.bannersEnabled).toBe(false))
      first.unmount()

      const second = renderHook(() => useNotificationPrefs())
      expect(second.result.current.bannersEnabled).toBe(false)

      window.dispatchEvent(keyedStorageEvent('unrelated-key'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(second.result.current.bannersEnabled).toBe(false)
      second.unmount()
    } finally {
      setItem.mockRestore()
    }
  })
})
