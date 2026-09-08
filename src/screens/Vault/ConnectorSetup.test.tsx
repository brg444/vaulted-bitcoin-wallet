import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import ConnectorSetup from './ConnectorSetup'
import type { VaultStatus } from '../../lib/vault/types'

vi.mock('../../lib/vault/spendingBitcoinFunding', () => ({
  readSpendingBitcoin: () => null,
  supportsSpendingBitcoin: async () => false,
  checkSpendingBitcoin: vi.fn(),
}))

const check = vi.hoisted(() => vi.fn())
vi.mock('../../lib/vault/connectorSetup', () => ({ checkConnectorSetup: check }))
vi.mock('../../components/QrCode', () => ({
  default: ({ value }: { value: string }) => <div data-testid='qr'>{value}</div>,
}))
const empty = {
  state: 'checked',
  address: 'bc1qsigner',
  amount: 500,
  required: 2,
  confirmed: 0,
  pending: 0,
  missing: 2,
}
const status = {} as VaultStatus
beforeEach(() => {
  vi.resetAllMocks()
  check.mockResolvedValue(empty)
})
const open = (onDeposit = vi.fn()) => render(<ConnectorSetup status={status} onBack={vi.fn()} onDeposit={onDeposit} />)

it('requests individual exact-value payments and removes the request once all outputs are visible', async () => {
  const user = userEvent.setup()
  open()
  expect((await screen.findByTestId('qr')).textContent).toBe('bitcoin:bc1qsigner?amount=0.00000500')
  await user.click(screen.getByText('Use an external Bitcoin wallet'))
  await user.click(screen.getByRole('button', { name: 'I’ve sent the payment' }))
  expect(screen.queryByTestId('qr')).toBeNull()
  check.mockResolvedValue({ ...empty, pending: 2, missing: 0 })
  await user.click(screen.getByRole('button', { name: 'Check status' }))
  expect(await screen.findByText(/no further payment is needed/)).toBeTruthy()
  expect(screen.queryByTestId('qr')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  check.mockResolvedValue({ ...empty, confirmed: 2, missing: 0 })
  await user.click(screen.getByRole('button', { name: 'Check status' }))
  expect(await screen.findByRole('heading', { name: 'Your signer is ready' })).toBeTruthy()
})

it('keeps an existing prepared deposit accessible without showing another funding request', async () => {
  check.mockResolvedValue({ state: 'deposit' })
  const onDeposit = vi.fn()
  open(onDeposit)
  await userEvent.click(await screen.findByRole('button', { name: 'Continue prepared deposit' }))
  expect(onDeposit).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('qr')).toBeNull()
})

it('hides stale payment requests when a recheck fails', async () => {
  open()
  await screen.findByTestId('qr')
  check.mockRejectedValue(new Error('Could not load coins'))
  await userEvent.click(screen.getByRole('button', { name: 'Check status' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load coins')
  expect(screen.queryByTestId('qr')).toBeNull()
})

it('does not reset signer setup when a balance refresh updates the same vault', async () => {
  const view = render(<ConnectorSetup status={{ ...status, vaultId: 'same' }} onBack={vi.fn()} onDeposit={vi.fn()} />)
  await screen.findByTestId('qr')
  await userEvent.click(screen.getByText('Use an external Bitcoin wallet'))
  view.rerender(
    <ConnectorSetup status={{ ...status, vaultId: 'same', periodSpent: 1000 }} onBack={vi.fn()} onDeposit={vi.fn()} />,
  )
  expect(screen.getByTestId('qr')).toBeVisible()
  expect(check).toHaveBeenCalledTimes(1)
})
