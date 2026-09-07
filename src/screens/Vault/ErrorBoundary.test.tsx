import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import VaultErrorBoundary from './ErrorBoundary'

describe('Vault error boundary', () => {
  it('shows a safe incident reference, retries, and reloads without rendering the exception', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const raw = `render failed for tb1q${'q'.repeat(40)}`
    let shouldThrow = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    function Screen() {
      if (shouldThrow) throw new Error(raw)
      return <p>Recovered screen</p>
    }

    render(
      <VaultErrorBoundary reload={reload}>
        <Screen />
      </VaultErrorBoundary>,
    )

    expect(screen.getByText('Vaulted could not display this screen.')).toBeTruthy()
    expect(screen.getByText(/^VLT-/)).toBeTruthy()
    expect(document.body).not.toHaveTextContent(raw)
    expect(document.body).not.toHaveTextContent('Nothing was sent')
    expect(document.body).not.toHaveTextContent('This device was not changed')
    expect(screen.getByText(/check its status after reopening the wallet/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)

    shouldThrow = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Recovered screen')).toBeTruthy()
  })
})
