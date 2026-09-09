import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultApp from '../../VaultApp'
import { emptySetupPlan } from '../../lib/vault/setupPlan'
import VaultLight from './Light'

const mocks = vi.hoisted(() => ({ saved: vi.fn(), pending: vi.fn() }))
vi.mock('../../lib/vault/light/enrollment', async (original) => ({
  ...(await original<typeof import('../../lib/vault/light/enrollment')>()),
  loadLightEnrollment: mocks.saved,
  loadPendingLightEnrollment: mocks.pending,
}))
vi.mock('../../lib/vault/status', async (original) => ({
  ...(await original<typeof import('../../lib/vault/status')>()),
  fetchPublicStatus: vi.fn(async () => ({
    network: 'mainnet',
    enrollmentMode: 'open',
    supportedSetups: ['light'],
  })),
}))
vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: vi.fn() }))

function renderApp(entry: 'welcome' | 'unlock' | 'design' = 'welcome') {
  return render(
    <VaultContext.Provider
      value={
        {
          screen: entry,
          account: 'spending',
          busy: false,
          lightAvailable: true,
          setup: emptySetupPlan(),
        } as unknown as VaultContextProps
      }
    >
      <VaultApp />
    </VaultContext.Provider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  mocks.saved.mockReset().mockReturnValue(null)
  mocks.pending.mockReset().mockReturnValue(null)
})

describe('Light entry routing', () => {
  it.each(['welcome', 'unlock'] as const)('does not let an unfinished Light setup replace %s', async (entry) => {
    localStorage.setItem('vaulted:active-setup', 'light')
    localStorage.setItem('vaulted-light:pending-v1', 'saved pending enrollment')
    mocks.pending.mockReturnValue({ recoveryBackup: {} })
    renderApp(entry)
    expect(
      await screen.findByRole('button', {
        name: entry === 'welcome' ? 'Sign in to an existing vault' : 'Unlock with passkey',
      }),
    ).toBeVisible()
    expect(screen.queryByText('Keep two things safe')).toBeNull()
    expect(mocks.pending).not.toHaveBeenCalled()
    expect(localStorage.getItem('vaulted-light:pending-v1')).toBe('saved pending enrollment')
  })

  it('keeps the normal entry accessible if a remembered Light enrollment cannot be read', async () => {
    localStorage.setItem('vaulted:active-setup', 'light')
    mocks.saved.mockImplementation(() => {
      throw new Error('Invalid saved enrollment')
    })
    renderApp()
    expect(await screen.findByRole('button', { name: 'Sign in to an existing vault' })).toBeVisible()
  })

  it('still opens a remembered, completed Light wallet at passkey unlock', async () => {
    localStorage.setItem('vaulted:active-setup', 'light')
    mocks.saved.mockReturnValue({ descriptor: { vaultId: 'completed-wallet' } })
    renderApp()
    expect(await screen.findByRole('button', { name: 'Unlock with passkey' })).toBeVisible()
    expect(screen.queryByText('Keep two things safe')).toBeNull()
    expect(mocks.pending).not.toHaveBeenCalled()
  })

  it('resumes pending setup only after choosing Light and allows returning without deleting it', async () => {
    const user = userEvent.setup()
    localStorage.setItem('vaulted-light:pending-v1', 'saved pending enrollment')
    mocks.pending.mockReturnValue({ recoveryBackup: {} })
    renderApp('design')
    await user.click(screen.getByRole('button', { name: /^Light/ }))
    expect(await screen.findByRole('heading', { name: 'Keep two things safe' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Go back' }))
    expect(await screen.findByRole('heading', { name: 'Choose your protection' })).toBeVisible()
    expect(localStorage.getItem('vaulted:active-setup')).toBeNull()
    expect(localStorage.getItem('vaulted-light:pending-v1')).toBe('saved pending enrollment')
  })

  it('also allows leaving an interrupted automatic backup', async () => {
    const user = userEvent.setup()
    const onExit = vi.fn()
    mocks.pending.mockReturnValue({})
    render(<VaultLight onExit={onExit} />)
    expect(await screen.findByRole('heading', { name: 'Saving your wallet backup' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Go back' }))
    expect(onExit).toHaveBeenCalledOnce()
  })
})
