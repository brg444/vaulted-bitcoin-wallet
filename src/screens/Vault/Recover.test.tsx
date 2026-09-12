import {
  VaultTestProvider,
  type VaultTestContextProps as VaultContextProps,
} from '../../test/fixtures/VaultTestProvider'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { broadcastTx, fetchAddressUtxos, fetchTxHex } from '../../lib/vault/esplora'
import { exportLedgerRecoveryJournal } from '../../lib/vault/ledgerRecoveryWallet'
import { ledgerRecoveryFixture } from '../../lib/vault/recovery/testdata/ledger'
import VaultRecover from './Recover'

const boardingRecovery = vi.hoisted(() => ({
  find: vi.fn().mockResolvedValue({ inputs: [], totalSats: 0 }),
}))

vi.mock('../../lib/vault/esplora', () => ({
  fetchTipHeight: vi.fn().mockResolvedValue(1000),
  fetchTxHex: vi.fn(),
  broadcastTx: vi.fn(),
  fetchAddressUtxos: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/vault/vtxo/boardingRecovery', () => ({
  findMatureBoardingInputs: boardingRecovery.find,
}))

let fixture: Awaited<ReturnType<typeof ledgerRecoveryFixture>>
const priorLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
beforeAll(async () => {
  fixture = await ledgerRecoveryFixture(true)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, run: () => Promise<unknown>) => run() },
  })
})
afterAll(() => {
  if (priorLocks) Object.defineProperty(navigator, 'locks', priorLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})
beforeEach(() => {
  localStorage.clear()
  vi.mocked(broadcastTx).mockClear()
  vi.mocked(fetchAddressUtxos).mockReset().mockResolvedValue([])
  vi.mocked(fetchTxHex).mockReset()
  boardingRecovery.find.mockReset().mockResolvedValue({ inputs: [], totalSats: 0 })
})

function renderKit(extra: Partial<VaultContextProps> = {}) {
  const value = {
    downloadRecoveryKit: () => JSON.stringify(fixture.kit),
    backupRecoveryKit: async () => false,
    restoreRecoveryKit: async () => {},
    hasRecoveryKit: true,
    initiateAlert: '',
    busy: false,
    error: '',
    navigate: () => {},
    openRecover: () => {},
    recoverEntry: 'kit',
    recoverExit: 'keys',
    recoverMatureBoarding: async () => '55'.repeat(32),
    savingsAddress: fixture.status.savingsAddress,
    status: fixture.status,
    ...extra,
  } as VaultContextProps
  return render(
    <ToastProvider>
      <VaultTestProvider value={value}>
        <VaultRecover />
      </VaultTestProvider>
    </ToastProvider>,
  )
}

describe('retained Savings recovery entry', () => {
  it('opens the enrolled Ledger workflow and returns to backups', () => {
    renderKit({ recoverEntry: 'lost' })
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Recover Ledger Savings')
    expect(screen.getByRole('combobox', { name: 'Recovery path' })).toBeVisible()
    expect(screen.queryByTestId('recover-guardian-exit')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'I can’t use my passkey' })).toBeNull()
    fireEvent.click(screen.getByTestId('header-back'))
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Backups')
  })

  it('requires the enrolled recovery package before offering a Savings transaction', () => {
    renderKit({ recoverEntry: 'lost', downloadRecoveryKit: () => '' })
    expect(screen.getByRole('alert')).toHaveTextContent('Open your enrolled Ledger account')
    expect(screen.queryByRole('button', { name: 'Review recovery' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open backups' }))
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Backups')
  })

  it('filters unconfirmed outputs before recovery preparation', async () => {
    const coin = fixture.archive.onchain.find((c) => c.script === fixture.kit.descriptor.savings.script)!
    vi.mocked(fetchAddressUtxos).mockResolvedValue([{ ...coin, status: { confirmed: false } }])
    renderKit({ recoverEntry: 'lost' })
    fireEvent.click(screen.getByRole('button', { name: 'Find confirmed outputs' }))
    await waitFor(() => expect(fetchAddressUtxos).toHaveBeenCalledWith(fixture.kit.descriptor.savings.address))
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a confirmed Bitcoin output')
    expect(fetchTxHex).not.toHaveBeenCalled()
  })
})

describe('Ledger recovery preparation preserves approval boundaries', () => {
  it.each(['initiate', 'clawback', 'pending-claim'] as const)(
    'saves %s for review without broadcasting',
    async (path) => {
      const source =
        path === 'initiate' ? fixture.kit.descriptor.savings : fixture.kit.descriptor.pending['savings-hardware']
      const coin = fixture.archive.onchain.find((c) => c.script === source.script)!
      vi.mocked(fetchAddressUtxos).mockResolvedValue([{ ...coin, status: { confirmed: true, block_height: 1 } }])
      vi.mocked(fetchTxHex).mockResolvedValue(coin.parentHex!)
      renderKit({ recoverEntry: 'lost' })
      fireEvent.change(screen.getByRole('combobox', { name: 'Recovery path' }), { target: { value: path } })
      if (path === 'pending-claim') {
        fireEvent.change(screen.getByRole('textbox', { name: 'Bitcoin destination' }), {
          target: { value: fixture.status.savingsAddress },
        })
      }
      fireEvent.click(screen.getByRole('button', { name: 'Find confirmed outputs' }))
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Bitcoin output' }).children).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }))
      expect(await screen.findByRole('button', { name: 'Approve recovery' })).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Save and broadcast recovery' })).toBeNull()
      expect(broadcastTx).not.toHaveBeenCalled()
      const journal = exportLedgerRecoveryJournal(fixture.kit.descriptor.ledgerSavings)
      if (path === 'pending-claim') {
        expect(journal.standalone).toHaveLength(1)
        expect(journal.standalone![0].path).toEqual({ program: path, claimant: 'hardware' })
      } else {
        expect(journal.records).toHaveLength(1)
        expect(journal.records[0].transition.action.kind).toBe(path)
        expect(journal.records[0].transition.coin.txid).toBe(coin.txid)
        expect(journal.records[0].userPsbt).toBeUndefined()
        expect(journal.records[0].guardianPsbt).toBeUndefined()
      }
    },
  )
})

describe('Ledger cancellation with all remaining keys', () => {
  it.each([
    ['phone', ['hardware', 'recovery']],
    ['hardware', ['phone', 'recovery']],
    ['recovery', ['phone', 'hardware']],
  ] as const)('excludes the %s claimant from cancellation signing', async (claimant, signers) => {
    const source = fixture.kit.descriptor.pending[`savings-${claimant}`]
    const coin = fixture.archive.onchain.find((c) => c.script === source.script)!
    vi.mocked(fetchAddressUtxos).mockResolvedValue([{ ...coin, status: { confirmed: true, block_height: 1 } }])
    vi.mocked(fetchTxHex).mockResolvedValue(coin.parentHex!)
    renderKit({ recoverEntry: 'lost' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Recovery path' }), { target: { value: 'pending-cancel' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Recovery claimant' }), { target: { value: claimant } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Bitcoin destination' }), {
      target: { value: fixture.status.savingsAddress },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Find confirmed outputs' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Bitcoin output' }).children).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }))
    expect(await screen.findByText(`Required: ${signers.join(' and ')}.`)).toBeVisible()
    const roles = Array.from(screen.getByRole('combobox', { name: 'Signing account' }).children).map(
      (option) => (option as HTMLOptionElement).value,
    )
    expect(roles).toEqual(signers)
    expect(screen.queryByRole('button', { name: 'Save and broadcast recovery' })).toBeNull()
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
      status: fixture.status,
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
    expect(screen.getByRole('button', { name: 'Save recovery package' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('button', { name: /Wallet details/ })).toBeEnabled()
  })

  it('reports a failed explicit export without claiming a new saved copy', async () => {
    const downloadRecoveryArchive = vi
      .fn()
      .mockRejectedValue(new Error('Spending operation is missing its exact transaction bundle'))
    renderKit({ downloadRecoveryArchive, recoveryArchiveStatus: '', recoveryArchiveError: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Save recovery package' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download recovery package' }))
    await waitFor(() =>
      expect(screen.getByText('Spending operation is missing its exact transaction bundle')).toBeVisible(),
    )
    expect(downloadRecoveryArchive).toHaveBeenCalledOnce()
    expect(screen.queryByText(/Transaction recovery data saved/)).toBeNull()
  })
})

describe('recovery package navigation', () => {
  it('explains Bitcoin exit without starting an action or claiming that the saved amount is current', () => {
    const downloadRecoveryArchive = vi.fn()
    renderKit({ downloadRecoveryArchive })
    expect(screen.queryByRole('button', { name: /Recover to Bitcoin/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: /Recover to Bitcoin/ }))
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Recover to Bitcoin')
    expect(screen.getByText(/later payments and renewals need updated data/)).toBeVisible()
    expect(downloadRecoveryArchive).not.toHaveBeenCalled()
  })
  it('checks a public Ledger kit without presenting it as complete Spending recovery data', () => {
    renderKit()
    fireEvent.click(screen.getByRole('button', { name: /Check a recovery package/ }))
    expect(screen.queryByText(/This file contains Spending paths/)).toBeNull()
    fireEvent.click(screen.getByText('Paste recovery JSON'))
    fireEvent.change(screen.getByTestId('recovery-kit-json'), { target: { value: JSON.stringify(fixture.kit) } })
    expect(screen.queryByText(/This file contains Spending paths/)).toBeNull()
    expect(screen.getByText(/Public scripts alone do not contain your Spending transaction paths/)).toBeVisible()
  })
})
