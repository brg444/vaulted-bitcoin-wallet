import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import SpendingSignerFunding from './SpendingSignerFunding'
import type { VaultStatus } from '../../lib/vault/types'
import type { SavingsSetupPlan } from '../../lib/vault/savingsSetupStore'
const mocks = vi.hoisted(() => ({ fund: vi.fn() }))
vi.mock('../../lib/vault/enrollmentStore', () => ({ loadEnrollment: () => ({ vaultId: 'test' }) }))
vi.mock('../../lib/vault/connectorWithdrawal', () => ({ connectorContract: () => ({}) }))
vi.mock('../../lib/vault/program/connector', async (original) => ({
  ...(await original<typeof import('../../lib/vault/program/connector')>()),
  buildConnectorFamily: () => ({ connector: { address: 'bc1qenrolledsigner' } }),
}))
vi.mock('../../lib/vault/savingsSetupFunding', () => ({ fundSignerFromSpending: mocks.fund }))
const plan = { reserveSats: 500, reserveCount: 2, feeSats: 400 } as SavingsSetupPlan
beforeEach(() => mocks.fund.mockReset())
it('shows destination and the complete fee before one confirmation completes funding', async () => {
  const onFinished = vi.fn()
  let approved = false
  mocks.fund.mockImplementation(async (_e, _s, approve) => {
    approved = await approve(plan)
  })
  render(<SpendingSignerFunding status={{ vaultId: 'test' } as VaultStatus} onFinished={onFinished} />)
  await userEvent.click(screen.getByRole('button', { name: 'Fund from Spending' }))
  expect(await screen.findByText('To your signer: bc1qenrolledsigner')).toBeVisible()
  expect(screen.getByText('1400 sats')).toBeVisible()
  expect(approved).toBe(false)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm signer funding' }))
  expect(approved).toBe(true)
  expect(onFinished).toHaveBeenCalledOnce()
  expect(mocks.fund).toHaveBeenCalledOnce()
})
it('cancels an unapproved quote when the user leaves the screen', async () => {
  const decisions: boolean[] = []
  mocks.fund.mockImplementation(async (_e, _s, approve) => {
    decisions.push(await approve(plan))
  })
  const view = render(<SpendingSignerFunding status={{ vaultId: 'test' } as VaultStatus} onFinished={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Fund from Spending' }))
  await screen.findByText('Review signer funding')
  await act(async () => view.unmount())
  expect(decisions).toEqual([false])
})
