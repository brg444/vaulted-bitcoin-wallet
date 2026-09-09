import { describe, expect, it } from 'vitest'
import { groupVaultHistory, type VaultHistoryItem } from './history'
import { describePayment, isSamePayment, paymentIdentityForItem } from './payments'

const SCOPE = { network: 'mutinynet', vaultId: 'vault-1' }

function item(partial: Partial<VaultHistoryItem> & { txid: string }): VaultHistoryItem {
  return { type: 'received', amount: 1_000, confirmed: true, account: 'spend', ...partial }
}

describe('payment identity', () => {
  it('keeps one Lightning payment across funding, claim, and refund rows', () => {
    const funding = item({
      txid: 'funding-a',
      type: 'sent',
      activity: 'lightning',
      lightningState: 'pending',
      lightningRfqId: 'rfq-1',
      confirmed: false,
    })
    const claimed = item({
      txid: 'funding-a',
      type: 'sent',
      activity: 'lightning',
      lightningState: 'claimed',
      lightningRfqId: 'rfq-1',
    })
    const refunded = item({
      txid: 'funding-a',
      type: 'sent',
      activity: 'lightning',
      lightningState: 'refunded',
      lightningRfqId: 'rfq-1',
    })
    expect(isSamePayment(funding, claimed, SCOPE)).toBe(true)
    expect(isSamePayment(claimed, refunded, SCOPE)).toBe(true)
    expect(paymentIdentityForItem(funding, SCOPE).kind).toBe('lightning-rfq')
  })

  it('keeps the Bitcoin journal and its commitment transaction as one payment', () => {
    const journal = item({
      txid: 'bitcoin:op-1',
      type: 'sent',
      activity: 'bitcoin',
      bitcoinOperationId: 'op-1',
      bitcoinStage: 'submitted',
      confirmed: false,
    })
    const commitment = item({
      txid: 'commitment-txid',
      type: 'sent',
      activity: 'bitcoin',
      bitcoinOperationId: 'op-1',
      bitcoinStage: 'confirmed',
    })
    expect(isSamePayment(journal, commitment, SCOPE)).toBe(true)
  })

  it('keeps two equal-amount Lightning arrivals distinct', () => {
    const first = item({
      txid: 'funding-1',
      activity: 'lightning',
      lightningState: 'settled',
      lightningRfqId: 'rfq-1',
      amount: 500,
    })
    const second = item({
      txid: 'funding-2',
      activity: 'lightning',
      lightningState: 'settled',
      lightningRfqId: 'rfq-2',
      amount: 500,
    })
    expect(isSamePayment(first, second, SCOPE)).toBe(false)
  })

  it('scopes identity to network and vault', () => {
    const row = item({ txid: 'shared-txid', account: 'spend' })
    expect(paymentIdentityForItem(row, SCOPE).key).not.toBe(
      paymentIdentityForItem(row, { network: 'mainnet', vaultId: 'vault-1' }).key,
    )
    expect(paymentIdentityForItem(row, SCOPE).key).not.toBe(
      paymentIdentityForItem(row, { network: 'mutinynet', vaultId: 'vault-2' }).key,
    )
  })
})

