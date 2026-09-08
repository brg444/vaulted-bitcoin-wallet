import { Address, TEST_NETWORK } from '@scure/btc-signer'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultReview from './Review'
import { DUAL_CONNECTOR_TEMPLATE } from '../../lib/vault/program/connector'

function review(overrides: Partial<VaultContextProps> = {}) {
  const value = {
    account: 'spend',
    busy: false,
    error: '',
    spend: { amount: 12000, fee: 240, address: `tark1${'a'.repeat(90)}` },
    status: { network: 'mutinynet' },
    navigate: vi.fn(),
    approveSend: vi.fn(),
    ...overrides,
  } as unknown as VaultContextProps
  const tree = (state: VaultContextProps) => (
    <ToastProvider>
      <VaultContext.Provider value={state}>
        <VaultReview />
      </VaultContext.Provider>
    </ToastProvider>
  )
  const result = render(tree(value))
  return { value, rerender: (patch: Partial<VaultContextProps>) => result.rerender(tree({ ...value, ...patch })) }
}

describe('payment review continuity', () => {
  it('locks editing and approval while busy, then restores the original review after cancellation', () => {
    const { value, rerender } = review({ busy: true })
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
    for (const name of ['Edit amount', 'Edit', 'Completing payment…']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(value.navigate).not.toHaveBeenCalled()
    expect(value.approveSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(screen.getByText(value.spend.address)).toBeVisible()
    rerender({ busy: false })
    expect(screen.getByRole('button', { name: 'Edit amount' })).toBeEnabled()
    expect(screen.getByText('Total').parentElement).toHaveTextContent('₿12,240')
    fireEvent.click(screen.getByRole('button', { name: 'Approve payment' }))
    expect(value.approveSend).toHaveBeenCalledOnce()
  })

  it('keeps the saved operation immutable while allowing destination verification', () => {
    const { value } = review({ resumingPayment: true })
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(screen.getByText(value.spend.address)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Continue payment' }))
    expect(value.approveSend).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(value.navigate).toHaveBeenCalledWith('home')
  })

  it.each([false, true])('preserves the fixed Bitcoin outputs across approval, busy=%s', (busy) => {
    const address = Address(TEST_NETWORK).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(0x43) })
    const { value } = review({
      busy,
      spend: { address, amount: 1000, fee: 400 },
      bitcoinOutputs: [
        { script: '0014' + '43'.repeat(20), amountSats: 500 },
        { script: '0014' + '43'.repeat(20), amountSats: 500 },
      ],
    })
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.getByText('2 separate Bitcoin outputs: 500 sats + 500 sats.')).toBeVisible()
    expect(screen.getByText('Total').parentElement).toHaveTextContent('₿1,400')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(screen.getByText(address)).toBeVisible()
    if (busy) {
      expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Completing payment…' })).toBeDisabled()
      expect(value.approveSend).not.toHaveBeenCalled()
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Bitcoin payment' }))
      expect(value.approveSend).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
      expect(value.navigate).toHaveBeenCalledWith('home')
    }
  })

  it.each([false, true])('retains the Savings amount during approval, hardware first=%s', (hardwareFirst) => {
    const { value } = review({
      account: 'savings',
      busy: true,
      status: { templateVersion: hardwareFirst ? DUAL_CONNECTOR_TEMPLATE : undefined } as VaultContextProps['status'],
    })
    expect(document.querySelector('.qg-review-amount strong')).toHaveTextContent('₿12,000')
    expect(
      screen.getByRole('heading', { name: hardwareFirst ? 'Preparing approval' : 'Approve with passkey' }),
    ).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
    expect(value.approveSend).not.toHaveBeenCalled()
  })
})
