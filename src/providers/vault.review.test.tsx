import { useSpendingPayment } from '../vault/spendingPaymentContext'
import { vaultAccountRuntime } from '../lib/vault/accountRuntime'
import { useSession } from '../vault/sessionContext'
import { accountBalanceReads } from '../test/accountBalances'
import {
  sharedSpendingEnrollment,
  sharedSpendingDescriptor,
  sharedSpendingStatus,
} from '../lib/vault/vtxo/testdata/sharedSpending'
import { clearAddressPin, pinFromEnrolledStatus, saveAddressPin } from '../lib/vault/pin'
import { Address, OutScript, TEST_NETWORK } from '@scure/btc-signer'
const bitcoinDestination = Address(TEST_NETWORK).encode(OutScript.decode(hex.decode('0014' + '43'.repeat(20))))
import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { ledgerRecoveryFixture } from '../lib/vault/recovery/testdata/ledger'
import { getLogs } from '../lib/logs'
import { ENROLL_STORE, SELECTED_VAULT_STORE, SESSION_LOCK_STORE } from '../lib/vault/enrollmentStore'
import { MUTINYNET_INVOICE, MUTINYNET_INVOICE_TIMESTAMP } from '../lib/vault/lightningTestUtils'
import { MUTINYNET_LIGHTNING_SOLVER } from '../lib/vault/lightningConfig'
import { emptySetupPlan, SETUP_STORE_KEY } from '../lib/vault/setupPlan'
import type { VaultStatus } from '../lib/vault/types'
import golden from '../lib/vault/vtxo/testdata/vault-policy-v1-tree.json'
import { persistVtxoSpend } from '../lib/vault/vtxo/spendingJournal'
import { VtxoReviewedReservationError } from '../lib/vault/vtxo/spendingErrors'
import { type VaultVtxoSpendQuote } from '../lib/vault/vtxo/spend'
import { VaultProvider } from './vault'
import {
  useVaultAccount,
  useVaultActivity,
  useVaultInteraction,
  useVaultNavigation,
  useVaultSend,
} from '../vault/appContexts'
import { LedgerHardware } from '../screens/Vault/onboard/Ledger'
import ledgerVectors from '../lib/vault/program/ledger-key-vectors.json'
import { ledgerSpendingPublicKey } from '../lib/vault/ledgerSetup'
import type { LedgerSavingsView } from '../lib/vault/ledgerPayments'

let ledgerView: LedgerSavingsView

const mocks = vi.hoisted(() => ({
  ledger: vi.fn(),
  ledgerReview: vi.fn(),
  ledgerApprove: vi.fn(),
  ledgerComplete: vi.fn(),
  ledgerRefresh: vi.fn(),
  readLedgerAccount: vi.fn(),
  closeLedger: vi.fn(async () => undefined),
  authorizeRenewals: vi.fn(async () => null),
  bitcoinSend: vi.fn(),
  bitcoinRead: vi.fn(),
  availableSats: 20000,
  refreshBalance: vi.fn(),
  loadLightningFunding: vi.fn(),
  FundingNotStartedError: class FundingNotStartedError extends Error {},
  fetchStatus: vi.fn(),
  reserve: vi.fn(),
  send: vi.fn(),
  sdkWallet: vi.fn(),
  unlock: vi.fn(),
  requestLightning: vi.fn(),
  beginLightningFunding: vi.fn(),
  resumeLightningFunding: vi.fn(),
  recordLightningFunding: vi.fn(),
  getLightningStatus: vi.fn(),
  lightningEnabled: vi.fn(),
  discoverLightning: vi.fn(),
  unlockSpend: vi.fn(async () => ({
    assertion: { credentialId: 'aa', clientDataJSON: 'bb', authenticatorData: 'cc', signature: 'dd' },
    phoneSecret: new Uint8Array(32).fill(7),
    scalar: new Uint8Array(32).fill(8),
  })),
}))

vi.mock('../vault/useLedgerPayments', () => ({ useLedgerPayments: mocks.ledger }))

vi.mock('../lib/vault/ledgerClient', async (original) => ({
  ...(await original<typeof import('../lib/vault/ledgerClient')>()),
  connectLedgerSavings: vi.fn(async () => ({ app: {}, close: mocks.closeLedger })),
  readLedgerSavingsAccount: mocks.readLedgerAccount,
}))

vi.mock('../lib/vault/spendingBitcoinStore', async (original) => ({
  ...(await original<typeof import('../lib/vault/spendingBitcoinStore')>()),
  readSpendingBitcoin: mocks.bitcoinRead,
}))
async function approveBitcoin(approve: (plan: unknown) => Promise<boolean>) {
  const plan = {
    operationId: 'bitcoin-operation',
    feeSats: 400,
    outputs: [{ script: '0014' + '43'.repeat(20), amountSats: 1500 }],
  }
  mocks.bitcoinRead.mockReturnValue({ operationId: plan.operationId, stage: 'prepared', plan: { plan } })
  return approve(plan)
}
vi.mock('../lib/vault/spendingBitcoinFunding', async (original) => ({
  ...(await original<typeof import('../lib/vault/spendingBitcoinFunding')>()),
  sendSpendingToBitcoin: mocks.bitcoinSend,
}))

