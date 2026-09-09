import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { detectPaymentArrivals } from '../../vault/usePaymentArrivals'
import type { VaultHistoryItem } from '../../lib/vault/history'
import PaymentArrivalBanners from './PaymentArrivals'

const SCOPE = { network: 'mutinynet', vaultId: 'vault-1' }

function row(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 12_000, confirmed: true, account: 'spend', ...partial }
}

describe('arrival detection', () => {
  it('stays quiet for pre-existing rows and banners only newly available funds', () => {
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

  it('banners a Savings deposit when its confirmation lands', () => {
    const pending = row({ txid: 'savings-in', account: 'savings', confirmed: false, blockTime: 1_700_000_000 })
    const first = detectPaymentArrivals(new Map(), [pending], SCOPE)
    expect(first.arrivals).toEqual([])

    const confirmed = row({ txid: 'savings-in', account: 'savings', blockTime: 1_700_000_100 })
    const second = detectPaymentArrivals(first.seen, [confirmed], SCOPE)
    expect(second.arrivals.map((arrival) => arrival.item.txid)).toEqual(['savings-in'])
  })

  it('banners a Lightning receive only when the verified payout completes', () => {
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

  it('never banners outflows, internal movement, uncertain receipts, or incomplete rows', () => {
    const rows = [
      row({ txid: 'out', type: 'sent' }),
      row({
        txid: 'pending-savings:1',
        type: 'sent',
        account: 'savings',
        activity: 'savings-handoff',
        confirmed: false,
      }),
      row({ txid: 'connector', type: 'sent', account: 'savings', activity: 'savings-connector', confirmed: false }),
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

describe('arrival banners', () => {
  it('names amount and account, opens details, and dismisses', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onDismiss = vi.fn()
    const arrivals = [
      { key: 'a', item: row({ txid: 'a', amount: 12_000 }) },
      { key: 'b', item: row({ txid: 'b', amount: 5_000, account: 'savings' }) },
    ]
    render(<PaymentArrivalBanners arrivals={arrivals} onOpen={onOpen} onDismiss={onDismiss} />)

    expect(screen.getByRole('status', { name: 'New payments received' })).toBeVisible()
    expect(screen.getByText('Received ₿12,000 in Spending.')).toBeVisible()
    expect(screen.getByText('Received ₿5,000 in Savings.')).toBeVisible()
    expect(screen.queryByText(/from|sender/i)).toBeNull()

    await user.click(screen.getAllByRole('button', { name: 'View details' })[0])
    expect(onOpen).toHaveBeenCalledWith(arrivals[0])
    await user.click(screen.getByRole('button', { name: 'Dismiss arrival of ₿5,000 bitcoin in Savings' }))
    expect(onDismiss).toHaveBeenCalledWith('b')
  })

  it('renders nothing without arrivals', () => {
    const { container } = render(<PaymentArrivalBanners arrivals={[]} onOpen={vi.fn()} onDismiss={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
