import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { hapticSubtle } from '../lib/haptics'
import { claimArrivalDelivery } from '../lib/vault/arrivalDelivery'
import type { VaultHistoryItem } from '../lib/vault/history'
import { usePaymentArrivals, type ArrivalDeliveryPrefs } from './usePaymentArrivals'
import { useNotificationPrefs } from './useNotificationPrefs'

vi.mock('../lib/haptics', () => ({ hapticSubtle: vi.fn() }))
vi.mock('../lib/vault/arrivalDelivery', () => ({ claimArrivalDelivery: vi.fn(async (keys: string[]) => keys) }))

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
    // The earlier banner stays visible until dismissed; nothing new is added.
    expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh'])
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

    rerender({ rows: [stored, row({ txid: 'quiet' }), row({ txid: 'loud' })], delivery: ENABLED })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['quiet', 'loud']))
    expect(mockedHaptic).toHaveBeenCalled()
  })
})

describe('notification preferences scope', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults on, persists per device, and picks up other tabs', async () => {
    const { result } = renderHook(() => useNotificationPrefs())
    expect(result.current).toEqual({ bannersEnabled: true, arrivalHapticsEnabled: true })

    window.localStorage.setItem('arkade-vault-arrival-banners', '0')
    window.dispatchEvent(new Event('storage'))
    await waitFor(() => expect(result.current.bannersEnabled).toBe(false))
    expect(result.current.arrivalHapticsEnabled).toBe(true)
  })
})
