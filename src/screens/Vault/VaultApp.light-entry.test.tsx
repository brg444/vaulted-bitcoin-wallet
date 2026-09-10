import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultApp from '../../VaultApp'
import { emptySetupPlan } from '../../lib/vault/setupPlan'
vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: vi.fn() }))
it('routes Light through the common setup action without a separate app', async () => {
  const acceptDesign = vi.fn()
  render(
    <VaultContext.Provider
      value={
        {
          screen: 'design',
          account: 'spend',
          lightAvailable: true,
          setup: emptySetupPlan(),
          acceptDesign,
        } as unknown as VaultContextProps
      }
    >
      <VaultApp />
    </VaultContext.Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: /^Light/ }))
  expect(acceptDesign).toHaveBeenCalledExactlyOnceWith('light')
  expect(localStorage.getItem('vaulted:active-setup')).toBeNull()
})
