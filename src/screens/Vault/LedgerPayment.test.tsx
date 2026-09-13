import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { VaultTestProvider } from '../../test/fixtures/VaultTestProvider'
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'
import type { LedgerSavingsView } from '../../lib/vault/ledgerPayments'
import LedgerPayment from './LedgerPayment'

const view = {
  record: {
    version: 1,
    candidateId: 'retained-candidate',
    contextDigest: 'bound-context',
    phase: 'signing',
    phonePsbt: 'phone-approval',
    payment: ledgerPaymentFixture().payment,
  },
  registration: {},
  outcome: 'signing',
} as LedgerSavingsView
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'hid', { configurable: true, value: {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'hid')
})
it('requests the retained candidate from the owner and cancels device demand on unmount', () => {
  const approveWithLedger = vi.fn().mockResolvedValue('retained-candidate')
  const cancelHardware = vi.fn()
  const shown = render(
    <VaultTestProvider ledgerPayment={{ view, approveWithLedger, cancelHardware }}>
      <LedgerPayment />
    </VaultTestProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Approve with Ledger' }))
  expect(approveWithLedger).toHaveBeenCalledExactlyOnceWith('retained-candidate')
  shown.unmount()
  expect(cancelHardware).toHaveBeenCalledOnce()
})
it('shows a saved signature awaiting dispatch without another signing action', () => {
  render(
    <VaultTestProvider
      ledgerPayment={{
        view: { ...view, record: { ...view.record, txHex: 'signed-transaction' } },
        pending: 'hardware',
        hardwarePhase: 'saving',
      }}
    >
      <LedgerPayment />
    </VaultTestProvider>,
  )
  expect(screen.getByText('Submitting your payment')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Approve with Ledger' })).toBeNull()
})
it('retains an uncertain signed payment for checking through its history', () => {
  render(
    <VaultTestProvider
      ledgerPayment={{
        view: { ...view, record: { ...view.record, txHex: 'signed-transaction' } },
        hardwarePhase: 'check',
        error: 'Submission status is unknown.',
      }}
    >
      <LedgerPayment />
    </VaultTestProvider>,
  )
  expect(screen.getByText('Check your saved payment')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('Submission status is unknown.')
  expect(screen.queryByRole('button', { name: 'Approve with Ledger' })).toBeNull()
})
