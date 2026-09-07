import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVaultProgramDescriptor } from '../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { buildRecoveryKit } from '../../lib/vault/program/kit'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultRecover from './Recover'

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  fees: vi.fn(),
  utxos: vi.fn(),
  copy: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}))

vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: mocks.copy }))
vi.mock('../../lib/vault/esplora', () => ({
  broadcastTx: mocks.broadcast,
  fetchFeeEstimates: mocks.fees,
  fetchAddressUtxos: mocks.utxos,
}))
vi.mock('../../lib/vault/vtxo/boardingRecovery', () => ({
  findMatureBoardingInputs: vi.fn().mockResolvedValue({ inputs: [], totalSats: 0 }),
}))

const kit = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))

function renderRecovery(pending: boolean) {
  render(
    <VaultContext.Provider
      value={
        {
          downloadRecoveryKit: () => JSON.stringify(kit),
          hasRecoveryKit: true,
          initiateAlert: '',
          initiateAlerts: pending
            ? [{ familyKey: 'savings-hardware', txid: 'dd'.repeat(32), vout: 0, value: 20_000 }]
            : [],
          busy: false,
          error: '',
          navigate: vi.fn(),
          recoverEntry: 'lost',
          recoverExit: 'keys',
          savingsAddress: kit.descriptor.savings.address,
        } as unknown as VaultContextProps
      }
    >
      <VaultRecover />
    </VaultContext.Provider>,
  )
}

describe('recovery preparation status', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fees.mockResolvedValue({ '3': 1 })
    mocks.utxos.mockResolvedValue([{ txid: 'dd'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true } }])
    mocks.copy.mockResolvedValue(undefined)
  })

  it.each([
    ['recover-initiate', false],
    ['recover-clawback', true],
    ['recover-claim', true],
  ] as const)('reports preparation without submission for %s', async (testId, pending) => {
    renderRecovery(pending)
    if (!pending) {
      fireEvent.click(screen.getByRole('radio', { name: 'I can’t use my passkey' }))
      fireEvent.click(screen.getByRole('button', { name: 'Review recovery preparation' }))
    }
    if (pending) {
      expect(screen.getByText('Recovery detected on Savings')).toBeTruthy()
      fireEvent.click(
        screen.getByRole('button', {
          name: testId === 'recover-clawback' ? 'Cancel this recovery' : 'Claim after the waiting period',
        }),
      )
      fireEvent.change(screen.getByTestId('recover-claim-dest'), {
        target: { value: kit.descriptor.savings.address },
      })
    }
    fireEvent.click(screen.getByTestId(testId))
    const prepared = await screen.findByTestId('recovery-prepared')
    expect(screen.getByTestId('screen-title')).toHaveTextContent(
      testId === 'recover-clawback' ? 'Cancellation prepared' : 'Recovery transaction prepared',
    )
    expect(prepared).toHaveTextContent('Preparation has not moved funds')
    expect(prepared).toHaveTextContent('Bitcoin confirmation')
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce())
    expect(mocks.copy.mock.calls[0][0]).toMatch(/^[0-9a-f]+$/)
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining('Recovery started'))
  })
})
