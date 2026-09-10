import { TxType, type Activity, type ArkTransaction } from '@arkade-os/sdk'
import { describe, expect, it } from 'vitest'
import {
  classifyAddressTx,
  groupVaultHistory,
  historyFromBoardingUtxos,
  historyFromSdkActivities,
  historyFromTxs,
  mergeVaultHistory,
  recentAccountHistory,
  type VaultHistoryItem,
} from './history'
import type { EsploraTx } from './esplora'

const ADDRESS = 'tb1pspend'

function tx(partial: Partial<EsploraTx> & { txid: string }): EsploraTx {
  return {
    vin: [],
    vout: [],
    status: { confirmed: true, block_time: 1 },
    ...partial,
  }
}

describe('vault history', () => {
  const sdkTx = (
    txid: string,
    type: TxType,
    amount: number,
    settled = true,
    createdAt = 1_700_000_000_000,
  ): ArkTransaction => ({
    key: { arkTxid: txid, commitmentTxid: '', boardingTxid: '' },
    type,
    amount,
    settled,
    createdAt,
  })

  it('projects only script-scoped SDK activity and leaves boarding on its existing feed', () => {
    const vault = sdkTx('vault-send', TxType.TxSent, 12_000, false)
    const unrelated = sdkTx('default-receive', TxType.TxReceived, 30_000)
    const boarding = sdkTx('boarding', TxType.TxReceived, 40_000)
    boarding.key.arkTxid = ''
    boarding.key.boardingTxid = 'boarding'
    const activities: Activity[] = [
      { id: 'vault-send', txs: [vault], amount: -12_000, createdAt: vault.createdAt, settled: false },
      { id: 'default-receive', txs: [unrelated], amount: 30_000, createdAt: unrelated.createdAt, settled: true },
      {
        id: 'boarding:boarding',
        intent: { kind: 'boarding', label: 'Deposit' },
        txs: [boarding],
        amount: 40_000,
        createdAt: boarding.createdAt,
        settled: true,
      },
    ]

    expect(
      historyFromSdkActivities(activities, {
        vaultTxids: new Set(['vault-send', 'boarding']),
        lightningRfqIds: new Set(),
      }),
    ).toEqual([
      {
        txid: 'vault-send',
        type: 'sent',
        amount: 12_000,
        confirmed: true,
        blockTime: 1_700_000_000,
        account: 'spend',
      },
    ])
  })

  it('does not put spendable Arkade VTXO payments in Pending', () => {
    const vault = sdkTx('vault-receive', TxType.TxReceived, 12_000, false)
    const rows = historyFromSdkActivities(
      [{ id: 'vault-receive', txs: [vault], amount: 12_000, createdAt: vault.createdAt, settled: false }],
      { vaultTxids: new Set(['vault-receive']), lightningRfqIds: new Set() },
    )
    expect(rows[0]?.confirmed).toBe(true)
    expect(groupVaultHistory(rows, 1_700_000_000)[0].label).toBe('Today')
  })

  it('uses a settled SDK boarding activity in the v2 dated feed', () => {
    const boarding = sdkTx('boarding', TxType.TxReceived, 40_000, true)
    boarding.key.arkTxid = ''
    boarding.key.boardingTxid = 'boarding'
    const activity: Activity = {
      id: 'boarding:boarding',
      intent: { kind: 'boarding', label: 'Deposit' },
      txs: [boarding],
      amount: 40_000,
      createdAt: boarding.createdAt,
      settled: true,
    }

    const rows = historyFromSdkActivities([activity], { vaultTxids: new Set(), lightningRfqIds: new Set() }, [], {
      includeBoarding: true,
    })
    expect(rows).toEqual([
      {
        txid: 'boarding',
        type: 'received',
        amount: 40_000,
        confirmed: true,
        blockTime: 1_700_000_000,
        account: 'spend',
        activity: 'boarding',
      },
    ])
    expect(groupVaultHistory(rows, 1_700_000_000)[0].label).toBe('Today')
  })

  it('keeps an unsettled SDK boarding activity pending', () => {
    const boarding = sdkTx('boarding-pending', TxType.TxReceived, 40_000, false)
    boarding.key.arkTxid = ''
    boarding.key.boardingTxid = 'boarding-pending'
    const activity: Activity = {
      id: 'boarding:boarding-pending',
      intent: { kind: 'boarding', label: 'Deposit' },
      txs: [boarding],
      amount: 40_000,
      createdAt: boarding.createdAt,
      settled: false,
    }

    const rows = historyFromSdkActivities([activity], { vaultTxids: new Set(), lightningRfqIds: new Set() }, [], {
      includeBoarding: true,
    })
    expect(rows).toEqual([
      expect.objectContaining({
        txid: 'boarding-pending',
        confirmed: false,
        activity: 'boarding',
      }),
    ])
    expect(groupVaultHistory(rows, 1_700_000_000)[0].label).toBe('Pending')
  })

  it('admits only this vault’s RFQ group and preserves its package outcome', () => {
    const funding = sdkTx('funding', TxType.TxSent, 2_107)
    const refund = sdkTx('refund', TxType.TxReceived, 2_100)
    const activities: Activity[] = [
      {
        id: 'swap:rfq-1',
        intent: {
          kind: 'swap',
          outcome: 'refunded',
          metadata: { rfqId: 'rfq-1', swapKind: 'lightning_send' },
        },
        txs: [funding, refund],
        amount: -7,
        createdAt: funding.createdAt,
        settled: true,
      },
    ]

    expect(
      historyFromSdkActivities(activities, {
        vaultTxids: new Set(),
        lightningRfqIds: new Set(['rfq-1']),
      }),
    ).toEqual([
      {
        txid: 'funding',
        type: 'sent',
        amount: 7,
        confirmed: true,
        blockTime: 1_700_000_000,
        account: 'spend',
        activity: 'lightning',
        lightningState: 'refunded',
        lightningRfqId: 'rfq-1',
      },
    ])
  })

  it('shows a funded RFQ record with no SDK activity, then replaces it with the resolved group', () => {
    const rfqId = 'ab'.repeat(32)
    const fundingTxid = 'cd'.repeat(32)
    const record = {
      rfqId,
      fundingTxid,
      state: 'pending',
      amount: 2_107,
      displayAmount: 2_100,
      fee: 32,
      createdAt: 1_700_000_000,
      terminal: false,
    }
    const scope = { vaultTxids: new Set<string>(), lightningRfqIds: new Set([rfqId]) }

    expect(historyFromSdkActivities([], scope, [record])).toEqual([
      {
        txid: fundingTxid,
        type: 'sent',
        amount: 2_107,
        confirmed: false,
        blockTime: 1_700_000_000,
        account: 'spend',
        activity: 'lightning',
        displayAmount: 2_100,
        fee: 32,
        lightningState: 'pending',
        lightningRfqId: rfqId,
      },
    ])

    const funding = sdkTx(fundingTxid, TxType.TxSent, 2_107)
    const refund = sdkTx('ef'.repeat(32), TxType.TxReceived, 2_100)
    const resolved: Activity = {
      id: `swap:${rfqId}`,
      intent: {
        kind: 'swap',
        outcome: 'refunded',
        metadata: { rfqId, swapKind: 'lightning_send' },
      },
      txs: [funding, refund],
      amount: -7,
      createdAt: funding.createdAt,
      settled: true,
    }
    const rows = historyFromSdkActivities([resolved], scope, [{ ...record, state: 'refunded', terminal: true }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      txid: fundingTxid,
      amount: 7,
      confirmed: true,
      blockTime: 1_700_000_000,
      account: 'spend',
      type: 'sent',
      activity: 'lightning',
      displayAmount: 2_100,
      fee: 7,
      lightningState: 'refunded',
      lightningRfqId: rfqId,
    })
  })

  it('shows an incoming receipt once despite zero-net SDK accounting or an ungrouped payout', () => {
    const rfqId = 'ab'.repeat(32),
      txid = 'cd'.repeat(32)
    const record = {
      rfqId,
      fundingTxid: txid,
      type: 'received' as const,
      state: 'settled',
      amount: 500,
      displayAmount: 500,
      fee: 4,
      createdAt: 1_700_000_000,
      terminal: true,
    }
    const scope = { vaultTxids: new Set([txid]), lightningRfqIds: new Set([rfqId]) }
    const payout: Activity = {
      id: txid,
      txs: [sdkTx(txid, TxType.TxReceived, 500)],
      amount: 500,
      createdAt: 1_700_000_000_000,
      settled: false,
    }
    const group: Activity = {
      ...payout,
      amount: 0,
      intent: { kind: 'swap', outcome: 'pending', metadata: { rfqId, swapKind: 'lightning_receive' } },
    }
    for (const activities of [[], [payout], [group], [group, payout]]) {
      const rows = historyFromSdkActivities(activities, scope, [record])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        txid,
        type: 'received',
        amount: 500,
        displayAmount: 500,
        fee: 4,
        confirmed: true,
        lightningState: 'settled',
        lightningRfqId: rfqId,
      })
    }
    expect(historyFromSdkActivities([group], { vaultTxids: new Set(), lightningRfqIds: new Set() }, [record])).toEqual(
      [],
    )
  })

  it('shows unspent boarding outputs as one pending Spending receive per transaction', () => {
    const rows = historyFromBoardingUtxos([
      { txid: 'boarding', vout: 0, value: 40_000, status: { confirmed: true } },
      { txid: 'boarding', vout: 1, value: 10_000, status: { confirmed: true } },
      { txid: 'boarding', vout: 1, value: 10_000, status: { confirmed: true } },
    ])

    expect(rows).toEqual([
      {
        txid: 'boarding',
        type: 'received',
        amount: 50_000,
        confirmed: false,
        account: 'spend',
        activity: 'boarding',
      },
    ])
    expect(groupVaultHistory(rows)[0].label).toBe('Pending')
  })

  it('keeps one pending boarding row when Esplora also reports the confirmed deposit', () => {
    const rows = mergeVaultHistory(
      [
        {
          txid: 'b8ed',
          type: 'received',
          amount: 33_458,
          confirmed: true,
          blockTime: 1_700_000_000,
          account: 'spend',
        },
        {
          txid: 'b8ed',
          type: 'received',
          amount: 33_458,
          confirmed: true,
          blockTime: 1_700_000_000,
          account: 'spend',
        },
      ],
      historyFromBoardingUtxos([{ txid: 'b8ed', vout: 0, value: 33_458, status: { confirmed: true } }]),
    )
    expect(rows).toEqual([
      {
        txid: 'b8ed',
        type: 'received',
        amount: 33_458,
        confirmed: false,
        account: 'spend',
        activity: 'boarding',
      },
    ])
    expect(groupVaultHistory(rows)[0].label).toBe('Pending')
  })

  it('treats an incoming output as received', () => {
    const item = classifyAddressTx(
      tx({
        txid: 'in',
        vout: [{ scriptpubkey_address: ADDRESS, value: 20_000 }],
      }),
      ADDRESS,
    )
    expect(item).toMatchObject({ type: 'received', amount: 20_000, txid: 'in' })
  })

  it('nets change on a send', () => {
    const item = classifyAddressTx(
      tx({
        txid: 'out',
        vin: [{ prevout: { scriptpubkey_address: ADDRESS, value: 50_000 } }],
        vout: [
          { scriptpubkey_address: 'tb1pdest', value: 19_500 },
          { scriptpubkey_address: ADDRESS, value: 30_000 },
        ],
      }),
      ADDRESS,
    )
    expect(item).toMatchObject({ type: 'sent', amount: 20_000 })
  })

  it('ignores unrelated transactions', () => {
    expect(
      classifyAddressTx(
        tx({
          txid: 'other',
          vout: [{ scriptpubkey_address: 'tb1pother', value: 1 }],
        }),
        ADDRESS,
      ),
    ).toBeNull()
  })

  it('puts unconfirmed first, then newest', () => {
    const rows: VaultHistoryItem[] = historyFromTxs(
      [
        tx({
          txid: 'old',
          vout: [{ scriptpubkey_address: ADDRESS, value: 1 }],
          status: { confirmed: true, block_time: 10 },
        }),
        tx({
          txid: 'new',
          vout: [{ scriptpubkey_address: ADDRESS, value: 2 }],
          status: { confirmed: true, block_time: 20 },
        }),
        tx({ txid: 'mem', vout: [{ scriptpubkey_address: ADDRESS, value: 3 }], status: { confirmed: false } }),
      ],
      ADDRESS,
      'spend',
    )
    expect(rows.map((row) => row.txid)).toEqual(['mem', 'new', 'old'])
  })

  it('deduplicates a transaction while preferring its confirmed state', () => {
    const rows = historyFromTxs(
      [
        tx({ txid: 'same', vout: [{ scriptpubkey_address: ADDRESS, value: 4_000 }], status: { confirmed: false } }),
        tx({
          txid: 'same',
          vout: [{ scriptpubkey_address: ADDRESS, value: 4_000 }],
          status: { confirmed: true, block_time: 30 },
        }),
      ],
      ADDRESS,
      'savings',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ txid: 'same', confirmed: true, blockTime: 30 })
  })

  it('groups pending activity before local calendar dates', () => {
    const now = new Date(2026, 7, 23, 12, 0)
    const at = (day: number, hour = 12) => Math.floor(new Date(2026, 7, day, hour, 0).getTime() / 1000)
    const item = (txid: string, confirmed: boolean, blockTime?: number): VaultHistoryItem => ({
      txid,
      type: 'received',
      amount: 1,
      confirmed,
      blockTime,
      account: 'spend',
    })

    const groups = groupVaultHistory(
      [
        item('pending', false),
        item('today', true, at(23)),
        item('yesterday', true, at(22)),
        item('older-a', true, at(8, 15)),
        item('older-b', true, at(8, 9)),
      ],
      Math.floor(now.getTime() / 1000),
    )

    expect(groups.map((group) => group.label)).toEqual(['Pending', 'Today', 'Yesterday', 'August 8'])
    expect(groups.at(-1)?.items.map((row) => row.txid)).toEqual(['older-a', 'older-b'])
  })

  it('sorts unsorted rows deterministically before grouping them', () => {
    const rows: VaultHistoryItem[] = [
      { txid: 'z', type: 'received', amount: 1, confirmed: true, blockTime: 10, account: 'savings' },
      { txid: 'b', type: 'received', amount: 1, confirmed: false, account: 'savings' },
      { txid: 'a', type: 'received', amount: 1, confirmed: false, account: 'savings' },
    ]

    expect(groupVaultHistory(rows, 20)[0].items.map((row) => row.txid)).toEqual(['a', 'b'])
  })

  it('bounds one account to its newest activity before Home renders it', () => {
    const rows: VaultHistoryItem[] = Array.from({ length: 105 }, (_, index) => ({
      txid: `spend-${index}`,
      type: 'received',
      amount: 1,
      confirmed: true,
      blockTime: index + 1,
      account: 'spend',
    }))
    rows.push({
      txid: 'savings',
      type: 'received',
      amount: 1,
      confirmed: true,
      blockTime: 1_000,
      account: 'savings',
    })

    const recent = recentAccountHistory(rows, 'spend')

    expect(recent).toHaveLength(100)
    expect(recent[0].txid).toBe('spend-104')
    expect(recent.at(-1)?.txid).toBe('spend-5')
  })
})
