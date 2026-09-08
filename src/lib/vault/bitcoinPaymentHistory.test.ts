import { describe, expect, it } from 'vitest'
import { TxType } from '@arkade-os/sdk'
import { withBitcoinPaymentHistory } from './bitcoinPaymentHistory'
import { historyFromSdkActivities, type VaultHistoryItem } from './history'
import type { BitcoinPaymentJournal } from './spendingBitcoinStore'

const received: VaultHistoryItem = { txid: 'input', type: 'received', amount: 27259, confirmed: true, account: 'spend' }
const journal = {
  operationId: 'payment',
  stage: 'submitted',
  plan: {
    plan: {
      outputs: [
        { script: '0014' + '43'.repeat(20), amountSats: 500 },
        { script: '0014' + '43'.repeat(20), amountSats: 500 },
      ],
      feeSats: 400,
      changeSats: 25859,
    },
  },
  receipt: { commitmentTxid: 'commitment', state: 'submitted' },
} as BitcoinPaymentJournal

describe('Bitcoin payment activity', () => {
  it('shows one account outflow rather than change or two duplicate destinations', () => {
    const rows = withBitcoinPaymentHistory([received], journal)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      txid: 'commitment',
      amount: 1400,
      fee: 400,
      confirmed: false,
      activity: 'bitcoin',
      bitcoinOperationId: 'payment',
    })
    expect(rows[1]).toEqual(received)
  })
  it('uses one pending row before a Bitcoin txid exists, without inventing a transaction hash', () => {
    const rows = withBitcoinPaymentHistory([received], { ...journal, receipt: undefined, stage: 'registered' })
    expect(rows[0].txid).toBe('bitcoin:payment')
    expect(rows[0].confirmed).toBe(false)
  })
  it('hands the exact commitment to SDK history without duplicating it or changing the amount', () => {
    const sdkRows = historyFromSdkActivities(
      [
        {
          id: 'exit:commitment',
          intent: { kind: 'exit' },
          amount: -1400,
          settled: true,
          createdAt: 1700000000000,
          txs: [
            {
              key: { arkTxid: '', commitmentTxid: 'commitment', boardingTxid: '' },
              tag: 'exit',
              type: TxType.TxSent,
              amount: 1400,
              settled: true,
              createdAt: 1700000000000,
            },
          ],
        },
      ],
      { vaultTxids: new Set(['commitment']), lightningRfqIds: new Set() },
    )
    const observed = [...sdkRows, received]
    expect(sdkRows[0]).toMatchObject({ txid: 'commitment', activity: 'bitcoin', amount: 1400, confirmed: true })
    expect(withBitcoinPaymentHistory(observed, journal)).toHaveLength(2)
    expect(withBitcoinPaymentHistory(observed, journal)[0].confirmed).toBe(false)
    expect(withBitcoinPaymentHistory(observed, { ...journal, stage: 'confirmed' })[0].confirmed).toBe(true)
    expect(withBitcoinPaymentHistory(observed, null)).toEqual(observed)
  })
  it('removes a released local payment without removing the original receive', () => {
    expect(withBitcoinPaymentHistory([received], null)).toEqual([received])
  })
})
