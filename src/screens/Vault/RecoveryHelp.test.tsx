import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVaultProgramDescriptor } from '../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { buildRecoveryKit } from '../../lib/vault/program/kit'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import RecoveryHelp from './RecoveryHelp'
import VaultWelcome from './Welcome'
import VaultUnlock from './Unlock'
import VaultSignIn from './onboard/SignIn'
import VaultRecover from './Recover'

vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../lib/vault/webauthn', () => ({ isCoarsePhone: () => false }))

const standard = buildRecoveryKit(
  buildVaultProgramDescriptor({ ...PROGRAM_FIXTURE, protectionTier: 'standard', recoveryPub: undefined }),
)
const advanced = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
function context(kit = standard) {
  return {
    busy: false,
    error: '',
    locked: true,
    hasLocalEnrollment: true,
    navigate: vi.fn(),
    signIn: vi.fn(),
    initiateAlerts: [],
    recoverEntry: 'lost',
    recoverExit: 'keys',
    downloadRecoveryKit: () => JSON.stringify(kit),
  } as unknown as VaultContextProps
}
beforeEach(() => {
  localStorage.clear()
})

describe('access and recovery guidance', () => {
  it.each([VaultWelcome, VaultUnlock, VaultSignIn])('opens and leaves help without authenticating', (Component) => {
    const value = context()
    render(
      <VaultContext.Provider value={value}>
        <Component />
      </VaultContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Access and recovery help' }))
    expect(screen.getByRole('heading', { name: 'What do you still have access to?' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Go back' }))
    expect(screen.getByRole('button', { name: 'Access and recovery help' })).toBeTruthy()
    expect(value.signIn).not.toHaveBeenCalled()
    expect(value.navigate).not.toHaveBeenCalled()
  })

  it('inspects kits without restoring access and clears stale results after an invalid file', async () => {
    render(<RecoveryHelp onBack={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Both keys are unavailable' }))
    expect(screen.getByText(/Check your saved Recovery Kit to identify/)).toBeTruthy()
    fireEvent.click(screen.getByText('Check a saved Recovery Kit'))
    const input = screen.getByLabelText('Recovery Kit file')
    fireEvent.change(input, { target: { files: [{ size: 100, text: async () => JSON.stringify(standard) }] } })
    await screen.findByText(/This kit uses Standard protection/)
    expect(screen.queryByRole('button', { name: 'Review recovery preparation' })).toBeNull()
    expect(localStorage.length).toBe(0)
    fireEvent.change(input, { target: { files: [{ size: 100, text: async () => JSON.stringify(advanced) }] } })
    await screen.findByText(/Advanced provides a delayed Savings path/)
    fireEvent.change(input, { target: { files: [{ size: 100, text: async () => '{"broken":true}' }] } })
    await screen.findByRole('alert')
    expect(screen.queryByText(/Advanced provides a delayed Savings path/)).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('rejects oversized files without reading them', () => {
    const text = vi.fn()
    render(<RecoveryHelp onBack={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Both keys are unavailable' }))
    fireEvent.click(screen.getByText('Check a saved Recovery Kit'))
    fireEvent.change(screen.getByLabelText('Recovery Kit file'), {
      target: { files: [{ size: 1024 * 1024 + 1, text }] },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('too large')
    expect(text).not.toHaveBeenCalled()
  })

  it.each([standard, advanced])('offers only the selected vault’s configured recovery keys', (kit) => {
    render(
      <VaultContext.Provider value={context(kit)}>
        <VaultRecover />
      </VaultContext.Provider>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'I can’t use my passkey' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery preparation' }))
    expect(screen.getByTestId('recover-key-hardware')).toHaveAttribute('aria-checked', 'true')
    expect(Boolean(screen.queryByTestId('recover-key-recovery'))).toBe(kit.protectionTier === 'advanced')
    expect(screen.getByTestId('recover-initiate')).toHaveTextContent('Prepare recovery')
  })
})
