import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import WalletScreen from './WalletScreen'
import { VaultContext, type VaultContextProps } from '../../../vault/context'

it('keeps an in-progress form mounted while Help opens and closes', () => {
  const dismiss = vi.fn()
  render(
    <WalletScreen title='Send' dismiss={dismiss}>
      <input aria-label='Draft destination' />
    </WalletScreen>,
  )
  const input = screen.getByLabelText('Draft destination')
  fireEvent.change(input, { target: { value: 'saved-destination' } })
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(screen.getByRole('dialog')).toBeVisible()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(dismiss).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close help' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByLabelText('Draft destination')).toBe(input)
  expect(input).toHaveValue('saved-destination')
  expect(screen.getByRole('button', { name: 'Help' })).toHaveFocus()
})

it('renders onboarding progress from the current protection choice without changing the layout labels', () => {
  const view = (advanced: boolean, stepLabel: string) => (
    <VaultContext.Provider
      value={{ setup: { protectionTier: advanced ? 'advanced' : 'standard' } } as VaultContextProps}
    >
      <WalletScreen title='Review setup' stepLabel={stepLabel}>
        <p>Review your choices</p>
      </WalletScreen>
    </VaultContext.Provider>
  )
  const { rerender } = render(view(false, '5 of 6'))
  expect(screen.getByText('4 of 6')).toBeVisible()
  rerender(view(true, '5 of 6'))
  expect(screen.getByText('5 of 7')).toBeVisible()
  rerender(view(true, 'Backup'))
  expect(screen.getByText('7 of 7')).toBeVisible()
})
