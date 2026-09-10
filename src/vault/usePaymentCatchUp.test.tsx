import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { hapticSubtle } from '../lib/haptics'
import { saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import type { VaultHistoryItem } from '../lib/vault/history'
import { usePaymentArrivals } from './usePaymentArrivals'

vi.mock('../lib/haptics', () => ({ hapticSubtle: vi.fn() }))

const mockedHaptic = vi.mocked(hapticSubtle)

function row(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 12_000, confirmed: true, account: 'spend', ...partial }
}

const ENABLED = { bannersEnabled: true, hapticsEnabled: true }
const NO_BANNERS = { bannersEnabled: false, hapticsEnabled: true }

describe('reconnect catch-up summary', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.clearAllMocks()
  })

  it('collapses several newly verified payments into one summary instead of a burst', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-1' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    rerender({
      rows: [stored, row({ txid: 'new-a', amount: 5_000 }), row({ txid: 'new-b', amount: 7_000 })],
    })
    await waitFor(() =>
      expect(result.current.catchUp).toMatchObject({
        count: 2,
        totalSats: 12_000,
        keys: [
          'tx:mutinynet:vault-catchup-1:spend:new-a:received',
          'tx:mutinynet:vault-catchup-1:spend:new-b:received',
        ],
      }),
    )
    expect(result.current.arrivals).toEqual([])
    expect(mockedHaptic).toHaveBeenCalledTimes(1)
  })

  it('keeps a single fresh payment as one individual banner', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-2' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    rerender({ rows: [stored, row({ txid: 'lone' })] })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['lone']))
    expect(result.current.catchUp).toBeNull()
  })

  it('stays quiet on first sync and reload without a trusted baseline', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-3' }
    const history = [row({ txid: 'old-a' }), row({ txid: 'old-b' }), row({ txid: 'old-c' })]
    const { result, unmount } = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true), {
      initialProps: { rows: history },
    })
    await waitFor(() => expect(result.current.catchUp).toBeNull())
    expect(result.current.arrivals).toEqual([])
    unmount()

    window.localStorage.clear()
    const reloaded = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    })
    reloaded.rerender({ rows: history })
    await waitFor(() => expect(reloaded.result.current.catchUp).toBeNull())
    expect(reloaded.result.current.arrivals).toEqual([])
    reloaded.unmount()
  })

  it('summarizes payments that complete while away and counts equal amounts separately', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-4' }
    const pending = (txid: string) => row({ txid, confirmed: false })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [pending('away-a'), pending('away-b')] } },
    )
    await waitFor(() => expect(result.current.catchUp).toBeNull())
    rerender({ rows: [row({ txid: 'away-a', amount: 5_000 }), row({ txid: 'away-b', amount: 5_000 })] })
    await waitFor(() => expect(result.current.catchUp?.count).toBe(2))
    expect(result.current.catchUp).toMatchObject({ count: 2, totalSats: 10_000 })
    expect(result.current.arrivals).toEqual([])
  })

  it('summarizes payments that complete while away across an actual remount', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-4b' }
    const pending = (txid: string) => row({ txid, confirmed: false })
    const first = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [pending('away-a'), pending('away-b')] },
    })
    await waitFor(() => expect(first.result.current.catchUp).toBeNull())
    first.unmount()

    const second = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [row({ txid: 'away-a', amount: 5_000 }), row({ txid: 'away-b', amount: 5_000 })] },
    })
    await waitFor(() => expect(second.result.current.catchUp).toMatchObject({ count: 2, totalSats: 10_000 }))
    expect(second.result.current.arrivals).toEqual([])
    second.unmount()
  })

  it('announces across exactly one tab with simultaneous real arbitration', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-5' }
    const stored = row({ txid: 'stored' })
    const fresh = [stored, row({ txid: 'tab-a' }), row({ txid: 'tab-b' })]
    // Both tabs mount before either detects, then observe the same rows.
    const first = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [stored] },
    })
    const second = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [stored] },
    })
    await waitFor(() => expect(first.result.current.catchUp).toBeNull())
    await waitFor(() => expect(second.result.current.catchUp).toBeNull())
    first.rerender({ rows: fresh })
    second.rerender({ rows: fresh })
    await waitFor(() => {
      const summaries = [first.result.current.catchUp, second.result.current.catchUp].filter(Boolean)
      expect(summaries).toHaveLength(1)
    })
    const winner = first.result.current.catchUp ? first : second
    const loser = winner === first ? second : first
    expect(winner.result.current.catchUp).toMatchObject({ count: 2 })
    expect(winner.result.current.arrivals).toEqual([])
    expect(loser.result.current.catchUp).toBeNull()
    expect(loser.result.current.arrivals).toEqual([])
    first.unmount()
    second.unmount()
  })

  it('clears the summary on scope switch without replaying', async () => {
    const first = { network: 'mutinynet', vaultId: 'vault-catchup-6a' }
    const second = { network: 'mutinynet', vaultId: 'vault-catchup-6b' }
    const { result, rerender } = renderHook(
      ({ rows, scope }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [row({ txid: 'stored' })], scope: first } },
    )
    rerender({ rows: [row({ txid: 'stored' }), row({ txid: 'x' }), row({ txid: 'y' })], scope: first })
    await waitFor(() => expect(result.current.catchUp?.count).toBe(2))
    rerender({ rows: [row({ txid: 'other' })], scope: second })
    await waitFor(() => expect(result.current.catchUp).toBeNull())
    expect(result.current.arrivals).toEqual([])
  })

  it('ignores stale re-presented snapshots and excluded older pagination', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-7' }
    const older = row({ txid: 'older-page', account: 'savings', blockTime: 100 })
    const excluded = new Set(['savings:older-page:received'])
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, excluded, ENABLED),
      { initialProps: { rows: [row({ txid: 'stored' }), older] } },
    )
    await waitFor(() => expect(result.current.catchUp).toBeNull())
    // Same snapshot again plus the excluded older page: still nothing.
    rerender({ rows: [row({ txid: 'stored' }), older] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
  })

  it('suppresses the summary while delivery is disabled and never replays it', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-8' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: NO_BANNERS } },
    )
    rerender({ rows: [stored, row({ txid: 'off-a' }), row({ txid: 'off-b' })], delivery: NO_BANNERS })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
    rerender({ rows: [stored, row({ txid: 'off-a' }), row({ txid: 'off-b' })], delivery: ENABLED })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
  })

  it('dismisses the summary without replay on later snapshots', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-9' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    const rows = [stored, row({ txid: 'd-a' }), row({ txid: 'd-b' })]
    rerender({ rows })
    await waitFor(() => expect(result.current.catchUp?.count).toBe(2))
    act(() => {
      result.current.dismissCatchUp()
    })
    expect(result.current.catchUp).toBeNull()
    rerender({ rows })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
  })

  it('flushes several approval-buffered arrivals as one summary on unlock', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-10' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, paused }) => usePaymentArrivals(rows, scope, paused, true, new Set(), ENABLED),
      { initialProps: { rows: [stored], paused: true } },
    )
    rerender({ rows: [stored, row({ txid: 'buf-a' }), row({ txid: 'buf-b' })], paused: true })
    await waitFor(() => expect(result.current.catchUp).toBeNull())
    expect(result.current.arrivals).toEqual([])
    rerender({ rows: [stored, row({ txid: 'buf-a' }), row({ txid: 'buf-b' })], paused: false })
    await waitFor(() => expect(result.current.catchUp?.count).toBe(2))
    expect(result.current.arrivals).toEqual([])
    expect(mockedHaptic).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for an old row omitted from a capped legacy baseline after upgrade', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-15' }
    // A deployed baseline capped below visible history never observed this
    // old receipt. Its absence from the cache is not evidence it is new.
    saveArrivalBaseline(scope, new Map([['tx:mutinynet:vault-catchup-15:spend:known:received', true]]))
    const { result, unmount } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      {
        initialProps: {
          rows: [row({ txid: 'known' }), row({ txid: 'legacy-old', amount: 5_000, blockTime: 100 })],
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
    unmount()
  })

  it('stays quiet when hydration adds historical records to a partial snapshot', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-16' }
    const stored = row({ txid: 'stored' })
    const first = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [stored] },
    })
    await waitFor(() => expect(first.result.current.catchUp).toBeNull())
    first.unmount()

    // The reopened tab hydrates in stages before its first ready snapshot:
    // every staged row belongs to the quiet seed, not to live detection.
    const second = renderHook(({ rows, ready }) => usePaymentArrivals(rows, scope, false, ready, new Set(), ENABLED), {
      initialProps: { rows: [stored], ready: false as boolean },
    })
    second.rerender({ rows: [stored, row({ txid: 'historical', amount: 5_000, blockTime: 100 })], ready: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.result.current.catchUp).toBeNull()
    expect(second.result.current.arrivals).toEqual([])
    second.rerender({ rows: [stored, row({ txid: 'historical', amount: 5_000, blockTime: 100 })], ready: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.result.current.catchUp).toBeNull()
    expect(second.result.current.arrivals).toEqual([])
    second.unmount()
  })

  it('grants no trust to a restored nonempty legacy baseline', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-17' }
    saveArrivalBaseline(scope, new Map([['tx:mutinynet:vault-catchup-17:spend:legacy:received', true]]))
    const { result, unmount } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      {
        initialProps: {
          rows: [row({ txid: 'legacy' }), row({ txid: 'legacy-old', amount: 5_000, blockTime: 100 })],
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    expect(result.current.arrivals).toEqual([])
    unmount()
  })

  it('stays quiet for unseen rows without independent newness evidence', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-11' }
    const stored = row({ txid: 'stored' })
    const first = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED), {
      initialProps: { rows: [stored] },
    })
    await waitFor(() => expect(first.result.current.catchUp).toBeNull())
    first.unmount()

    const rows = [stored, row({ txid: 'while-away-a' }), row({ txid: 'while-away-b' })]
    const second = renderHook(
      ({ rows: current, ready }) => usePaymentArrivals(current, scope, false, ready, new Set(), ENABLED),
      { initialProps: { rows, ready: false as boolean } },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.result.current.catchUp).toBeNull()
    expect(second.result.current.arrivals).toEqual([])
    // Rows never observed before seed quietly even with a trusted baseline:
    // absence from the cache never proves newness, so readiness flips stay
    // quiet. Supported reopen transitions are covered separately.
    second.rerender({ rows, ready: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.result.current.catchUp).toBeNull()
    expect(second.result.current.arrivals).toEqual([])
    second.unmount()
  })

  it('drops a disabled summary claim and still announces a later payment', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-12' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows, delivery }) => usePaymentArrivals(rows, scope, false, true, new Set(), delivery),
      { initialProps: { rows: [stored], delivery: ENABLED } },
    )
    rerender({ rows: [stored, row({ txid: 'held-a' }), row({ txid: 'held-b' })], delivery: NO_BANNERS })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    rerender({ rows: [stored, row({ txid: 'held-a' }), row({ txid: 'held-b' })], delivery: ENABLED })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.catchUp).toBeNull()
    rerender({
      rows: [stored, row({ txid: 'held-a' }), row({ txid: 'held-b' }), row({ txid: 'after' })],
      delivery: ENABLED,
    })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['after']))
    expect(result.current.catchUp).toBeNull()
  })

  it('merges later batches into an undismissed summary without side bursts', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-13' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    rerender({ rows: [stored, row({ txid: 'm-a', amount: 1_000 }), row({ txid: 'm-b', amount: 2_000 })] })
    await waitFor(() => expect(result.current.catchUp).toMatchObject({ count: 2, totalSats: 3_000 }))
    rerender({
      rows: [
        stored,
        row({ txid: 'm-a', amount: 1_000 }),
        row({ txid: 'm-b', amount: 2_000 }),
        row({ txid: 'm-c', amount: 4_000 }),
      ],
    })
    await waitFor(() => expect(result.current.catchUp).toMatchObject({ count: 3, totalSats: 7_000 }))
    expect(result.current.arrivals).toEqual([])
  })

  it('absorbs visible individuals into a later summary batch', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-catchup-14' }
    const stored = row({ txid: 'stored' })
    const { result, rerender } = renderHook(
      ({ rows }) => usePaymentArrivals(rows, scope, false, true, new Set(), ENABLED),
      { initialProps: { rows: [stored] } },
    )
    rerender({ rows: [stored, row({ txid: 'solo', amount: 1_000 })] })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['solo']))
    expect(result.current.catchUp).toBeNull()
    rerender({
      rows: [
        stored,
        row({ txid: 'solo', amount: 1_000 }),
        row({ txid: 'pair-a', amount: 2_000 }),
        row({ txid: 'pair-b', amount: 3_000 }),
      ],
    })
    await waitFor(() => expect(result.current.catchUp).toMatchObject({ count: 3, totalSats: 6_000 }))
    expect(result.current.arrivals).toEqual([])
  })
})