vi.mock('../lib/vault/status', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/vault/status')>()
  return {
    ...original,
    fetchPublicStatus: vi.fn(async () => ({
      enrollmentMode: 'token',
      network: 'mutinynet',
      ledgerSavingsCapability: { version: 1, templateVersion: 'phone-ledger-guardian-savings-v1' },
    })),
    fetchVaultStatus: mocks.fetchStatus,
  }
})

vi.mock('../lib/vault/vtxo/spend', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/vault/vtxo/spend')>()
  return {
    ...original,
    reserveVaultVtxo: mocks.reserve,
    sendVaultVtxo: mocks.send,
    previewVaultVtxoSend: async (_status: unknown, destAddress: string, amountSats: number) => ({
      destAddress,
      amountSats,
      feeSats: 0,
    }),
    newVtxoSpendChallenge: () => 'aa'.repeat(32),
    createVtxoSpendUnlocker: () => ({
      unlock: mocks.unlockSpend,
      dispose: () => undefined,
    }),
  }
})

vi.mock('../lib/vault/vtxo/walletWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/vtxo/walletWorker')>()),
  ensureVaultWalletWorker: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/vault/savingsSpend', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/vault/savingsSpend')>()
  return { ...original, unlockPhoneBip340: mocks.unlock }
})

vi.mock('../lib/vault/lightning', () => ({
  VaultLightningFundingNotStartedError: mocks.FundingNotStartedError,
  assertVaultLightningQuoteCurrent: vi.fn(),
  beginVaultLightningFunding: mocks.beginLightningFunding,
  resumeVaultLightningFunding: mocks.resumeLightningFunding,
  loadVaultLightningFundingQuote: mocks.loadLightningFunding,
  recordVaultLightningFundingTxid: mocks.recordLightningFunding,
  getVaultLightningStatus: mocks.getLightningStatus,
  requestVaultLightningQuote: mocks.requestLightning,
  withVaultLightningRepository: vi.fn(async (_vaultId, run) => run({})),
  withVaultLightningLifecycleLock: vi.fn(async (_vaultId, run) => run()),
  withVaultLightningSdkWallet: mocks.sdkWallet,
  withVaultLightningTransport: vi.fn(async (_profile, run) => run({})),
}))

vi.mock('../lib/vault/lightningConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/lightningConfig')>()),
  vaultLightningSendEnabled: mocks.lightningEnabled,
  discoverVaultLightningSolver: mocks.discoverLightning,
}))

