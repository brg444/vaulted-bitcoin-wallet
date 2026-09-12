import {
  VaultTestProvider,
  type VaultTestContextProps as VaultContextProps,
} from '../../../test/fixtures/VaultTestProvider'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import VaultPasskey from './Passkey'

vi.mock('../../../lib/vault/webauthn', () => ({ isPlatformPasskeyAvailable: async () => true }))

describe('enrollment admission screen', () => {
  it('follows the server mode and requires an invite only when enabled', async () => {
    const enroll = vi.fn()
    const view = (mode: string) => (
      <VaultTestProvider
        value={
          { enrollmentMode: mode, enroll, busy: false, error: '', navigate: vi.fn() } as unknown as VaultContextProps
        }
      >
        <VaultPasskey />
      </VaultTestProvider>
    )
    const rendered = render(view('open'))
    const create = screen.getByRole('button', { name: 'Create Vault' })
    await waitFor(() => expect(create).toBeEnabled())
    expect(screen.queryByLabelText('One-time invite')).toBeNull()
    fireEvent.click(create)
    expect(enroll).toHaveBeenCalledWith('')
    rendered.rerender(view('token'))
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText('One-time invite'), { target: { value: 'A'.repeat(43) } })
    expect(create).toBeEnabled()
    fireEvent.click(create)
    expect(enroll).toHaveBeenLastCalledWith('A'.repeat(43))
    rendered.rerender(view('loading'))
    expect(create).toBeDisabled()
  })
})