describe('payment states', () => {
  it('uses verified Lightning outcomes and keeps incomplete funds out of arrivals', () => {
    expect(describePayment(item({ txid: 'a', activity: 'lightning', lightningState: 'claimed' })).state).toBe(
      'Received',
    )
    expect(describePayment(item({ txid: 'b', activity: 'lightning', lightningState: 'settled' })).state).toBe(
      'Received',
    )
    const processing = describePayment(
      item({ txid: 'c', type: 'sent', activity: 'lightning', lightningState: 'pending', confirmed: false }),
    )
    expect(processing.state).toBe('Processing')
    expect(processing.suppressArrival).toBe(true)
  })

  it('marks refundable and failed Lightning funds as needing attention with one safe retry', () => {
    const refundable = describePayment(
      item({
        txid: 'd',
        type: 'sent',
        activity: 'lightning',
        lightningState: 'needs_counterparty',
        lightningRfqId: 'rfq-9',
      }),
    )
    expect(refundable).toMatchObject({ state: 'Ready to return', attention: 'action', canRetry: true })
    const failed = describePayment(
      item({ txid: 'e', type: 'sent', activity: 'lightning', lightningState: 'failed', lightningRfqId: 'rfq-9' }),
    )
    expect(failed).toMatchObject({ state: 'Needs recovery', attention: 'check', canRetry: false })
  })

  it('never offers a retry for unknown or stale submissions', () => {
    const unknownBitcoin = describePayment(
      item({ txid: 'bitcoin:op-2', type: 'sent', activity: 'bitcoin', bitcoinOperationId: 'op-2', confirmed: false }),
    )
    expect(unknownBitcoin).toMatchObject({ state: 'Checking status', canRetry: false, attention: 'check' })
    const orphanRefund = describePayment(
      item({ txid: 'f', type: 'sent', activity: 'lightning', lightningState: 'needs_counterparty' }),
    )
    expect(orphanRefund.canRetry).toBe(false)
    const unknownLedger = describePayment(
      item({ txid: 'g', type: 'sent', account: 'savings', activity: 'savings-ledger', confirmed: false }),
    )
    expect(unknownLedger).toMatchObject({ state: 'Checking status', canRetry: false })
  })

  it('distinguishes broadcast Bitcoin sends from confirmation', () => {
    const sent = describePayment(
      item({
        txid: 'commitment',
        type: 'sent',
        activity: 'bitcoin',
        bitcoinOperationId: 'op-3',
        bitcoinStage: 'submitted',
        confirmed: false,
      }),
    )
    expect(sent.state).toBe('Sent · Awaiting confirmation')
    expect(sent.complete).toBe(false)
  })

  it('maps native Savings stages without offering retries', () => {
    const stages = [
      ['approval', 'Savings approval pending', 'action'],
      ['signer', 'Waiting for signer', 'action'],
      ['broadcast', 'Check or retry broadcast', 'check'],
      ['unknown', 'Checking status', 'check'],
    ] as const
    for (const [ledgerStage, state, attention] of stages) {
      const described = describePayment(
        item({
          txid: `ledger-${ledgerStage}`,
          type: 'sent',
          account: 'savings',
          activity: 'savings-ledger',
          ledgerStage,
          confirmed: false,
        }),
      )
      expect(described).toMatchObject({ state, attention, canRetry: false, suppressArrival: true })
    }
  })

  it('suppresses arrivals for internal movement while preserving account wording', () => {
    const handoff = describePayment(
      item({
        txid: 'pending-savings:1',
        type: 'sent',
        account: 'savings',
        activity: 'savings-handoff',
        confirmed: false,
      }),
    )
    expect(handoff).toMatchObject({ title: 'Waiting for hardware', suppressArrival: true, attention: 'action' })
    const outflow = describePayment(item({ txid: 'spend-out', type: 'sent', account: 'spend' }))
    expect(outflow.suppressArrival).toBe(true)
  })
})

describe('attention grouping', () => {
  it('surfaces unresolved funds first even when the backend reports them terminal', () => {
    const failed = item({
      txid: 'failed-terminal',
      type: 'sent',
      activity: 'lightning',
      lightningState: 'failed',
      lightningRfqId: 'rfq-failed',
      confirmed: true,
      blockTime: 1_700_000_000,
    })
    const ordinary = item({ txid: 'ordinary', blockTime: 1_700_000_100 })
    const groups = groupVaultHistory([ordinary, failed], 1_700_000_200)
    expect(groups[0]).toMatchObject({ key: 'attention', label: 'Needs attention' })
    expect(groups[0].items.map((row) => row.txid)).toEqual(['failed-terminal'])
  })
})