vi.mock('../vault/useVaultBalances', () => ({
  useVaultBalances: ({ status }: { status: VaultStatus | null }) => {
    if (status?.enrolled)
      vaultAccountRuntime(status).balances = {
        getSnapshot: () => ({ positions: { spending: { availableSats: mocks.availableSats } } }),
        dispose: () => {},
      } as never
    return {
      accountReads: accountBalanceReads(),
      snapshotFresh: true,
      history: [],
      positions: {
        spending: { availableSats: mocks.availableSats, pendingSats: 0, totalSats: mocks.availableSats },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
      refreshBalance: mocks.refreshBalance,
      loadOlderActivity: vi.fn().mockResolvedValue({ added: 0, exhausted: true }),
      olderActivity: { status: 'idle', error: '' },
      olderHistory: [],
    }
  },
}))

vi.mock('../vault/useRecoveryAlerts', () => ({ useRecoveryAlerts: () => '' }))
vi.mock('../vault/useRecoveryCommands', () => ({
  useRecoveryCommands: () => ({
    commands: {
      backupRecoveryArchive: vi.fn(),
      downloadRecoveryArchive: vi.fn(),
      downloadRecoveryKit: vi.fn().mockReturnValue(''),
      backupRecoveryKit: vi.fn().mockResolvedValue(false),
      restoreRecoveryKit: vi.fn().mockResolvedValue(undefined),
      recoverMatureBoarding: vi.fn().mockResolvedValue(''),
    },
    archiveStatus: '',
    archiveError: '',
    hasKit: false,
  }),
}))

const destination = new ArkAddress(
  hex.decode(golden.fixtures.arkdServerPub),
  hex.decode(golden.fixtures.exitHardwarePub),
  'tark',
).encode()

let status: VaultStatus

const reviewed: VaultVtxoSpendQuote = {
  operationId: '11'.repeat(16),
  bundleDigest: '22'.repeat(32),
  destAddress: destination,
  amountSats: 12_000,
  feeSats: 500,
  feePolicyDigest: '33'.repeat(32),
  reservationExpires: '2099-08-20T00:02:00Z',
  changeSats: 7_500,
  changeVout: 1,
}

function Probe() {
  const useSpending = useSpendingPayment()
  const nav = useVaultNavigation()
  const acct = useVaultAccount()
  const send = useVaultSend()
  const act = useVaultActivity()
  const inter = useVaultInteraction()
  const session = useSession()
  return (
    <div>
      <button onClick={() => useSpending.openPendingPayment('11'.repeat(16))}>Open pending</button>
      <button onClick={() => session.setPrivacyLock(!session.privacyLock)}>Toggle privacy</button>
      <span data-testid='privacy'>{String(session.privacyLock)}</span>
      <span data-testid='screen'>{nav.screen}</span>
      <span data-testid='account'>{acct.account}</span>
      <span data-testid='scan'>{String(send.scanOnSend)}</span>
      <span data-testid='ready'>{String(Boolean(session.status?.enrolled))}</span>
      <span data-testid='fee'>{send.spend.fee}</span>
      <span data-testid='destination'>{send.spend.address}</span>
      <span data-testid='error'>{inter.error}</span>
      <span data-testid='kind'>{send.lastTxKind}</span>
      <span data-testid='sent-amount'>{send.lastSend?.amount}</span>
      <span data-testid='sent-destination'>{send.lastSend?.address}</span>
      <span data-testid='activity'>{act.history[0]?.activity || ''}</span>
      <button type='button' onClick={() => send.setSpendDraft({ address: destination, amount: 12_000 })}>
        Set draft
      </button>
      <button type='button' onClick={() => nav.navigate('home')}>
        Go home
      </button>
      <button type='button' onClick={() => send.openSendScan()}>
        Open scan
      </button>
      <button type='button' onClick={() => send.setSpendDraft({ address: bitcoinDestination, amount: 1500 })}>
        Set Bitcoin draft
      </button>
      <button type='button' onClick={send.reviewSpend}>
        Review
      </button>
      <button type='button' onClick={() => send.setSpendDraft({ address: MUTINYNET_INVOICE, amount: 2_100 })}>
        Set Lightning draft
      </button>
      <button type='button' onClick={send.approveSend}>
        Approve
      </button>
      <button type='button' onClick={() => acct.setAccount('spend')}>
        Show Spending
      </button>
      <button type='button' onClick={() => acct.setAccount('savings')}>
        Show Savings
      </button>
      <button type='button' onClick={() => act.history[0] && act.openTx(act.history[0])}>
        Open first activity
      </button>
      <button type='button' onClick={() => useSpending.retryLightningRefund('44'.repeat(32))}>
        Return Lightning
      </button>
    </div>
  )
}

describe('VaultProvider reviewed VTXO reservation', () => {
  it('publishes privacy-only session changes through the complete snapshot', async () => {
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    expect(screen.getByTestId('privacy')).toHaveTextContent('false')
    fireEvent.click(screen.getByText('Toggle privacy'))
    expect(screen.getByTestId('privacy')).toHaveTextContent('true')
    expect(localStorage.getItem('arkade-vault-privacy-lock')).toBe('1')
    fireEvent.click(screen.getByText('Toggle privacy'))
    expect(screen.getByTestId('privacy')).toHaveTextContent('false')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    ledgerView = { record: { payment: { feeSats: 212 } } } as LedgerSavingsView
    mocks.ledgerReview.mockReset().mockResolvedValue(ledgerView)
    mocks.ledgerApprove.mockReset().mockResolvedValue(ledgerView)
    mocks.ledgerComplete.mockReset().mockResolvedValue('ab'.repeat(32))
    mocks.ledgerRefresh.mockReset().mockResolvedValue(undefined)
    mocks.ledger.mockReturnValue({
      view: null,
      pending: null,
      error: '',
      hardwarePhase: 'idle',
      completion: null,
      payments: {
        review: mocks.ledgerReview,
        approve: mocks.ledgerApprove,
        approveWithLedger: mocks.ledgerComplete,
        refresh: mocks.ledgerRefresh,
        cancelReview: vi.fn(),
        cancelHardware: vi.fn(),
        clearError: vi.fn(),
        consumeCompletion: vi.fn(),
        getSnapshot: vi.fn(() => ({ completion: null, view: ledgerView })),
      },
    })
    mocks.bitcoinSend.mockReset()
    mocks.bitcoinRead.mockReturnValue(null)
    mocks.refreshBalance.mockReset().mockResolvedValue(undefined)
    mocks.availableSats = 20000
    mocks.loadLightningFunding.mockResolvedValue(undefined)
    localStorage.clear()
    localStorage.setItem(SELECTED_VAULT_STORE, '12121212121212121212121212121212')
    const fixture = await ledgerRecoveryFixture(false, 'mutinynet', '12121212121212121212121212121212')
    status = fixture.status
    localStorage.setItem(`${ENROLL_STORE}:12121212121212121212121212121212`, JSON.stringify(fixture.enrollment))
    saveAddressPin(pinFromEnrolledStatus(status))
    mocks.fetchStatus.mockResolvedValue(status)
    mocks.lightningEnabled.mockReturnValue(false)
    mocks.discoverLightning.mockResolvedValue(MUTINYNET_LIGHTNING_SOLVER)
    mocks.reserve.mockResolvedValue(reviewed)
    mocks.send.mockRejectedValue(new VtxoReviewedReservationError())
    mocks.sdkWallet.mockImplementation(async (_secret, _status, run) => run({ repository: {} }))
    mocks.unlock.mockResolvedValue(new Uint8Array(32).fill(7))
    mocks.unlockSpend.mockClear()
    mocks.unlockSpend.mockResolvedValue({
      assertion: { credentialId: 'aa', clientDataJSON: 'bb', authenticatorData: 'cc', signature: 'dd' },
      phoneSecret: new Uint8Array(32).fill(7),
      scalar: new Uint8Array(32).fill(8),
    })
    mocks.beginLightningFunding.mockResolvedValue({
      rfqId: '44'.repeat(32),
      address: destination,
      amountSats: 2_125,
    })
    mocks.resumeLightningFunding.mockRejectedValue(new mocks.FundingNotStartedError('not started'))
    mocks.recordLightningFunding.mockResolvedValue(undefined)
    mocks.getLightningStatus.mockResolvedValue({ state: 'refunded' })
    mocks.requestLightning.mockResolvedValue({
      kind: 'lightning',
      invoice: MUTINYNET_INVOICE,
      invoiceAmountSats: 2_100,
      invoiceExpiresAt: 4_000_000_000,
      rfqId: '44'.repeat(32),
      fundAddress: destination,
      fundAmountSats: 2_125,
      corridorFeeSats: 25,
      validUntil: 4_000_000_000,
      refundLocktime: 4_000_000_100,
    })
  })

  async function openLedgerSavings(templateVersion = LEDGER_NATIVE_TEMPLATE) {
    const f = await ledgerRecoveryFixture()
    localStorage.setItem(SELECTED_VAULT_STORE, f.status.vaultId)
    localStorage.setItem(`${ENROLL_STORE}:${f.status.vaultId}`, JSON.stringify(f.enrollment))
    saveAddressPin(pinFromEnrolledStatus(f.status))
    mocks.fetchStatus.mockResolvedValue({ ...f.status, templateVersion })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByText('Show Savings'))
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    return f
  }

  it('reviews and approves Ledger Savings through its payment owner', async () => {
    await openLedgerSavings()
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(mocks.ledgerReview).toHaveBeenCalledWith(
      expect.objectContaining({ address: bitcoinDestination, amount: 1500 }),
    )
    expect(screen.getByTestId('fee')).toHaveTextContent('212')
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('ledger-sign'))
    expect(mocks.ledgerApprove).toHaveBeenCalledExactlyOnceWith({ address: bitcoinDestination, amount: 1500, fee: 212 })
    expect(mocks.bitcoinSend).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('rejects a Ledger review result after the draft changes', async () => {
    await openLedgerSavings()
    let complete!: (view: LedgerSavingsView) => void
    mocks.ledgerReview.mockReturnValue(
      new Promise<LedgerSavingsView>((resolve) => {
        complete = resolve
      }),
    )
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(mocks.ledgerReview).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('Set draft'))
    await act(async () => complete(ledgerView))
    expect(screen.getByTestId('error')).toHaveTextContent('Send details changed. Review the payment again.')
    expect(screen.getByTestId('screen')).not.toHaveTextContent('review')
    expect(mocks.ledgerApprove).not.toHaveBeenCalled()
  })

  it.each(['review', 'approve'])(
    'ignores a canceled Ledger %s result and leaves its error with the owner',
    async (command) => {
      await openLedgerSavings()
      let reject!: (error: Error) => void
      const method = command === 'review' ? mocks.ledgerReview : mocks.ledgerApprove
      method.mockReturnValue(
        new Promise((_resolve, fail) => {
          reject = fail
        }),
      )
      fireEvent.click(screen.getByText(command === 'review' ? 'Review' : 'Approve'))
      await waitFor(() => expect(method).toHaveBeenCalledOnce())
      fireEvent.click(screen.getByText('Go home'))
      await act(async () => reject(new DOMException('The active vault changed.', 'AbortError')))
      expect(screen.getByTestId('screen')).toHaveTextContent('home')
      expect(screen.getByTestId('error')).toHaveTextContent(/^$/)
    },
  )

  it('consumes a Ledger completion once and preserves its reviewed payment details', async () => {
    await openLedgerSavings()
    const binding = mocks.ledger.mock.results.at(-1)!.value
    const completed = { id: 1, txid: 'ab'.repeat(32), payment: { address: 'saved-recipient', amount: 4200, fee: 212 } }
    binding.completion = completed
    binding.payments.getSnapshot.mockReturnValue({ completion: completed, view: ledgerView })
    binding.payments.consumeCompletion.mockImplementation(() => {
      binding.payments.getSnapshot.mockReturnValue({ completion: null, view: ledgerView })
      return completed
    })
    fireEvent.click(screen.getByText('Toggle privacy'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(screen.getByTestId('sent-destination')).toHaveTextContent('saved-recipient')
    expect(screen.getByTestId('sent-amount')).toHaveTextContent('4200')
    fireEvent.click(screen.getByText('Go home'))
    mocks.refreshBalance = vi.fn().mockResolvedValue(undefined)
    fireEvent.click(screen.getByText('Toggle privacy'))
    expect(screen.getByTestId('screen')).toHaveTextContent('home')
    expect(binding.payments.consumeCompletion).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([
    'phone-hww-recovery-savings-v1',
    'phone-connector-recovery-savings-v1',
    'phone-connector-recovery-savings-v2',
    'unknown',
  ])('rejects retired or unknown Savings before signing: %s', async (templateVersion) => {
    expect(templateVersion).not.toBe(LEDGER_NATIVE_TEMPLATE)
    await openLedgerSavings(templateVersion)
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('This Savings program is no longer supported.'),
    )
    expect(mocks.ledgerReview).not.toHaveBeenCalled()
    expect(mocks.ledgerApprove).not.toHaveBeenCalled()
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.bitcoinSend).not.toHaveBeenCalled()
  })

  it('uses shared Bitcoin review and keeps Light Savings watch-only', async () => {
    const record = { enrollment: sharedSpendingEnrollment(), descriptor: sharedSpendingDescriptor }
    const bound = sharedSpendingStatus()
    mocks.bitcoinSend.mockImplementation(async (enrollment, status, _outputs, approve) => {
      expect(enrollment).toEqual(record.enrollment)
      expect(status.vaultId).toBe(record.descriptor.vaultId)
      expect(status.protectionTier).toBe('light')
      return (await approveBitcoin(approve))
        ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) }
        : { state: 'cancelled' }
    })
    localStorage.setItem(SELECTED_VAULT_STORE, bound.vaultId)
    localStorage.setItem(`${ENROLL_STORE}:${bound.vaultId}`, JSON.stringify(record.enrollment))
    saveAddressPin(pinFromEnrolledStatus(bound))
    mocks.fetchStatus.mockResolvedValue(bound)
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('home'))
    fireEvent.click(screen.getByText('Show Savings'))
    expect(screen.getByTestId('account')).toHaveTextContent('savings')
    fireEvent.click(screen.getByText('Show Spending'))
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(mocks.bitcoinSend).toHaveBeenCalledOnce()
  })

  async function renderLight() {
    const record = { enrollment: sharedSpendingEnrollment(), descriptor: sharedSpendingDescriptor }
    const bound = sharedSpendingStatus()
    localStorage.setItem(SELECTED_VAULT_STORE, bound.vaultId)
    localStorage.setItem(`${ENROLL_STORE}:${bound.vaultId}`, JSON.stringify(record.enrollment))
    saveAddressPin(pinFromEnrolledStatus(bound))
    mocks.fetchStatus.mockResolvedValue(bound)
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('home'))
    return { record, bound }
  }

  it.each(['paid', 'fee changed', 'cancelled'])(
    'preserves Light authorization in shared Arkade Review: %s',
    async (outcome) => {
      const { record, bound } = await renderLight()
      mocks.authorizeRenewals.mockClear()
      mocks.reserve.mockResolvedValue({ ...reviewed, feeSats: outcome === 'fee changed' ? 500 : 0 })
      mocks.send.mockResolvedValue({ txid: '55'.repeat(32), feeSats: 0 })
      if (outcome === 'cancelled') mocks.unlockSpend.mockRejectedValueOnce(new Error('Passkey cancelled'))
      fireEvent.click(screen.getByText('Set draft'))
      await act(async () => fireEvent.click(screen.getByText('Review')))
      expect(mocks.unlockSpend).not.toHaveBeenCalled()
      await act(async () => fireEvent.click(screen.getByText('Approve')))
      if (outcome === 'cancelled') {
        expect(mocks.authorizeRenewals).not.toHaveBeenCalled()
        expect(mocks.reserve).not.toHaveBeenCalled()
        expect(mocks.send).not.toHaveBeenCalled()
      } else {
        expect(mocks.authorizeRenewals).not.toHaveBeenCalled()
        expect(mocks.unlockSpend).toHaveBeenCalledOnce()
        if (outcome === 'fee changed') {
          expect(screen.getByTestId('screen')).toHaveTextContent('review')
          expect(screen.getByTestId('fee')).toHaveTextContent('500')
          expect(mocks.send).not.toHaveBeenCalled()
        } else {
          expect(mocks.send).toHaveBeenCalledWith(
            record.enrollment,
            bound,
            expect.any(Object),
            expect.any(Function),
            expect.any(AbortSignal),
          )
          expect(screen.getByTestId('screen')).toHaveTextContent('success')
        }
      }
    },
  )

  it('quotes and funds fresh Light Lightning through the shared Spending authorization', async () => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1000)
    const { record, bound } = await renderLight()
    const funding = { ...reviewed, amountSats: 2125, feeSats: 50 }
    mocks.reserve.mockResolvedValue(funding)
    mocks.send.mockImplementation(async (enrollment, status, quote, unlock) => {
      expect(enrollment).toEqual(record.enrollment)
      expect(status).toEqual(bound)
      expect(quote).toEqual(funding)
      expect(unlock).toBeUndefined()
      return { txid: '55'.repeat(32), feeSats: 50 }
    })
    mocks.authorizeRenewals.mockClear()
    fireEvent.click(screen.getByText('Set Lightning draft'))
    await act(async () => fireEvent.click(screen.getByText('Review')))
    expect(screen.getByTestId('screen')).toHaveTextContent('review')
    expect(screen.getByTestId('fee')).toHaveTextContent('75')
    expect(mocks.send).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByText('Approve')))
    expect(screen.getByTestId('screen')).toHaveTextContent('success')
    expect(screen.getByTestId('kind')).toHaveTextContent('lightning')
    expect(mocks.authorizeRenewals).not.toHaveBeenCalled()
    expect(mocks.recordLightningFunding).toHaveBeenCalledOnce()
  })

  it('cancels Light Bitcoin review when opening watch-only Savings', async () => {
    await renderLight()
    let approved: boolean | undefined
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
      approved = await approveBitcoin(approve)
      return { state: 'cancelled' }
    })
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Show Savings'))
    await waitFor(() => expect(approved).toBe(false))
    expect(screen.getByTestId('account')).toHaveTextContent('savings')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('reviews and completes a Bitcoin payment through the canonical send route with one confirmation', async () => {
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, outputs, approve) => {
      expect(outputs).toEqual([{ script: '0014' + '43'.repeat(20), amountSats: 1500 }])
      const approved = await approveBitcoin(approve)
      return approved ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) } : { state: 'cancelled' }
    })
    await renderLight()
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(screen.getByTestId('sent-amount')).toHaveTextContent('1500')
    expect(screen.getByTestId('sent-destination')).toHaveTextContent(bitcoinDestination)
    expect(mocks.bitcoinSend).toHaveBeenCalledOnce()
  })
  it.each(['uncertain', 'lost response'])(
    'leaves Review after approval when Bitcoin payment has %s',
    async (outcome) => {
      mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
        expect(await approveBitcoin(approve)).toBe(true)
        if (outcome === 'lost response') throw new Error('Payment response unavailable')
        return { state: 'uncertain' }
      })
      await renderLight()
      fireEvent.click(screen.getByText('Set Bitcoin draft'))
      fireEvent.click(screen.getByText('Review'))
      await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
      fireEvent.click(screen.getByText('Approve'))
      await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('home'))
      expect(mocks.bitcoinSend).toHaveBeenCalledOnce()
      expect(mocks.send).not.toHaveBeenCalled()
      expect(screen.getByTestId('sent-amount')).toBeEmptyDOMElement()
    },
  )

  it('cancels Bitcoin approval when leaving Review without submitting another payment', async () => {
    let approved: boolean | undefined
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
      approved = await approveBitcoin(approve)
      return { state: 'cancelled' }
    })
    await renderLight()
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Go home'))
    await waitFor(() => expect(approved).toBe(false))
    expect(screen.getByTestId('screen')).toHaveTextContent('home')
  })
  it('starts another vault with a fresh Ledger account without changing the enrolled vault', async () => {
    const errors = vi.spyOn(await import('../lib/vault/humanize'), 'humanizeVaultError')
    const { IDBFactory } = await import('fake-indexeddb')
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal(
      'navigator',
      new Proxy(navigator, {
        has: (target, key) => key === 'hid' || Reflect.has(target, key),
        get: (target, key) =>
          key === 'serviceWorker' ? { getRegistration: async () => undefined } : Reflect.get(target, key),
      }),
    )
    const origin = ledgerVectors.find((v) => v.input.network === 'mutinynet')!.input.hardware
    mocks.readLedgerAccount.mockResolvedValue(origin)
    const oldStatus = status
    mocks.fetchStatus.mockResolvedValue(oldStatus)
    localStorage.setItem(
      SETUP_STORE_KEY,
      JSON.stringify({
        ...emptySetupPlan(),
        acceptedDesign: true,
        complete: true,
        hardwarePub: oldStatus.externalOwnerWalletPub,
      }),
    )
    const savedEnrollment = localStorage.getItem(`${ENROLL_STORE}:12121212121212121212121212121212`)
    function SetupProbe() {
      const { screen } = useVaultNavigation()
      const session = useSession()
      return (
        <>
          <span data-testid='old-vault'>{session.status?.vaultId}</span>
          <span data-testid='new-key'>{session.setup.hardwarePub}</span>
          <span data-testid='setup-screen'>{screen}</span>
          <button onClick={() => session.acceptDesign('standard')}>Start another vault</button>
          {screen === 'hardware' ? <LedgerHardware /> : null}
        </>
      )
    }
    render(
      <VaultProvider>
        <SetupProbe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('old-vault')).toHaveTextContent('12121212121212121212121212121212'))
    await waitFor(() => expect(screen.getByTestId('setup-screen')).toHaveTextContent('home'))
    fireEvent.click(screen.getByText('Start another vault'))
    expect(screen.queryByRole('textbox')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect Ledger' })))
    expect(errors.mock.calls.map(([error]) => String(error))).toEqual([])
    await waitFor(() => expect(screen.getByTestId('setup-screen')).toHaveTextContent('conditions'))
    expect(screen.getByTestId('new-key')).toHaveTextContent(ledgerSpendingPublicKey(origin, 'mutinynet'))
    expect(mocks.closeLedger).toHaveBeenCalled()
    expect(localStorage.getItem(`${ENROLL_STORE}:12121212121212121212121212121212`)).toBe(savedEnrollment)
  })

  it('resumes an existing Arkade payment with no available balance and without another reservation', async () => {
    mocks.availableSats = 0
    persistVtxoSpend({
      ...reviewed,
      vaultId: '12121212121212121212121212121212',
      arkTxid: 'aa'.repeat(32),
      stage: 'operator-submitted',
    })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByText('Open pending'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(screen.getByTestId('destination')).toHaveTextContent(destination)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith(
      expect.anything(),
      status,
      reviewed,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('restores an authorized Lightning payment without a new quote, balance, or expiry gate', async () => {
    mocks.availableSats = 0
    const funding = { ...reviewed, amountSats: 2125, feeSats: 50 }
    persistVtxoSpend({
      ...funding,
      vaultId: '12121212121212121212121212121212',
      arkTxid: 'aa'.repeat(32),
      stage: 'operator-submitted',
    })
    const quote = {
      rfqId: '44'.repeat(32),
      invoice: MUTINYNET_INVOICE,
      invoiceAmountSats: 2100,
      fundAddress: destination,
      fundAmountSats: 2125,
      corridorFeeSats: 25,
      validUntil: 1,
      refundLocktime: 1,
    }
    mocks.loadLightningFunding.mockResolvedValue(quote)
    mocks.resumeLightningFunding.mockResolvedValue({ address: destination, amountSats: 2125 })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByText('Open pending'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(screen.getByTestId('destination')).toHaveTextContent(MUTINYNET_INVOICE)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    expect(mocks.requestLightning).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.beginLightningFunding).not.toHaveBeenCalled()
    expect(mocks.resumeLightningFunding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fundingFeeSats: 50 }),
      undefined,
      true,
    )
  })

  it('forgets a previous send destination when returning home or opening the Home camera', async () => {
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
    expect(screen.getByTestId('destination')).toHaveTextContent(destination)

    fireEvent.click(screen.getByRole('button', { name: 'Go home' }))
    expect(screen.getByTestId('screen')).toHaveTextContent('home')
    expect(screen.getByTestId('destination')).toHaveTextContent('')

    fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
    expect(screen.getByTestId('destination')).toHaveTextContent(destination)
    fireEvent.click(screen.getByRole('button', { name: 'Open scan' }))
    expect(screen.getByTestId('screen')).toHaveTextContent('send')
    expect(screen.getByTestId('destination')).toHaveTextContent('')
  })

  it.each(['spend', 'savings'] as const)('opens the Home camera without changing the %s account', async (account) => {
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    if (account === 'savings') fireEvent.click(screen.getByRole('button', { name: 'Show Savings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open scan' }))
    expect(screen.getByTestId('account')).toHaveTextContent(account)
    expect(screen.getByTestId('screen')).toHaveTextContent('send')
    expect(screen.getByTestId('scan')).toHaveTextContent('true')
    expect(screen.getByTestId('destination')).toBeEmptyDOMElement()
  })

  it('requires another review when the authoritative VTXO fee changes', async () => {
    mocks.send.mockResolvedValue({ txid: '55'.repeat(32), feeSats: 500, operationId: reviewed.operationId })

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.unlockSpend).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    await waitFor(() => expect(screen.getByTestId('fee')).toHaveTextContent('500'))
    expect(screen.getByTestId('screen')).toHaveTextContent('review')
    expect(screen.getByTestId('error')).toHaveTextContent('Review the updated total')
    expect(mocks.send).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(mocks.unlockSpend).toHaveBeenCalledTimes(2)
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.reserve).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)(
    'shows the completed payment before a delayed balance refresh can %s',
    async (outcome) => {
      let resolveRefresh!: () => void
      let rejectRefresh!: (error: Error) => void
      const refresh = new Promise<void>((resolve, reject) => {
        resolveRefresh = resolve
        rejectRefresh = reject
      })
      mocks.refreshBalance.mockReturnValue(refresh)
      mocks.reserve.mockResolvedValue({ ...reviewed, feeSats: 0 })
      mocks.send.mockResolvedValue({ txid: '55'.repeat(32), feeSats: 0, operationId: reviewed.operationId })
      render(
        <VaultProvider>
          <Probe />
        </VaultProvider>,
      )
      await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
      fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      try {
        await waitFor(() => expect(mocks.refreshBalance).toHaveBeenCalled())
        expect(screen.getByTestId('screen')).toHaveTextContent('success')
        expect(screen.getByTestId('sent-amount')).toHaveTextContent('12000')
        expect(screen.getByTestId('sent-destination')).toHaveTextContent(destination)
      } finally {
        await act(async () => {
          if (outcome === 'resolve') resolveRefresh()
          else rejectRefresh(new Error('balance service unavailable'))
        })
      }
      expect(screen.getByTestId('screen')).toHaveTextContent('success')
      expect(screen.getByTestId('error')).toBeEmptyDOMElement()
      expect(mocks.send).toHaveBeenCalledTimes(1)
    },
  )

  it('clears a stale review and returns to Send without reporting success', async () => {
    mocks.reserve.mockResolvedValueOnce({ ...reviewed, feeSats: 0 })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set draft' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(screen.getByTestId('fee')).toHaveTextContent('0')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('send'))
    expect(screen.getByTestId('fee')).toHaveTextContent('0')
    expect(screen.getByTestId('error')).toHaveTextContent('This fee quote expired or changed. Review the send again.')
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      status,
      { ...reviewed, feeSats: 0 },
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('does not open Home when a stored enrollment has no pinned Vault Program', async () => {
    clearAddressPin(localStorage, '12121212121212121212121212121212')
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('signin'))
  })

  it('returns a locked enrolled vault to Unlock instead of the completed setup screen', async () => {
    localStorage.setItem(SESSION_LOCK_STORE, '1')
    localStorage.setItem(
      SETUP_STORE_KEY,
      JSON.stringify({
        hardwarePub: '',
        recoveryPub: '',
        txCapSats: 50_000,
        dailyLimitSats: 100_000,
        acceptedDesign: true,
        complete: true,
      }),
    )

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('unlock'))
  })

  it('locks an enrolled vault behind passkey when privacy lock is on', async () => {
    localStorage.setItem('arkade-vault-privacy-lock', '1')

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('unlock'))
  })

  it('quotes and funds Lightning through the ordinary reviewed VTXO send', async () => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1_000)
    const lightningFunding = { ...reviewed, destAddress: destination, amountSats: 2_125, feeSats: 50 }
    const phoneSecret = new Uint8Array(32).fill(7)
    mocks.unlock.mockResolvedValue(phoneSecret)
    mocks.reserve.mockImplementation(async (_enrollment, _status, _dest, _amount, options) => {
      expect(options.phoneSecret).toBe(phoneSecret)
      expect(options.phoneSecret).toEqual(new Uint8Array(32).fill(7))
      return lightningFunding
    })
    mocks.send.mockResolvedValue({ txid: '55'.repeat(32), feeSats: 50 })

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set Lightning draft' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(screen.getByTestId('fee')).toHaveTextContent('75')
    expect(mocks.reserve).toHaveBeenCalledWith(expect.any(Object), status, destination, 2_125, {
      phoneSecret,
      signal: expect.any(AbortSignal),
    })
    expect(mocks.unlock).toHaveBeenCalledTimes(1)
    expect(phoneSecret).toEqual(new Uint8Array(32))

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(screen.getByTestId('kind')).toHaveTextContent('lightning')
    expect(mocks.beginLightningFunding).toHaveBeenCalledWith(
      expect.any(Object),
      '44'.repeat(32),
      expect.objectContaining({
        rfqId: '44'.repeat(32),
        address: destination,
        amountSats: 2_125,
        operationId: lightningFunding.operationId,
        bundleDigest: lightningFunding.bundleDigest,
        fundingFeeSats: 50,
      }),
    )
    expect(mocks.recordLightningFunding).toHaveBeenCalledWith(expect.any(Object), '44'.repeat(32), '55'.repeat(32))
    expect(mocks.send).toHaveBeenCalledWith(
      expect.any(Object),
      status,
      lightningFunding,
      undefined,
      expect.any(AbortSignal),
    )
    expect(mocks.sdkWallet.mock.calls[0]?.[3]).toEqual({ signal: expect.any(AbortSignal) })
  })

  it('requests the Lightning passkey in the Review click before asynchronous solver verification', async () => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1_000)
    let approve!: (secret: Uint8Array) => void
    mocks.unlock.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => (approve = resolve)))
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set Lightning draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(mocks.unlock).toHaveBeenCalledOnce()
    expect(mocks.discoverLightning).not.toHaveBeenCalled()
    // Re-entrant clicks cannot open a second approval or request another quote.
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(mocks.unlock).toHaveBeenCalledOnce()
    await act(async () => approve(new Uint8Array(32).fill(7)))
    await waitFor(() => expect(mocks.reserve).toHaveBeenCalledOnce())
    expect(mocks.discoverLightning).toHaveBeenCalledOnce()
  })

  it('records an expired invoice rejection before requesting the passkey', async () => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue(4_000_000_000_000)
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Set Lightning draft' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
    expect(screen.getByTestId('error')).toHaveTextContent('This Lightning invoice has expired.')
    expect(getLogs()).toContainEqual(
      expect.objectContaining({ msg: 'Lightning payment validation: This Lightning invoice has expired.' }),
    )
    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.discoverLightning).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()
  })

  it.each(['solver verification', 'quote', 'reservation'])(
    'logs the failed Lightning %s stage and clears the phone key',
    async (stage) => {
      mocks.lightningEnabled.mockReturnValue(true)
      vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1_000)
      const phoneSecret = new Uint8Array(32).fill(7)
      mocks.unlock.mockResolvedValue(phoneSecret)
      const failed =
        stage === 'solver verification'
          ? mocks.discoverLightning
          : stage === 'quote'
            ? mocks.requestLightning
            : mocks.reserve
      failed.mockRejectedValue(new Error('test rejection'))
      render(
        <VaultProvider>
          <Probe />
        </VaultProvider>,
      )
      await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
      fireEvent.click(screen.getByRole('button', { name: 'Set Lightning draft' }))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review' })))
      await waitFor(() => expect(screen.getByTestId('error')).not.toBeEmptyDOMElement())
      expect(getLogs()).toContainEqual(
        expect.objectContaining({ level: 'error', msg: `Lightning payment ${stage}: test rejection` }),
      )
      expect(phoneSecret).toEqual(new Uint8Array(32))
      expect(mocks.send).not.toHaveBeenCalled()
      if (stage === 'solver verification') {
        expect(mocks.requestLightning).not.toHaveBeenCalled()
        expect(mocks.reserve).not.toHaveBeenCalled()
      }
    },
  )

  it('reacquires and clears the phone key for a package-managed refund retry', async () => {
    vi.stubEnv('VITE_VAULT_LIGHTNING_SEND', 'true')
    const phoneSecret = new Uint8Array(32).fill(7)
    mocks.unlock.mockResolvedValueOnce(phoneSecret)

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Return Lightning' })))

    expect(mocks.getLightningStatus).toHaveBeenCalledWith(expect.any(Object), '44'.repeat(32))
    expect(mocks.sdkWallet.mock.calls.at(-1)?.[3]).toEqual({
      refundRfqId: '44'.repeat(32),
      signal: expect.any(AbortSignal),
    })
    expect(phoneSecret).toEqual(new Uint8Array(32))
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })
})
