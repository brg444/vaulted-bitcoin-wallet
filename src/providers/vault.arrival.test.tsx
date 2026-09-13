import { useSession } from '../vault/sessionContext'
import { accountBalanceReads } from '../test/accountBalances'
import { IDBFactory } from 'fake-indexeddb'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { pinFromEnrolledStatus, saveAddressPin } from '../lib/vault/pin'
import { ENROLL_STORE, SELECTED_VAULT_STORE } from '../lib/vault/enrollmentStore'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../lib/vault/spendingPolicy'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import type { VaultHistoryItem } from '../lib/vault/history'
import type { VaultStatus } from '../lib/vault/types'
import golden from '../lib/vault/vtxo/testdata/vault-policy-v1-tree.json'
import { VaultProvider, VaultContext } from './vault'
import VaultHome from '../screens/Vault/Home'
import { useContext } from 'react'

function DebugProbe() {
  const vault = useContext(VaultContext)
  const session = useSession()
  return (
    <div>
      <span data-testid='dbg-vault'>{session.status?.vaultId || 'none'}</span>
      <span data-testid='dbg-history'>{vault.allHistory.length}</span>
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
  savingsFresh: false,
  fetchStatus: vi.fn(),
}))

vi.mock('../vault/useVaultBalances', () => ({
  useVaultBalances: () => ({
    accountReads: {
      ...accountBalanceReads({ loaded: balances.balancesLoaded, fresh: balances.snapshotFresh }),
      savings: { loaded: balances.balancesLoaded, fresh: balances.savingsFresh, refreshing: false, error: '' },
    },
    snapshotFresh: balances.snapshotFresh,
    history: balances.history,
    positions: {
      spending: { availableSats: 12_000, pendingSats: 0, totalSats: 12_000 },
      savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
    },
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    loadOlderActivity: vi.fn().mockResolvedValue({ added: 0, exhausted: true }),
    olderActivity: { status: 'idle', error: '' },
    olderHistory: [],
  }),
}))

vi.mock('../vault/useRecoveryAlerts', () => ({ useRecoveryAlerts: () => '' }))
vi.mock('../vault/useRecoveryKit', () => ({
  useRecoveryKit: () => ({
    backupRecoveryKit: vi.fn().mockResolvedValue(false),
    downloadRecoveryKit: vi.fn().mockReturnValue(''),
    hasRecoveryKit: false,
    restoreRecoveryKit: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../vault/useSpendingBitcoin', () => ({
  useSpendingBitcoin: () => ({ snapshot: { operation: null, error: '' }, acknowledgeRecovery: vi.fn() }),
}))
vi.mock('../vault/useSpendingRenewals', () => ({ useSpendingRenewals: () => null }))
vi.mock('../vault/useLedgerPayments', () => ({
  useLedgerPayments: () => ({
    view: null,
    pending: null,
    error: '',
    hardwarePhase: 'idle',
    completion: null,
    payments: {
      review: vi.fn(),
      approve: vi.fn(),
      refresh: vi.fn(),
      approveWithLedger: vi.fn(),
      cancelReview: vi.fn(),
      cancelHardware: vi.fn(),
      clearError: vi.fn(),
    },
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
  templateVersion: LEDGER_NATIVE_TEMPLATE,
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
    balances.savingsFresh = false
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
    vi.unstubAllGlobals()
  })

  it.each([
    { account: 'spend', spendFresh: true },
    { account: 'savings', spendFresh: true },
    { account: 'savings', spendFresh: false },
  ] as const)(
    'uses native delivery for $account with Spending freshness $spendFresh',
    async ({ account, spendFresh }) => {
      const showNotification = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('Notification', { permission: 'granted' })
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistration: vi.fn().mockResolvedValue({ showNotification }) },
      })
      localStorage.setItem(
        'vaulted:push:v1:mutinynet:vault-a',
        JSON.stringify({ subHandle: 'ab'.repeat(32), expiresAt: Date.now() + 100000 }),
      )
      const { rerender } = renderHome()
      await waitFor(() => expect(screen.getByTestId('dbg-vault')).toHaveTextContent('vault-a'))
      act(() => {
        balances.balancesLoaded = true
        balances.snapshotFresh = spendFresh
        balances.savingsFresh = true
      })
      rerender(renderHomeTree())
      act(() => {
        balances.history = [
          { txid: 'receipt-1', type: 'received', amount: 12000, confirmed: true, blockTime: 1700000100, account },
        ]
      })
      rerender(renderHomeTree())
      await waitFor(() => expect(screen.getByTestId('dbg-history')).toHaveTextContent('1'))
      expect(screen.queryByTestId(/^payment-arrival-/)).toBeNull()
      expect(screen.queryByTestId('payment-catch-up')).toBeNull()
      if (account === 'savings') await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
      else expect(showNotification).not.toHaveBeenCalled() // Spending belongs to server push.
    },
  )
})
