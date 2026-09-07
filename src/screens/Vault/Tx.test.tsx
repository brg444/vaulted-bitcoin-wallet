import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultTx from './Tx'

function renderTx(selectedTx: VaultContextProps['selectedTx'], network = 'mutinynet') {
  const retryLightningRefund = vi.fn(async () => {})
  render(
    <VaultContext.Provider
      value={
        {
          navigate: vi.fn(),
          retryLightningRefund,
          selectedTx,
          status: { network },
        } as unknown as VaultContextProps
      }
    >
      <VaultTx />
    </VaultContext.Provider>,
  )
  fireEvent.click(screen.getByText(/View (funding )?transaction$/))
  return { retryLightningRefund }
}

describe('Vault transaction details', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses pending language and links Spending activity to Arkade Space', () => {
    renderTx({
      txid: 'ark-transaction',
      type: 'received',
      amount: 12_000,
      confirmed: false,
      blockTime: 10,
      account: 'spend',
    })

    expect(screen.getByRole('img', { name: 'Pending status' })).toHaveClass('lucide-clock3')
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)
    expect(screen.getByText('Mutinynet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View on Arkade Space' })).toHaveAttribute(
      'href',
      'https://explorer.mutinynet.arkade.sh/tx/ark-transaction',
    )
  })

  it('uses Bitcoin confirmation language and links Savings transactions', () => {
    renderTx({
      txid: 'bitcoin-transaction',
      type: 'sent',
      amount: 8_000,
      confirmed: true,
      blockTime: 10,
      account: 'savings',
    })

    expect(screen.getByRole('img', { name: 'Confirmed status' })).toHaveClass('lucide-circle-check')
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'View on Bitcoin explorer' })).toHaveAttribute(
      'href',
      'https://mempool.mutinynet.arkade.sh/tx/bitcoin-transaction',
    )
  })

  it('keeps boarding activity pending and links it to the Bitcoin transaction', () => {
    renderTx({
      txid: 'boarding-transaction',
      type: 'received',
      amount: 50_000,
      confirmed: false,
      account: 'spend',
      activity: 'boarding',
    })

    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'View on Bitcoin explorer' })).toHaveAttribute(
      'href',
      'https://mempool.mutinynet.arkade.sh/tx/boarding-transaction',
    )
  })

  it('shows settled boarding activity as confirmed', () => {
    renderTx({
      txid: 'settled-boarding-transaction',
      type: 'received',
      amount: 50_000,
      confirmed: true,
      account: 'spend',
      activity: 'boarding',
    })

    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0)
    expect(screen.queryByText('Pending')).toBeNull()
  })

  it('offers one passkey-backed return action only when the package says a refund is due', () => {
    const { retryLightningRefund } = renderTx({
      txid: 'ark-lightning-funding',
      type: 'sent',
      amount: 2_125,
      displayAmount: 2_100,
      confirmed: true,
      account: 'spend',
      activity: 'lightning',
      lightningState: 'needs_counterparty',
      lightningRfqId: 'rfq-1',
    })

    expect(screen.getAllByText('Ready to return').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Return to Spending' }))
    expect(retryLightningRefund).toHaveBeenCalledExactlyOnceWith('rfq-1')
  })

  it('describes a terminal failed Lightning payment as needing recovery', () => {
    renderTx({
      txid: 'ark-lightning-failed',
      type: 'sent',
      amount: 2_125,
      confirmed: true,
      account: 'spend',
      activity: 'lightning',
      lightningState: 'failed',
      lightningRfqId: 'rfq-failed',
    })

    expect(screen.getAllByText('Needs recovery').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Return to Spending' })).toBeNull()
  })
})

it.each([
  ['spend', undefined, 'https://arkade.space/tx/'],
  ['savings', undefined, 'https://mempool.space/tx/'],
  ['spend', 'boarding', 'https://mempool.space/tx/'],
] as const)('shows a full mainnet transaction reference for %s %s', (account, activity, base) => {
  const txid = 'ab'.repeat(32)
  renderTx({ txid, type: 'received', amount: 12000, confirmed: true, account, activity }, 'mainnet')
  expect(screen.getByText(txid)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Copy transaction ID' })).toBeVisible()
  expect(screen.getByRole('link')).toHaveAttribute('href', base + txid)
})

it.each([
  ['claimed', 'Paid', 'lucide-circle-check'],
  ['settled', 'Paid', 'lucide-circle-check'],
  ['refunded', 'Refunded', 'lucide-circle-check'],
  ['needs_counterparty', 'Ready to return', 'lucide-circle-alert'],
  ['failed', 'Needs recovery', 'lucide-circle-alert'],
  ['funded', 'Processing', 'lucide-clock3'],
])('uses the Lightning outcome for %s even after the funding transaction settles', (lightningState, label, icon) => {
  renderTx(
    {
      txid: 'ab'.repeat(32),
      type: 'sent',
      amount: 12000,
      confirmed: true,
      account: 'spend',
      activity: 'lightning',
      lightningState,
    },
    'mainnet',
  )
  expect(screen.getByRole('img', { name: `${label} status` })).toHaveClass(icon)
  expect(screen.queryByText('This payment is confirmed.')).toBeNull()
  expect(screen.getByText('Funding transaction ID')).toBeVisible()
})
