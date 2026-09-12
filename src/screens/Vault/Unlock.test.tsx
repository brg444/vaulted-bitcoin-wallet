import {
  VaultTestProvider,
  type VaultTestContextProps as VaultContextProps,
} from '../../test/fixtures/VaultTestProvider'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import VaultUnlock from './Unlock'

describe('Vault privacy unlock', () => {
  it('asks only for passkey and does not show the welcome pitch', async () => {
    const user = userEvent.setup()
    const signIn = vi.fn().mockResolvedValue(undefined)
    render(
      <VaultTestProvider value={{ busy: false, error: '', signIn } as unknown as VaultContextProps}>
        <VaultUnlock />
      </VaultTestProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Unlock' })).toBeTruthy()
    expect(screen.getByTestId('privacy-unlock')).toHaveTextContent('Unlock with passkey')
    expect(screen.getByText('This vault stays hidden until this device approves.')).toBeTruthy()
    expect(screen.queryByText('Spend freely.')).toBeNull()
    expect(screen.queryByText('Unlock vault')).toBeNull()
    expect(screen.queryByText('Set up another vault')).toBeNull()
    expect(screen.queryByText('MUTINYNET')).toBeNull()
    await user.click(screen.getByTestId('privacy-unlock'))
    expect(signIn).toHaveBeenCalledTimes(1)
  })
})
