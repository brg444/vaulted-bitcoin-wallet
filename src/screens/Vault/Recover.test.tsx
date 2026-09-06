import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { buildVaultProgramDescriptor } from '../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { fetchFeeEstimates } from '../../lib/vault/esplora'
import { buildRecoveryKit } from '../../lib/vault/program/kit'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultRecover from './Recover'
import type { InitiateAlert } from '../../lib/vault/program/watch'
import type { FamilyKey } from '../../lib/vault/program/constants'

const boardingRecovery = vi.hoisted(() => ({
  find: vi.fn().mockResolvedValue({ inputs: [], totalSats: 0 }),
}))

vi.mock('../../lib/vault/esplora', () => ({
  broadcastTx: vi.fn(),
  fetchAddressUtxos: vi.fn().mockResolvedValue([]),
  fetchFeeEstimates: vi.fn(),
}))

vi.mock('../../lib/vault/vtxo/boardingRecovery', () => ({
  findMatureBoardingInputs: boardingRecovery.find,
}))

beforeEach(() => {
  vi.mocked(fetchFeeEstimates).mockResolvedValue({ '3': 1 })
})

const kit = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
const dest = kit.descriptor.savings.address

function alert(familyKey: FamilyKey): InitiateAlert {
  return {
    familyKey,
    address: kit.descriptor.pending[familyKey].address,
    txid: 'dd'.repeat(32),
    vout: 0,
    value: 20_000,
    seenAt: '2026-08-19T00:00:00.000Z',
  }
}

function renderLost(familyKey: FamilyKey, extra: Partial<VaultContextProps> = {}) {
  const value = {
    downloadRecoveryKit: () => JSON.stringify(kit),
    backupRecoveryKit: async () => false,
    restoreRecoveryKit: async () => {},
    signGuardianExitWithDevice: async (psbt) => psbt,
    hasRecoveryKit: true,
    initiateAlert: 'Someone started recovery',
    initiateAlerts: [alert(familyKey)],
    busy: false,
    error: '',
    navigate: () => {},
    openRecover: () => {},
    recoverEntry: 'lost',
    recoverExit: 'keys',
    savingsAddress: kit.descriptor.savings.address,
    ...extra,
  } as VaultContextProps
  return render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultRecover />
      </VaultContext.Provider>
    </ToastProvider>,
  )
}

function renderKit(extra: Partial<VaultContextProps> = {}) {
  const value = {
    downloadRecoveryKit: () => JSON.stringify(kit),
    backupRecoveryKit: async () => false,
    restoreRecoveryKit: async () => {},
    signGuardianExitWithDevice: async (psbt) => psbt,
    hasRecoveryKit: true,
    initiateAlert: '',
    initiateAlerts: [],
    busy: false,
    error: '',
    navigate: () => {},
    openRecover: () => {},
    recoverEntry: 'kit',
    recoverExit: 'keys',
    recoverMatureBoarding: async () => '55'.repeat(32),
    savingsAddress: kit.descriptor.savings.address,
    ...extra,
  } as VaultContextProps
  return render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultRecover />
      </VaultContext.Provider>
    </ToastProvider>,
  )
}

async function startCancel(familyKey: FamilyKey) {
  renderLost(familyKey)
  fireEvent.change(screen.getByTestId('recover-claim-dest'), { target: { value: dest } })
  fireEvent.click(screen.getByTestId('recover-guardian-exit'))
  await screen.findByTestId('recover-guardian-signers')
}

