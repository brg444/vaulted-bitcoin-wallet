import { afterEach, describe, expect, it } from 'vitest'
import { detectPaymentArrivals, seedArrivalBaseline } from './arrivalDetection'
import { saveArrivalBaseline } from './arrivalBaseline'
import { paymentIdentityForItem } from './payments'
import type { VaultHistoryItem } from './history'

const SCOPE = { network: 'mutinynet', vaultId: 'vault-1' }

function row(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 12_000, confirmed: true, account: 'spend', ...partial }
}

describe('arrival detection', () => {
  it('detects newly available funds once per payment identity', () => {
    const old = row({ txid: 'old-deposit' })
    const seen = new Map([['seed', true]])
    const first = detectPaymentArrivals(seen, [old], SCOPE)
    expect(first.arrivals.map((arrival) => arrival.item.txid)).toEqual(['old-deposit'])

    const pending = row({ txid: 'incoming', confirmed: false })
    const second = detectPaymentArrivals(first.seen, [old, pending], SCOPE)
    expect(second.arrivals).toEqual([])

    const settled = row({ txid: 'incoming' })
    const third = detectPaymentArrivals(second.seen, [old, settled], SCOPE)
    expect(third.arrivals.map((arrival) => arrival.item.txid)).toEqual(['incoming'])

    const again = detectPaymentArrivals(third.seen, [old, settled], SCOPE)
    expect(again.arrivals).toEqual([])
  })

  it('detects a Savings deposit when its confirmation lands', () => {
    const pending = row({ txid: 'savings-in', account: 'savings', confirmed: false, blockTime: 1_700_000_000 })
    const first = detectPaymentArrivals(new Map(), [pending], SCOPE)
    expect(first.arrivals).toEqual([])

    const confirmed = row({ txid: 'savings-in', account: 'savings', blockTime: 1_700_000_100 })
    const second = detectPaymentArrivals(first.seen, [confirmed], SCOPE)
    expect(second.arrivals.map((arrival) => arrival.item.txid)).toEqual(['savings-in'])
  })

  it('detects a Lightning receive only when the verified payout completes', () => {
    const rfq = 'rfq-arrival'
    const processing = row({
      txid: 'funding',
      type: 'sent',
      confirmed: false,
      activity: 'lightning',
      lightningState: 'pending',
      lightningRfqId: rfq,
    })
    const first = detectPaymentArrivals(new Map(), [processing], SCOPE)
    expect(first.arrivals).toEqual([])

    const settled = row({
      txid: 'funding',
      activity: 'lightning',
      lightningState: 'settled',
      lightningRfqId: rfq,
      amount: 500,
      displayAmount: 500,
      fee: 4,
    })
    const second = detectPaymentArrivals(first.seen, [settled], SCOPE)
    expect(second.arrivals).toHaveLength(1)
  })

  it('never detects an older browsed receipt passed through exclusion', () => {
    const older = row({ txid: 'older-receipt', account: 'savings', blockTime: 100 })
    const excluded = new Set(['savings:older-receipt:received'])
    const skipped = detectPaymentArrivals(new Map(), [older], SCOPE, excluded)
    expect(skipped.arrivals).toEqual([])
    expect(skipped.seen.get('tx:mutinynet:vault-1:savings:older-receipt:received')).toBe(true)

    const fresh = row({ txid: 'fresh-receipt', account: 'savings', blockTime: 200 })
    const detected = detectPaymentArrivals(skipped.seen, [older, fresh], SCOPE, excluded)
    expect(detected.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh-receipt'])
  })

  it('records an excluded available transition so removing exclusion cannot replay it', () => {
    const pending = row({ txid: 'late-receipt', account: 'savings', confirmed: false })
    const excluded = new Set(['savings:late-receipt:received'])
    const first = detectPaymentArrivals(new Map(), [pending], SCOPE, excluded)
    expect(first.arrivals).toEqual([])

    const settled = row({ txid: 'late-receipt', account: 'savings', blockTime: 300 })
    const second = detectPaymentArrivals(first.seen, [settled], SCOPE, excluded)
    expect(second.arrivals).toEqual([])
    expect(second.seen.get('tx:mutinynet:vault-1:savings:late-receipt:received')).toBe(true)

    const third = detectPaymentArrivals(second.seen, [settled], SCOPE, new Set())
    expect(third.arrivals).toEqual([])
  })

  it('suppresses a Savings receipt linked to the wallet’s own outflow', () => {
    // One Bitcoin transaction moving funds from Spending to Savings shows a
    // sent row and a received row with the same reference. The receipt is
    // internal movement, never a new external arrival.
    const internal = detectPaymentArrivals(
      new Map(),
      [
        row({ txid: 'self-move', type: 'sent', account: 'spend' }),
        row({ txid: 'self-move', account: 'savings', blockTime: 1_700_000_100 }),
      ],
      SCOPE,
    )
    expect(internal.arrivals).toEqual([])

    const external = detectPaymentArrivals(
      new Map(),
      [
        row({ txid: 'spend-out', type: 'sent', account: 'spend' }),
        row({ txid: 'savings-in', account: 'savings', blockTime: 1_700_000_100 }),
      ],
      SCOPE,
    )
    expect(external.arrivals.map((arrival) => arrival.item.txid)).toEqual(['savings-in'])
  })

  it('keeps two equal arrivals on a reusable address distinct', () => {
    const first = detectPaymentArrivals(
      new Map(),
      [row({ txid: 'deposit-a', amount: 5_000 }), row({ txid: 'deposit-b', amount: 5_000 })],
      SCOPE,
    )
    expect(first.arrivals.map((arrival) => arrival.item.txid).sort()).toEqual(['deposit-a', 'deposit-b'])
  })

  it('never detects outflows, internal movement, uncertain receipts, or incomplete rows', () => {
    const rows = [
      row({ txid: 'out', type: 'sent' }),
      row({
        txid: 'pending-savings:1',
        type: 'sent',
        account: 'savings',
        activity: 'savings-ledger',
        ledgerStage: 'signer',
        confirmed: false,
      }),
      row({ txid: 'pending-arkade', confirmed: false }),
      // Settled boarding mixes external deposits with internal
      // Savings-to-Spending transfers, so it stays visible in activity
      // without raising an arrival.
      row({ txid: 'boarding-settled', activity: 'boarding' }),
      row({ txid: 'spending-deposit', activity: 'bitcoin' }),
      row({
        txid: 'funding-send',
        type: 'sent',
        confirmed: false,
        activity: 'lightning',
        lightningState: 'pending',
        lightningRfqId: 'rfq-send',
      }),
    ]
    expect(detectPaymentArrivals(new Map(), rows, SCOPE).arrivals).toEqual([])
  })
})

describe('arrival baseline seeding', () => {
  afterEach(() => localStorage.clear())

  it('seeds unknown historical IDs quietly even with a partial stored baseline', () => {
    const old = row({ txid: 'old', account: 'savings' })
    saveArrivalBaseline(SCOPE, new Map([[paymentIdentityForItem(old, SCOPE).key, true]]))
    const history = [old, row({ txid: 'omitted', account: 'savings' })]
    const seeded = seedArrivalBaseline(history, SCOPE)
    expect(detectPaymentArrivals(seeded, history, SCOPE).arrivals).toEqual([])
    expect(detectPaymentArrivals(seeded, [...history, row({ txid: 'live' })], SCOPE).arrivals).toHaveLength(1)
  })

  it('retains pending transitions across reopen and keeps equal payments distinct', () => {
    const pending = ['pending-a', 'pending-b'].map((txid) => row({ txid, account: 'savings', confirmed: false }))
    saveArrivalBaseline(SCOPE, seedArrivalBaseline(pending, SCOPE))
    const confirmed = pending.map((item) => ({ ...item, confirmed: true }))
    const reopened = seedArrivalBaseline(confirmed, SCOPE)
    const detected = detectPaymentArrivals(reopened, confirmed, SCOPE)
    expect(detected.arrivals.map((arrival) => arrival.item.txid)).toEqual(['pending-a', 'pending-b'])
    expect(detectPaymentArrivals(detected.seen, pending, SCOPE).seen).toEqual(detected.seen)
    expect(detectPaymentArrivals(detected.seen, confirmed, SCOPE).arrivals).toEqual([])
  })
})
