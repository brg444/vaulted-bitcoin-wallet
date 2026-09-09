import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { seedArrivalBaseline, usePaymentArrivals } from './usePaymentArrivals'
import { saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import type { VaultHistoryItem } from '../lib/vault/history'

function row(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 12_000, confirmed: true, account: 'spend', ...partial }
}

describe('arrival readiness', async () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it('ignores history before readiness and seeds quietly once ready', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-ready-1' }
    const history = [row({ txid: 'stored' })]
    const { result, rerender } = renderHook(({ rows, ready }) => usePaymentArrivals(rows, scope, false, ready), {
      initialProps: { rows: history, ready: false },
    })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))

    rerender({ rows: history, ready: true })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))

    const next = [...history, row({ txid: 'fresh' })]
    rerender({ rows: next, ready: true })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh']))
  })

  it('replays nothing after a reload thanks to durable receipts', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-ready-2' }
    const stored = row({ txid: 'stored' })
    const { result, rerender, unmount } = renderHook(
      ({ rows, ready }) => usePaymentArrivals(rows, scope, false, ready),
      { initialProps: { rows: [stored], ready: true } },
    )
    rerender({ rows: [stored, row({ txid: 'fresh' })], ready: true })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh']))
    unmount()

    // A reload starts from empty history and hydrates in stages. Receipted
    // keys seed as already presented, so neither stage replays.
    const reloaded = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    })
    reloaded.rerender({ rows: [stored] })
    expect(reloaded.result.current.arrivals).toEqual([])
    reloaded.rerender({ rows: [stored, row({ txid: 'fresh' })] })
    expect(reloaded.result.current.arrivals).toEqual([])
    reloaded.unmount()
  })

  it('buffers arrivals while an approval is in flight and flushes after', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-ready-3' }
    const { result, rerender } = renderHook(({ rows, paused }) => usePaymentArrivals(rows, scope, paused, true), {
      initialProps: { rows: [row({ txid: 'stored' })], paused: false },
    })
    rerender({ rows: [row({ txid: 'stored' }), row({ txid: 'during-approval' })], paused: true })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
    act(() => {
      rerender({ rows: [row({ txid: 'stored' }), row({ txid: 'during-approval' })], paused: false })
    })
    await waitFor(() =>
      expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['during-approval']),
    )
  })

  it('starts a fresh baseline on vault switch', async () => {
    const first = { network: 'mutinynet', vaultId: 'vault-ready-4a' }
    const second = { network: 'mutinynet', vaultId: 'vault-ready-4b' }
    const history = [row({ txid: 'shared-txid' })]
    const { result, rerender } = renderHook(({ scope }) => usePaymentArrivals(history, scope, false, true), {
      initialProps: { scope: first },
    })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
    rerender({ scope: second })
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
  })

  it('banners a payment in at most one tab through the stored baseline', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-ready-6' }
    const first = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true), {
      initialProps: { rows: [row({ txid: 'stored' })] },
    })
    expect(first.result.current.arrivals).toEqual([])
    first.rerender({ rows: [row({ txid: 'stored' }), row({ txid: 'fresh' })] })
    await waitFor(() => expect(first.result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh']))

    const second = renderHook(({ rows }) => usePaymentArrivals(rows, scope, false, true), {
      initialProps: { rows: [row({ txid: 'stored' }), row({ txid: 'fresh' })] },
    })
    expect(second.result.current.arrivals).toEqual([])
    first.unmount()
    second.unmount()
  })

  it('seeds the stored baseline and banners only unseen available keys', async () => {
    const scope = { network: 'mutinynet', vaultId: 'vault-ready-5' }
    saveArrivalBaseline(scope, new Map([['lightning:mutinynet:vault-ready-5:rfq-old', true]]))
    const seeded = seedArrivalBaseline(
      [row({ txid: 'funding', activity: 'lightning', lightningState: 'settled', lightningRfqId: 'rfq-old' })],
      scope,
    )
    expect(seeded.get('lightning:mutinynet:vault-ready-5:rfq-old')).toBe(true)
  })
})
