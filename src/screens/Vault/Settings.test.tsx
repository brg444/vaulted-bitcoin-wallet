import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultSettings from './Settings'

vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: () => Promise.resolve(false) }))

function renderSettings(overrides: Partial<VaultContextProps> = {}) {
  const value = {
    boardingAddress: 'tb1pboardingdestination',
    busy: false,
    liveNetwork: true,
    navigate: vi.fn(),
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    status: null,
    ...overrides,
  } as unknown as VaultContextProps
  render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultSettings />
      </VaultContext.Provider>
    </ToastProvider>,
  )
  return value
}

describe('Vault settings account boundaries', () => {
  afterEach(() => {
    localStorage.removeItem('arkade-vault-theme')
    localStorage.removeItem('arkade-vault-privacy-lock')
    localStorage.removeItem('arkade-vault-v2:session-lock')
    document.documentElement.classList.remove('palette-dark')
  })

  it('uses a native iPhone switch and persists explicit haptic preference', async () => {
    localStorage.setItem('arkade-vault-haptics', '1')
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('settings-haptics'))
    const control = screen.getByRole('switch', { name: 'Haptic feedback' })
    expect(control.tagName).toBe('INPUT')
    expect(control).toHaveAttribute('type', 'checkbox')
    expect(control).toHaveAttribute('switch')
    expect(control).toBeChecked()
    await user.click(control)
    expect(control).not.toBeChecked()
    expect(localStorage.getItem('arkade-vault-haptics')).toBe('0')
    await user.click(control)
    expect(control).toBeChecked()
    expect(localStorage.getItem('arkade-vault-haptics')).toBe('1')
    localStorage.removeItem('arkade-vault-haptics')
  })

  it('does not expose test funding controls', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-faucet')).toBeNull()
    expect(screen.queryByTestId('settings-hwsign')).toBeNull()
    expect(screen.getByTestId('settings-theme')).toHaveRole('button')
    expect(screen.getByTestId('settings-haptics')).toHaveRole('button')
    expect(screen.getByTestId('settings-about')).toHaveRole('button')
    expect(screen.getByTestId('settings-privacy-lock')).toHaveRole('switch')
    expect(screen.getByTestId('settings-signout')).toHaveRole('button')
    expect(screen.getByRole('button', { name: 'Go back' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Adjust this browser.' })).toBeNull()
    expect(screen.queryByText('General')).toBeTruthy()
    expect(document.querySelector('.qg-eyebrow')).toBeNull()
    expect(document.querySelector('.qg-methods')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Diagnostics/ }))
    expect(screen.getByTestId('settings-update')).toHaveRole('button')
    expect(screen.getByTestId('settings-refresh')).toHaveRole('button')
    expect(screen.getByTestId('settings-logs')).toHaveRole('button')
  })

  it('picks a theme from paper radios instead of the old select list', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByTestId('settings-theme'))
    expect(screen.getByRole('heading', { name: 'Theme' })).toBeTruthy()
    const dark = screen.getByTestId('select-option-1')
    expect(dark).toHaveAttribute('role', 'radio')
    await user.click(dark)
    expect(dark).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.classList.contains('palette-dark')).toBe(true)
  })

  it('turns on passkey privacy lock from This browser', async () => {
    const user = userEvent.setup()
    renderSettings()
    const toggle = screen.getByTestId('settings-privacy-lock')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('arkade-vault-privacy-lock')).toBe('1')
    expect(localStorage.getItem('arkade-vault-v2:session-lock')).toBe('1')
  })

  it('signs out from a Vaulted confirmation sheet', async () => {
    const user = userEvent.setup()
    const value = renderSettings()

    await user.click(screen.getByTestId('settings-signout'))
    expect(screen.getByRole('heading', { name: 'Sign out' })).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Sign out' })
    expect(confirm).toBeDisabled()
    await user.click(screen.getByTestId('checkbox'))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(value.reset).toHaveBeenCalled()
  })

  it('does not present in-app banner controls as device notifications', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-notifications')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-haptics')).toBeVisible()
  })
})
