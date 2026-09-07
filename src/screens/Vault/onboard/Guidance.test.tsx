import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRecoveryKit } from '../../../lib/vault/program/kit'
import { buildVaultProgramDescriptor } from '../../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../../lib/vault/program/fixtures'
import { VaultContext, type VaultContextProps } from '../../../vault/context'
import { useBackupConfirmation } from '../qg/useBackupConfirmation'
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
function BackupProbe() {
  const { confirmed } = useBackupConfirmation()
  return <p data-testid='confirmed'>{String(confirmed)}</p>
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

  it('keeps a download distinct from a confirmed separate backup, scoped to this kit', async () => {
    const context = value()
    const { rerender } = render(
      <VaultContext.Provider value={context}>
        <VaultKit />
        <BackupProbe />
      </VaultContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download Recovery Kit' }))
    expect(context.navigate).not.toHaveBeenCalled()
    expect(screen.getByTestId('confirmed')).toHaveTextContent('false')
    expect(screen.getByRole('button', { name: 'Open your Vault' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Open your Vault' }))
    await waitFor(() => expect(screen.getByTestId('confirmed')).toHaveTextContent('true'))
    expect(context.navigate).toHaveBeenCalledWith('home')
    const otherKit = buildRecoveryKit(buildVaultProgramDescriptor({ ...PROGRAM_FIXTURE, vaultId: '11'.repeat(16) }))
    rerender(
      <VaultContext.Provider value={value({ downloadRecoveryKit: () => JSON.stringify(otherKit) })}>
        <BackupProbe />
      </VaultContext.Provider>,
    )
    expect(screen.getByTestId('confirmed')).toHaveTextContent('false')
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
    expect(screen.getByTestId('backup-status')).toHaveTextContent('Backup reminder')
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
