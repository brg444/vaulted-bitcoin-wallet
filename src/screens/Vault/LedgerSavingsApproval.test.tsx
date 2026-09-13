import { renderVault as render } from '../../test/fixtures/renderVault'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'
import LedgerSavingsApproval from './LedgerSavingsApproval'

const payment = ledgerPaymentFixture().payment
const controls = () => ({
  onApprove: vi.fn().mockResolvedValue(undefined),
  onBack: vi.fn(),
  busy: false,
  phase: 'idle' as const,
  error: '',
})
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'hid', { configurable: true, value: {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'hid')
})
it('shows one registration action supplied by the session owner', () => {
  const props = controls()
  render(<LedgerSavingsApproval mode='register' {...props} />)
  fireEvent.click(screen.getByText('One setup, then ordinary payment approval'))
  expect(screen.getByText(/supplies them automatically/)).toBeVisible()
  expect(screen.queryByText(/reserve|500-sat|non-default|Import unsigned/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect and set up Ledger' }))
  expect(props.onApprove).toHaveBeenCalledOnce()
})
it('shows the retained recipient, amount and fee before requesting the owner approval', () => {
  const props = controls()
  const view = render(<LedgerSavingsApproval mode='sign' payment={payment} {...props} />)
  expect(screen.getByText(payment.destAddress)).toBeVisible()
  expect(screen.getByText('20,000 sats')).toBeVisible()
  expect(screen.getByText('1,000 sats')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Approve with Ledger' }))
  expect(props.onApprove).toHaveBeenCalledOnce()
  view.rerender(<LedgerSavingsApproval mode='sign' payment={payment} {...props} phase='approving' busy />)
  expect(screen.getByRole('button', { name: 'Check your Ledger…' })).toBeDisabled()
  expect(screen.getByText(/Check the recipient, amount and fee/)).toBeVisible()
})
it('requires checking a saved approval after a persistence or dispatch failure', () => {
  const props = controls()
  render(
    <LedgerSavingsApproval
      mode='sign'
      payment={payment}
      {...props}
      phase='check'
      error='Submission status is unknown.'
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Submission status is unknown.')
  expect(screen.getByText(/Return to your wallet to check this action/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Approve with Ledger' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Return to your wallet' }))
  expect(props.onBack).toHaveBeenCalledOnce()
  expect(props.onApprove).not.toHaveBeenCalled()
})
it('offers another request after a rejected device approval', () => {
  const props = controls()
  render(<LedgerSavingsApproval mode='sign' payment={payment} {...props} error='Ledger approval was not completed.' />)
  expect(screen.getByRole('alert')).toHaveTextContent('Ledger approval was not completed.')
  expect(screen.getByRole('button', { name: 'Approve with Ledger' })).toBeEnabled()
})
it('reports successful registration without another approval button', () => {
  render(<LedgerSavingsApproval mode='register' {...controls()} phase='complete' />)
  expect(screen.getByText('Savings address verified.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Connect and set up Ledger' })).toBeNull()
})
it('explains unsupported browsers without requesting a device', () => {
  Reflect.deleteProperty(navigator, 'hid')
  const props = controls()
  render(<LedgerSavingsApproval mode='register' {...props} />)
  expect(screen.getByRole('button', { name: 'Connect and set up Ledger' })).toBeDisabled()
  expect(screen.getByText(/supported desktop browser/)).toBeVisible()
  expect(props.onApprove).not.toHaveBeenCalled()
})
