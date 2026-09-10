import { IDBFactory } from 'fake-indexeddb'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { pinFromEnrolledStatus, saveAddressPin } from '../lib/vault/pin'
import { ENROLL_STORE, SELECTED_VAULT_STORE } from '../lib/vault/enrollmentStore'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../lib/vault/spendingPolicy'
import { SAVINGS_TEMPLATE } from '../lib/vault/program/constants'
import type { VaultHistoryItem } from '../lib/vault/history'
import type { VaultStatus } from '../lib/vault/types'
import golden from '../lib/vault/vtxo/testdata/vault-policy-v1-tree.json'
import { VaultProvider, VaultContext } from './vault'
import VaultHome from '../screens/Vault/Home'
import VaultReceive from '../screens/Vault/Receive'
import { useContext, type ReactElement } from 'react'

function DebugProbe() {
  const vault = useContext(VaultContext)
  return (
    <div>
      <span data-testid='dbg-arrivals'>{vault.arrivals.length}</span>
      <span data-testid='dbg-vault'>{vault.status?.vaultId || 'none'}</span>
      <span data-testid='dbg-history'>{vault.history.length}</span>
      <span data-testid='dbg-screen'>{vault.screen}</span>
      <span data-testid='dbg-selected'>{vault.selectedTx?.txid || 'none'}</span>
    </div>
  )
}

vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: () => Promise.resolve(false) }))

const balances = vi.hoisted(() => ({
  history: [] as VaultHistoryItem[],
  snapshotFresh: false,
  balancesLoaded: false,
  fetchStatus: vi.fn(),
}))

vi.mock('../vault/useVaultBalances', () => ({
  useVaultBalances: () => ({
    balanceError: '',
    balancesLoaded: balances.balancesLoaded,
    snapshotFresh: balances.snapshotFresh,
    history: balances.history,
    positions: {
      spending: { availableSats: 12_000, pendingSats: 0, totalSats: 12_000 },
      savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
    },
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    refreshingBalance: false,
    loadOlderActivity: vi.fn().mockResolvedValue({ added: 0, exhausted: true }),
    olderActivity: { status: 'idle', error: '' },
    olderHistory: [],
  }),
}))
vi.mock('../vault/useVaultSession', () => ({
  useVaultSession: () => ({
    enableOtherDevices: vi.fn().mockResolvedValue(undefined),
    enroll: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
    restoreRecoveryArchive: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../vault/useRecoveryKit', () => ({
  useRecoveryKit: () => ({
    backupRecoveryKit: vi.fn().mockResolvedValue(false),
    downloadRecoveryKit: vi.fn().mockReturnValue(''),
    hasRecoveryKit: false,
    initiateAlert: '',
    initiateAlerts: [],
    restoreRecoveryKit: vi.fn().mockResolvedValue(undefined),
    signGuardianExitWithDevice: vi.fn().mockResolvedValue(''),
  }),
}))
vi.mock('../vault/useRecoveryArchive', () => ({
  useRecoveryArchive: () => ({
    backupRecoveryArchive: vi.fn(),
    downloadRecoveryArchive: vi.fn(),
    recoveryArchiveStatus: '',
    recoveryArchiveError: '',
  }),
}))
vi.mock('../vault/useSpendingBitcoin', () => ({ useSpendingBitcoin: () => ({ operation: null, error: '' }) }))
vi.mock('../vault/useSpendingRenewals', () => ({ useSpendingRenewals: () => null }))
vi.mock('../vault/useLedgerSavings', () => ({
  useLedgerSavings: () => ({
    view: null,
    review: vi.fn(),
    approve: vi.fn(),
    complete: vi.fn(),
    refresh: vi.fn(),
  }),
}))
vi.mock('../lib/vault/status', () => ({
  fetchVaultStatus: (...args: unknown[]) => (balances.fetchStatus as (...a: unknown[]) => unknown)(...args),
  fetchPublicStatus: () => Promise.reject(new Error('offline')),
}))

const spendingPolicy = defaultSpendingPolicy()
const STATUS: VaultStatus = {
  enrolled: true,
  network: 'mutinynet',
  clientOrigin: 'https://vault.test',
  rpId: 'vault.test',
  vaultId: 'vault-a',
  templateVersion: SAVINGS_TEMPLATE,
  policyVersion: 'policy-v1',
  protectionTier: 'standard',
  savingsAddress: 'tb1psavings',
  savingsScript: '51',
  periodAllowance: 100_000,
  periodSpent: 0,
  periodRemaining: 100_000,
  txCap: 50_000,
  absoluteFeeCap: 5_000,
  feerateCapSatVb: 10,
  spendingPolicy,
  spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
  vtxoVaultCosignerPub: `02${'11'.repeat(32)}`,
  vtxoExitDelay: 4608,
  vtxoExitDelayUnit: 'seconds',
  spendingArkAddress: 'tark1spending',
  spendingArkScript: `5120${'22'.repeat(32)}`,
  vtxoDelegatePub: `02${'33'.repeat(32)}`,
  vtxoBoardingActive: true,
  vtxoBoardingProgram: 'vault-board-v1',
  vtxoBoardingAddress: 'tb1pboarding',
  vtxoBoardingScript: `5120${'44'.repeat(32)}`,
  vtxoBoardingExitDelay: 604672,
  vtxoBoardingExitDelayUnit: 'seconds',
}

void golden

function renderHome() {
  return render(
    <ToastProvider>
      <VaultProvider>
        <VaultHome />
        <DebugProbe />
      </VaultProvider>
    </ToastProvider>,
  )
}

function renderHomeTree() {
  return (
    <ToastProvider>
      <VaultProvider>
        <VaultHome />
        <DebugProbe />
      </VaultProvider>
    </ToastProvider>
  )
}

describe('provider arrival delivery', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
    balances.history = []
    balances.snapshotFresh = false
    balances.balancesLoaded = false
    balances.fetchStatus.mockReset().mockResolvedValue(STATUS)
    localStorage.setItem(SELECTED_VAULT_STORE, 'vault-a')
    localStorage.setItem(
      `${ENROLL_STORE}:vault-a`,
      JSON.stringify({
        vaultId: 'vault-a',
        credId: '00',
        webauthnP256: '02',
        phoneDirectP256: '02',
        phoneBip340Pub: '02',
        nonce: '00',
        ciphertext: '00',
      }),
    )
    saveAddressPin(pinFromEnrolledStatus(STATUS))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('banners a direct Arkade receive that lands after a fresh baseline, on Home', async () => {
    const { rerender } = renderHome()
    await waitFor(() => expect(balances.fetchStatus).toHaveBeenCalled())
    act(() => {
      balances.balancesLoaded = true
      balances.snapshotFresh = true
    })
    rerender(renderHomeTree())
    const receive: VaultHistoryItem = {
      txid: 'ark-receive-1',
      type: 'received',
      amount: 12_000,
      confirmed: true,
      blockTime: 1_700_000_100,
      account: 'spend',
    }
    act(() => {
      balances.history = [receive]
    })
    rerender(renderHomeTree())
    const banner = await screen.findByText('Received ₿12,000 in Spending.')
    expect(banner).toBeVisible()
  })

  it('opens the arrived payment details from the banner', async () => {
    const user = userEvent.setup()
    const { rerender } = renderHome()
    await waitFor(() => expect(balances.fetchStatus).toHaveBeenCalled())
    act(() => {
      balances.balancesLoaded = true
      balances.snapshotFresh = true
    })
    rerender(renderHomeTree())
    act(() => {
      balances.history = [
        { txid: 'ark-receive-1', type: 'received', amount: 12_000, confirmed: true, blockTime: 1, account: 'spend' },
      ]
    })
    rerender(renderHomeTree())
    expect(screen.getByTestId('dbg-selected')).toHaveTextContent('none')
    await user.click(await screen.findByRole('button', { name: 'View details' }))
    expect(screen.getByTestId('dbg-selected')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('dbg-selected')).toHaveTextContent('ark-receive-1'))
    await waitFor(() => expect(screen.getByTestId('dbg-screen')).toHaveTextContent('tx'))
  })
})