describe('Vaulted recovery chrome', () => {
  beforeEach(() => {
    boardingRecovery.find.mockReset().mockResolvedValue({ inputs: [], totalSats: 0 })
  })

  it('opens from Home as a sheet that dismisses home', () => {
    const navigate = vi.fn()
    renderLost('savings-hardware', {
      initiateAlert: '',
      initiateAlerts: [],
      navigate,
      recoverExit: 'home',
    })
    expect(document.querySelector('.qg-handle')).toBeTruthy()
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Access and recovery')
    expect(screen.getByRole('heading', { name: 'What do you still have access to?' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'I can’t use my passkey' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('header-back'))
    expect(navigate).toHaveBeenCalledWith('home')
  })

  it('keeps a nested back when opened from Security', () => {
    const navigate = vi.fn()
    renderLost('savings-hardware', {
      initiateAlert: '',
      initiateAlerts: [],
      navigate,
      recoverExit: 'keys',
    })
    expect(document.querySelector('.qg-handle')).toBeNull()
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Access and recovery')
    fireEvent.click(screen.getByTestId('header-back'))
    expect(navigate).toHaveBeenCalledWith('keys')
  })
})

describe('claimant-aware cancel without services', () => {
  beforeEach(() => {
    boardingRecovery.find.mockReset().mockResolvedValue({ inputs: [], totalSats: 0 })
  })

  it('asks hardware and recovery after this device starts recovery', { timeout: 15_000 }, async () => {
    await startCancel('savings-phone')
    expect(screen.getByTestId('recover-guardian-signers').textContent).toMatch(/Hardware and Recovery/)
    expect(screen.queryByTestId('recover-guardian-device')).toBeNull()
    expect(screen.getByTestId('recover-guardian-external').textContent).toMatch(/Hardware/)
    expect(screen.getByTestId('recover-guardian-signers').textContent).not.toMatch(/This device/)
  })

  it('asks this device and recovery after hardware starts recovery', async () => {
    await startCancel('savings-hardware')
    expect(screen.getByTestId('recover-guardian-signers').textContent).toMatch(/This device and Recovery/)
    expect(screen.getByTestId('recover-guardian-device')).toBeTruthy()
    expect(screen.getByTestId('recover-guardian-external').textContent).toMatch(/Recovery/)
  })

  it('asks this device and hardware after recovery starts recovery', async () => {
    await startCancel('savings-recovery')
    expect(screen.getByTestId('recover-guardian-signers').textContent).toMatch(/This device and Hardware/)
    expect(screen.getByTestId('recover-guardian-device')).toBeTruthy()
    expect(screen.getByTestId('recover-guardian-external').textContent).toMatch(/Hardware/)
  })
})

describe('mature boarding recovery', () => {
  beforeEach(() => {
    boardingRecovery.find.mockReset().mockResolvedValue({ inputs: [], totalSats: 0 })
  })

  it('requires an explicit confirmation before recovering with Face ID', async () => {
    const recoverMatureBoarding = vi.fn().mockResolvedValue('55'.repeat(32))
    boardingRecovery.find.mockResolvedValue({ inputs: [{}], totalSats: 42_000 })
    renderKit({
      recoverMatureBoarding,
      status: { enrolled: true, vaultId: 'vault-v2', vtxoBoardingProgram: 'vault-board-v1' } as never,
    })

    expect(await screen.findByTestId('recover-mature-boarding')).toHaveTextContent('₿42,000')
    expect(screen.queryByTestId('recover-mature-boarding-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('recover-mature-boarding'))
    fireEvent.click(screen.getByTestId('recover-mature-boarding-confirm'))

    await waitFor(() => expect(recoverMatureBoarding).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByTestId('recover-mature-boarding')).toBeNull())
  })
})

describe('recovery archive failure feedback', () => {
  it('shows the failed update while retaining the last saved-copy status and recovery actions', () => {
    renderKit({
      recoveryArchiveStatus: 'Transaction recovery data saved on this device earlier',
      recoveryArchiveError: 'Spending operation is missing its exact transaction bundle',
    })
    expect(screen.getByText('Spending operation is missing its exact transaction bundle')).toBeVisible()
    expect(screen.getByText('Transaction recovery data saved on this device earlier')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Download encrypted recovery archive' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download Recovery Kit' })).toBeEnabled()
  })

  it('reports a failed explicit export without claiming a new saved copy', async () => {
    const downloadRecoveryArchive = vi
      .fn()
      .mockRejectedValue(new Error('Spending operation is missing its exact transaction bundle'))
    renderKit({ downloadRecoveryArchive, recoveryArchiveStatus: '', recoveryArchiveError: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Download encrypted recovery archive' }))
    await waitFor(() =>
      expect(screen.getByText('Spending operation is missing its exact transaction bundle')).toBeVisible(),
    )
    expect(downloadRecoveryArchive).toHaveBeenCalledOnce()
    expect(screen.queryByText(/Transaction recovery data saved/)).toBeNull()
  })
})
