import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRecoveryKit } from '../../../lib/vault/program/kit'
import { buildVaultProgramDescriptor } from '../../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../../lib/vault/program/fixtures'
import { VaultContext, type VaultContextProps } from '../../../vault/context'
import RecoveryExplanation from '../qg/RecoveryExplanation'
import VaultKit from './Kit'
import VaultReady from './Ready'
import VaultPasskey from './Passkey'

const mocks = vi.hoisted(() => ({ available: vi.fn(), toast: vi.fn() }))
vi.mock('../../../components/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('../../../lib/vault/webauthn', () => ({ isPlatformPasskeyAvailable: mocks.available }))
const kit = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
function value(overrides: Partial<VaultContextProps> = {}) {
  return {
    navigate: vi.fn(),
    downloadRecoveryKit: () => JSON.stringify(kit),
    networkLabel: 'Bitcoin',
    busy: false,
    error: '',
    ...overrides,
  } as unknown as VaultContextProps
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:kit-test')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

describe('onboarding guidance', () => {
  it.each([false, true])('explains the recovery requirements for advanced=%s', (advanced) => {
    render(<RecoveryExplanation advanced={advanced} mainnet />)
    fireEvent.click(screen.getByText('Keys, waiting periods, and service availability'))
    expect(screen.getByText(/Starting a new recovery requires approval/)).toBeTruthy()
    expect(screen.getByText(/6 blocks \(about an hour\)/)).toBeTruthy()
    expect(screen.getByText(/144 blocks \(about a day\)/)).toBeTruthy()
    expect(screen.queryByText(/288 blocks/)).toBe(advanced ? screen.getByText(/288 blocks/) : null)
    if (!advanced) expect(screen.getByText(/Standard has no separate key/)).toBeTruthy()
  })

  it('leaves package checks outstanding after a public map download, including previously acknowledged wallets', () => {
    localStorage.setItem(`vaulted-backup-confirmed:${kit.descriptorHash}`, 'confirmed-by-user')
    const context = value()
    render(
      <VaultContext.Provider value={context}>
        <VaultKit />
      </VaultContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download Recovery Kit' }))
    expect(context.navigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/leaves those backup checks outstanding/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open your Vault' }))
    expect(context.navigate).toHaveBeenCalledWith('home')
  })

  it('allows deferring backup without claiming it is complete', () => {
    const context = value()
    const { rerender } = render(
      <VaultContext.Provider value={context}>
        <VaultKit />
      </VaultContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'I’ll save a separate copy later' }))
    expect(context.navigate).toHaveBeenCalledWith('home')
    rerender(
      <VaultContext.Provider value={context}>
        <VaultReady />
      </VaultContext.Provider>,
    )
    expect(screen.getByTestId('backup-status')).toHaveTextContent('Save a recovery package outside this device')
    expect(screen.queryByText('Loss recovery is ready')).toBeNull()
  })

  it('keeps a pending passkey check distinct from availability', async () => {
    let complete!: (available: boolean) => void
    mocks.available.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve
        }),
    )
    render(
      <VaultContext.Provider value={value()}>
        <VaultPasskey />
      </VaultContext.Provider>,
    )
    expect(screen.getByText('Checking passkey support…')).toBeTruthy()
    expect(screen.queryByText('Device supports passkeys')).toBeNull()
    complete(true)
    await screen.findByText('Device supports passkeys')
    expect(screen.getByText(/required unlock support when you create/)).toBeTruthy()
  })
})
