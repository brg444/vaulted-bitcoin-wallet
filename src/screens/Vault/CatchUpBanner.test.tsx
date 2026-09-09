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
        catchUp={{ count: 3, totalSats: 21_500, keys: ['a', 'b', 'c'] }}
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
