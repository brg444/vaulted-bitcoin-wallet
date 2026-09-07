import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultSuccess from './Success'

function renderSuccess(lastTxKind: VaultContextProps['lastTxKind'], network = 'mutinynet') {
  render(
    <VaultContext.Provider
      value={
        {
          boardingAddress: 'tb1pboarding',
          lastSend: { address: 'tark1destination', amount: 12_000, fee: 0 },
          lastTxid: 'transaction-id',
          lastTxKind,
          navigate: vi.fn(),
          status: { network },
        } as unknown as VaultContextProps
      }
    >
      <VaultSuccess />
    </VaultContext.Provider>,
  )
  fireEvent.click(screen.getByText(/View (funding )?transaction$/))
}

describe('Vault send success explorer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('links a VTXO send to Arkade Space', () => {
    renderSuccess('vtxo')

    expect(screen.getByText('Payment sent')).toBeInTheDocument()
    expect(screen.getByText('Fast transfer complete')).toBeInTheDocument()
    expect(screen.getByText('Transaction ID')).toBeInTheDocument()
    expect(screen.getByText('Mutinynet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View on Arkade Space' })).toHaveAttribute(
      'href',
      'https://explorer.mutinynet.arkade.sh/tx/transaction-id',
    )
  })

  it('links an onchain send to the Bitcoin explorer', () => {
    renderSuccess('onchain')

    expect(screen.getByText('Savings transfer submitted')).toBeInTheDocument()
    expect(screen.getByText('Bitcoin confirmation is next')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View on Bitcoin explorer' })).toHaveAttribute(
      'href',
      'https://mempool.mutinynet.arkade.sh/tx/transaction-id',
    )
  })

  it('reports Lightning funding as started and links its VTXO transaction', () => {
    renderSuccess('lightning')

    expect(screen.getByText('Payment started')).toBeInTheDocument()
    expect(screen.getByText('Quote accepted. The Lightning payment is completing.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View on Arkade Space' })).toHaveAttribute(
      'href',
      'https://explorer.mutinynet.arkade.sh/tx/transaction-id',
    )
  })
})

it.each([
  ['vtxo', 'https://arkade.space/tx/transaction-id'],
  ['onchain', 'https://mempool.space/tx/transaction-id'],
  ['lightning', 'https://arkade.space/tx/transaction-id'],
] as const)('shows the full identifier and mainnet explorer after %s sends', (kind, url) => {
  renderSuccess(kind, 'mainnet')
  expect(screen.getByText('transaction-id')).toBeVisible()
  expect(screen.getByRole('link')).toHaveAttribute('href', url)
  expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
})
