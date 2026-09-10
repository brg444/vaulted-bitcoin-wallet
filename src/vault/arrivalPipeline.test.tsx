import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { TxType, type Activity, type ArkTransaction } from '@arkade-os/sdk'
import { historyFromSdkActivities } from '../lib/vault/history'
import { describePayment } from '../lib/vault/payments'
import { usePaymentArrivals } from './usePaymentArrivals'

vi.mock('../lib/haptics', () => ({ hapticSubtle: vi.fn() }))

const SCOPE = { network: 'mutinynet', vaultId: 'vault-pipeline' }
const ACTIVITY_SCOPE = { vaultTxids: new Set(['ark-receive-1']), lightningRfqIds: new Set<string>() }

function receiveTx(): ArkTransaction {
  return {
    key: { arkTxid: 'ark-receive-1', commitmentTxid: '', boardingTxid: '' },
    type: TxType.TxReceived,
    amount: 12_000,
    settled: false,
    createdAt: 1_700_000_000_000,
  }
}

function receiveActivity(): Activity {
  return {
    id: 'ark-receive-1',
    txs: [receiveTx()],
    amount: 12_000,
    createdAt: 1_700_000_000_000,
    settled: false,
  }
}

describe('foreground Arkade arrival pipeline', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.clearAllMocks()
  })

  it('projects a direct Arkade receive as a verified available receipt', () => {
    const rows = historyFromSdkActivities([receiveActivity()], ACTIVITY_SCOPE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ txid: 'ark-receive-1', type: 'received', amount: 12_000, confirmed: true })
    const described = describePayment(rows[0])
    expect(described).toMatchObject({ route: 'arkade', state: 'Received', complete: true })
    expect(described.origin).toBe('verified-external')
    expect(described.suppressArrival).toBe(false)
  })

  it('banners a direct Arkade receive that lands after the baseline snapshot', async () => {
    const before = historyFromSdkActivities([], ACTIVITY_SCOPE)
    const { result, rerender } = renderHook(
      ({ history }) =>
        usePaymentArrivals(history, SCOPE, false, true, new Set(), {
          bannersEnabled: true,
          hapticsEnabled: true,
        }),
      { initialProps: { history: before } },
    )
    await waitFor(() => expect(result.current.arrivals).toEqual([]))
    const after = historyFromSdkActivities([receiveActivity()], ACTIVITY_SCOPE)
    rerender({ history: after })
    await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['ark-receive-1']))
  })

  it('stays quiet when the receive is already present in the first snapshot', async () => {
    const first = historyFromSdkActivities([receiveActivity()], ACTIVITY_SCOPE)
    const { result } = renderHook(
      ({ history }) =>
        usePaymentArrivals(history, SCOPE, false, true, new Set(), {
          bannersEnabled: true,
          hapticsEnabled: true,
        }),
      { initialProps: { history: first } },
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(result.current.arrivals).toEqual([])
    expect(result.current.catchUp).toBeNull()
  })
})