describe('provider arrival delivery on Receive', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
    balances.history = []
    balances.snapshotFresh = false
    balances.balancesLoaded = false
    balances.fetchStatus.mockReset().mockResolvedValue(STATUS)
    localStorage.setItem(SELECTED_VAULT_STORE, 'vault-a')
    localStorage.setItem(
      `${ENROLL_STORE}:vault-a`,
      JSON.stringify({
        vaultId: 'vault-a',
        credId: '00',
        webauthnP256: '02',
        phoneDirectP256: '02',
        phoneBip340Pub: '02',
        nonce: '00',
        ciphertext: '00',
      }),
    )
    saveAddressPin(pinFromEnrolledStatus(STATUS))
  })

  function renderReceiveTree() {
    return (
      <ToastProvider>
        <VaultProvider>
          <VaultReceive />
          <DebugProbe />
        </VaultProvider>
      </ToastProvider>
    )
  }

  async function seedBaseline(rerender: (ui: ReactElement) => void) {
    await waitFor(() => expect(balances.fetchStatus).toHaveBeenCalled())
    act(() => {
      balances.balancesLoaded = true
      balances.snapshotFresh = true
    })
    rerender(renderReceiveTree())
  }

  it('shows the catch-up summary on Receive for two arrivals in one snapshot', async () => {
    const user = userEvent.setup()
    const { rerender } = render(renderReceiveTree())
    await seedBaseline(rerender)
    act(() => {
      balances.history = [
        { txid: 'ark-a', type: 'received', amount: 5_000, confirmed: true, blockTime: 1, account: 'spend' },
        { txid: 'ark-b', type: 'received', amount: 7_000, confirmed: true, blockTime: 2, account: 'spend' },
      ]
    })
    rerender(renderReceiveTree())
    expect(await screen.findByTestId('payment-catch-up')).toBeVisible()
    expect(screen.queryByTestId(/^payment-arrival-/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'View activity' }))
    await waitFor(() => expect(screen.getByTestId('dbg-screen')).toHaveTextContent('activity'))
  })

  it('merges a second receipt into the summary on Receive without dismissing the first', async () => {
    const { rerender } = render(renderReceiveTree())
    await seedBaseline(rerender)
    act(() => {
      balances.history = [
        { txid: 'ark-a', type: 'received', amount: 5_000, confirmed: true, blockTime: 1, account: 'spend' },
      ]
    })
    rerender(renderReceiveTree())
    await screen.findByText('Received ₿5,000 in Spending.')
    act(() => {
      balances.history = [
        { txid: 'ark-a', type: 'received', amount: 5_000, confirmed: true, blockTime: 1, account: 'spend' },
        { txid: 'ark-b', type: 'received', amount: 7_000, confirmed: true, blockTime: 2, account: 'spend' },
      ]
    })
    rerender(renderReceiveTree())
    expect(await screen.findByTestId('payment-catch-up')).toBeVisible()
    expect(screen.queryByTestId(/^payment-arrival-/)).toBeNull()
  })
})
