import { beforeEach, describe, expect, it } from 'vitest'
import { TxType, type Activity, type ArkTransaction } from '@arkade-os/sdk'
import { historyFromSdkActivities } from '../lib/vault/history'
import { describePayment } from '../lib/vault/payments'
import { detectPaymentArrivals, seedArrivalBaseline } from '../lib/vault/arrivalDetection'
import { isServerCovered } from './useNativePaymentNotifications'

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

  it('detects a fresh SDK receipt while assigning its native delivery to server push', () => {
    const before = seedArrivalBaseline([], SCOPE)
    const after = historyFromSdkActivities([receiveActivity()], ACTIVITY_SCOPE)
    const detected = detectPaymentArrivals(before, after, SCOPE)
    expect(detected.arrivals.map((arrival) => arrival.item.txid)).toEqual(['ark-receive-1'])
    expect(isServerCovered(detected.arrivals[0].item, SCOPE)).toBe(true)
    expect(detectPaymentArrivals(seedArrivalBaseline(after, SCOPE), after, SCOPE).arrivals).toEqual([])
  })
})
