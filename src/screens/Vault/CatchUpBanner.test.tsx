import { Fiats } from '../../lib/types'
import { useContext } from 'react'
import { VaultContext } from '../../vault/context'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CatchUpBanner from './CatchUpBanner'

describe('catch-up banner', () => {
  it('names count and total, links to activity, and dismisses', async () => {
    const user = userEvent.setup()
    const onOpenActivity = vi.fn()
    const onDismiss = vi.fn()
    render(
      <CatchUpBanner
        catchUp={{ count: 3, totalSats: 21_500, keys: ['a', 'b', 'c'], items: [] }}
        onOpenActivity={onOpenActivity}
        onDismiss={onDismiss}
      />,
    )

    expect(screen.getByRole('status', { name: 'New payments summary' })).toBeVisible()
    expect(screen.getByText('3 new payments received · ₿21,500 total.')).toBeVisible()
    expect(screen.queryByText(/sender|from /i)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'View activity' }))
    expect(onOpenActivity).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Dismiss new payments summary' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

function UsdSummary() {
  const current = useContext(VaultContext)
  return (
    <VaultContext.Provider
      value={{
        ...current,
        balanceUnit: 'usd',
        fiatDisplayRate: { pricePerBtc: 100000, currency: Fiats.USD },
      }}
    >
      <CatchUpBanner
        catchUp={{ count: 3, totalSats: 21500, keys: ['a', 'b', 'c'], items: [] }}
        onOpenActivity={() => {}}
        onDismiss={() => {}}
      />
    </VaultContext.Provider>
  )
}

it('uses the wallet denomination for the reconnect summary total', () => {
  render(<UsdSummary />)
  expect(screen.getByTestId('payment-catch-up')).toHaveTextContent('3 new payments received · $21.50 total.')
})
