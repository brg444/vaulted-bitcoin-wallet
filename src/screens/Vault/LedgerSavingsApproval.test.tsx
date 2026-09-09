import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'
import type { LedgerSavingsRegistration } from '../../lib/vault/ledgerClient'
import LedgerSavingsApproval from './LedgerSavingsApproval'

const client = vi.hoisted(() => ({ connect: vi.fn(), register: vi.fn(), sign: vi.fn(), close: vi.fn() }))
vi.mock('../../lib/vault/ledgerClient', () => ({
  connectLedgerSavings: client.connect,
  registerLedgerSavings: client.register,
  signLedgerSavings: client.sign,
}))
const payment = ledgerPaymentFixture().payment
const registration = { name: 'vaulted-ledger-registration' } as LedgerSavingsRegistration
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'hid', { configurable: true, value: {} })
  client.connect.mockResolvedValue({ app: {}, close: client.close })
  client.close.mockResolvedValue(undefined)
  client.register.mockResolvedValue(registration)
  client.sign.mockResolvedValue('signed-psbt')
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'hid')
})

it('shows one Ledger registration with no reserve or descriptor-entry steps', async () => {
  const saved = vi.fn().mockResolvedValue(undefined)
  render(<LedgerSavingsApproval mode='register' contract={payment.contract} onRegistered={saved} onBack={vi.fn()} />)
  fireEvent.click(screen.getByText('One setup, then ordinary payment approval'))
  expect(screen.getByText(/supplies them automatically/)).toBeVisible()
  expect(screen.queryByText(/reserve|500-sat|non-default|Import unsigned/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect and set up Ledger' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith(registration))
  await waitFor(() => expect(screen.getByText('Savings address verified.')).toBeVisible())
  expect(client.register).toHaveBeenCalledTimes(1)
  expect(client.close).toHaveBeenCalledTimes(1)
})

it('shows the actual payment and accepts one approval without a second sign button', async () => {
  const accepted = vi.fn().mockResolvedValue(undefined)
  render(
    <LedgerSavingsApproval
      mode='sign'
      payment={payment}
      phonePsbt='phone-psbt'
      registration={registration}
      onSigned={accepted}
      onBack={vi.fn()}
    />,
  )
  expect(screen.getByText(payment.destAddress)).toBeVisible()
  expect(screen.getByText('20,000 sats')).toBeVisible()
  expect(screen.getByText('1,000 sats')).toBeVisible()
  const button = screen.getByRole('button', { name: 'Approve with Ledger' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Return to your wallet' })).toBeEnabled())
  expect(client.sign).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Approve with Ledger' })).toBeNull()
})

it('shows cancellation without retrying or marking a payment pending', async () => {
  client.sign.mockRejectedValueOnce(new Error('device denied'))
  const accepted = vi.fn()
  render(
    <LedgerSavingsApproval
      mode='sign'
      payment={payment}
      phonePsbt='phone'
      registration={registration}
      onSigned={accepted}
      onBack={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Approve with Ledger' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Ledger approval was not completed')
  expect(client.sign).toHaveBeenCalledOnce()
  expect(accepted).not.toHaveBeenCalled()
  expect(client.close).toHaveBeenCalledOnce()
})

it('requires reconciliation if accepting an approval fails instead of signing again', async () => {
  render(
    <LedgerSavingsApproval
      mode='sign'
      payment={payment}
      phonePsbt='phone'
      registration={registration}
      onSigned={vi.fn().mockRejectedValue(new Error('lost response'))}
      onBack={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Approve with Ledger' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Return to your wallet to check this action')
  expect(screen.queryByRole('button', { name: 'Approve with Ledger' })).toBeNull()
})

it('explains unsupported browsers without offering connector funding as a fallback', () => {
  Reflect.deleteProperty(navigator, 'hid')
  render(<LedgerSavingsApproval mode='register' contract={payment.contract} onRegistered={vi.fn()} onBack={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Connect and set up Ledger' })).toBeDisabled()
  expect(screen.getByText(/supported desktop browser/)).toBeVisible()
  expect(client.connect).not.toHaveBeenCalled()
})

it('does not accept a stale device result after the payment changes', async () => {
  let finish: (value: string) => void = () => {}
  client.sign.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const accepted = vi.fn()
  const view = render(
    <LedgerSavingsApproval
      mode='sign'
      payment={payment}
      phonePsbt='phone'
      registration={registration}
      onSigned={accepted}
      onBack={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Approve with Ledger' }))
  await waitFor(() => expect(client.sign).toHaveBeenCalledOnce())
  view.rerender(
    <LedgerSavingsApproval
      mode='sign'
      payment={{ ...payment, amountSats: 21000 }}
      phonePsbt='different phone approval'
      registration={registration}
      onSigned={accepted}
      onBack={vi.fn()}
    />,
  )
  await act(async () => {
    finish('old approved psbt')
  })
  expect(accepted).not.toHaveBeenCalled()
  expect(client.close).toHaveBeenCalledOnce()
  expect(client.sign).toHaveBeenCalledOnce()
})
