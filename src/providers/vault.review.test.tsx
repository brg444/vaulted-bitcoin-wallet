import { lightTestEnrollment, lightTestStatus } from '../lib/vault/light/testdata/helpers'
import { Address, OutScript, TEST_NETWORK } from '@scure/btc-signer'
const bitcoinDestination = Address(TEST_NETWORK).encode(OutScript.decode(hex.decode('0014' + '43'.repeat(20))))
import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION } from '../lib/vault/constants'
import { ENROLL_STORE, SELECTED_VAULT_STORE, SESSION_LOCK_STORE } from '../lib/vault/enrollmentStore'
import { MUTINYNET_INVOICE, MUTINYNET_INVOICE_TIMESTAMP } from '../lib/vault/lightningTestUtils'
import { SAVINGS_TEMPLATE } from '../lib/vault/program/constants'
import { emptySetupPlan, SETUP_STORE_KEY } from '../lib/vault/setupPlan'
import type { VaultStatus } from '../lib/vault/types'
import golden from '../lib/vault/vtxo/testdata/vault-policy-v1-tree.json'
import { persistVtxoSpend, VtxoReviewedReservationError, type VaultVtxoSpendQuote } from '../lib/vault/vtxo/spend'
import { VaultContext, VaultProvider } from './vault'
import VaultHardware from '../screens/Vault/onboard/Hardware'
import { CONNECTOR_TEST_DESCRIPTOR, CONNECTOR_TEST_PUB } from '../test/e2e-vault/fixtures/connector'

const mocks = vi.hoisted(() => ({
  authorizeRenewals: vi.fn(async () => null),
  bitcoinSend: vi.fn(),
  signerOutputs: vi.fn(),
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
  loadHandoff: vi.fn(),
  lightningEnabled: vi.fn(),
  unlockSpend: vi.fn(async () => ({
    assertion: { credentialId: 'aa', clientDataJSON: 'bb', authenticatorData: 'cc', signature: 'dd' },
    phoneSecret: new Uint8Array(32).fill(7),
    scalar: new Uint8Array(32).fill(8),
  })),
}))

vi.mock('../lib/vault/light/guardianDelegation', () => ({ authorizeGuardianRenewals: mocks.authorizeRenewals }))

vi.mock('../lib/vault/spendingBitcoinFunding', async (original) => ({
  ...(await original<typeof import('../lib/vault/spendingBitcoinFunding')>()),
  sendSpendingToBitcoin: mocks.bitcoinSend,
  signerFundingOutputs: mocks.signerOutputs,
}))

vi.mock('../lib/vault/status', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/vault/status')>()
  return {
    ...original,
    fetchPublicStatus: vi.fn(async () => ({ enrollmentMode: 'token' })),
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

vi.mock('../lib/vault/savingsHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/savingsHandoff')>()),
  loadPendingSavingsHandoff: mocks.loadHandoff,
}))

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
}))

vi.mock('../vault/useVaultBalances', () => ({
  useVaultBalances: () => ({
    balanceError: '',
    balancesLoaded: true,
    history: [],
    positions: {
      spending: { availableSats: mocks.availableSats, pendingSats: 0, totalSats: mocks.availableSats },
      savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
    },
    refreshBalance: mocks.refreshBalance,
    refreshingBalance: false,
  }),
}))

vi.mock('../vault/useVaultSession', () => ({
  useVaultSession: () => ({
    enableOtherDevices: vi.fn().mockResolvedValue(undefined),
    enroll: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
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

const destination = new ArkAddress(
  hex.decode(golden.fixtures.arkdServerPub),
  hex.decode(golden.fixtures.exitHardwarePub),
  'tark',
).encode()

const status: VaultStatus = {
  enrolled: true,
  network: 'mutinynet',
  clientOrigin: 'https://vault.test',
  rpId: 'vault.test',
  vaultId: 'vault-a',
  templateVersion: SAVINGS_TEMPLATE,
  policyVersion: POLICY_VERSION,
  protectionTier: 'standard',
  savingsAddress: '',
  savingsScript: '',
  periodAllowance: 100_000,
  periodSpent: 0,
  periodRemaining: 100_000,
  txCap: 50_000,
  absoluteFeeCap: 5_000,
  feerateCapSatVb: 10,
  spendingArkAddress: destination,
}

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
  const vault = useContext(VaultContext)
  return (
    <div>
      <button onClick={() => vault.openPendingPayment('11'.repeat(16))}>Open pending</button>
      <span data-testid='screen'>{vault.screen}</span>
      <span data-testid='account'>{vault.account}</span>
      <span data-testid='scan'>{String(vault.scanOnSend)}</span>
      <span data-testid='ready'>{String(Boolean(vault.status?.enrolled))}</span>
      <span data-testid='fee'>{vault.spend.fee}</span>
      <span data-testid='destination'>{vault.spend.address}</span>
      <span data-testid='error'>{vault.error}</span>
      <span data-testid='kind'>{vault.lastTxKind}</span>
      <span data-testid='sent-amount'>{vault.lastSend?.amount}</span>
      <span data-testid='sent-destination'>{vault.lastSend?.address}</span>
      <span data-testid='activity'>{vault.history[0]?.activity || ''}</span>
      <button type='button' onClick={() => vault.setSpendDraft({ address: destination, amount: 12_000 })}>
        Set draft
      </button>
      <button type='button' onClick={() => vault.navigate('home')}>
        Go home
      </button>
      <button type='button' onClick={() => vault.openSendScan()}>
        Open scan
      </button>
      <button type='button' onClick={() => vault.setSpendDraft({ address: bitcoinDestination, amount: 1500 })}>
        Set Bitcoin draft
      </button>
      <button type='button' onClick={vault.fundSavingsSigner}>
        Fund signer
      </button>
      <button type='button' onClick={vault.reviewSpend}>
        Review
      </button>
      <button type='button' onClick={() => vault.setSpendDraft({ address: MUTINYNET_INVOICE, amount: 2_100 })}>
        Set Lightning draft
      </button>
      <button type='button' onClick={vault.approveSend}>
        Approve
      </button>
      <button type='button' onClick={() => vault.setAccount('savings')}>
        Show Savings
      </button>
      <button type='button' onClick={() => vault.history[0] && vault.openTx(vault.history[0])}>
        Open first activity
      </button>
      <button type='button' onClick={() => vault.retryLightningRefund('44'.repeat(32))}>
        Return Lightning
      </button>
    </div>
  )
}

describe('VaultProvider reviewed VTXO reservation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    mocks.bitcoinSend.mockReset()
    mocks.refreshBalance.mockReset().mockResolvedValue(undefined)
    mocks.availableSats = 20000
    mocks.loadLightningFunding.mockResolvedValue(undefined)
    localStorage.clear()
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
    mocks.fetchStatus.mockResolvedValue(status)
    mocks.loadHandoff.mockReturnValue(null)
    mocks.lightningEnabled.mockReturnValue(false)
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

  it('uses shared Bitcoin review and keeps Light Savings watch-only', async () => {
    const record = await lightTestEnrollment()
    const onSavings = vi.fn()
    const bound = lightTestStatus(record.descriptor) as VaultStatus
    mocks.bitcoinSend.mockImplementation(async (enrollment, status, _outputs, approve) => {
      expect(enrollment).toEqual(record.enrollment)
      expect(status.vaultId).toBe(record.descriptor.vaultId)
      expect(status.protectionTier).toBe('light')
      return (await approve({ feeSats: 400 }))
        ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) }
        : { state: 'cancelled' }
    })
    render(
      <VaultProvider
        lightSession={{
          record,
          status: bound,
          watchedSavingsSats: 1234,
          onSavings,
          onSecurity: vi.fn(),
          onSettings: vi.fn(),
          onRecovery: vi.fn(),
          onLock: vi.fn(),
        }}
      >
        <Probe />
      </VaultProvider>,
    )
    fireEvent.click(screen.getByText('Show Savings'))
    expect(onSavings).toHaveBeenCalledOnce()
    expect(screen.getByTestId('account')).toHaveTextContent('spend')
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(mocks.bitcoinSend).toHaveBeenCalledOnce()
  })

  async function renderLight() {
    const record = await lightTestEnrollment()
    const bound = lightTestStatus(record.descriptor) as VaultStatus
    render(
      <VaultProvider
        lightSession={{
          record,
          status: bound,
          watchedSavingsSats: 1234,
          onSavings: vi.fn(),
          onSecurity: vi.fn(),
          onSettings: vi.fn(),
          onRecovery: vi.fn(),
          onLock: vi.fn(),
        }}
      >
        <Probe />
      </VaultProvider>,
    )
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
        expect(mocks.authorizeRenewals).toHaveBeenCalledExactlyOnceWith(record.descriptor, expect.any(Uint8Array))
        expect(mocks.unlockSpend).toHaveBeenCalledOnce()
        if (outcome === 'fee changed') {
          expect(screen.getByTestId('screen')).toHaveTextContent('review')
          expect(screen.getByTestId('fee')).toHaveTextContent('500')
          expect(mocks.send).not.toHaveBeenCalled()
        } else {
          expect(mocks.send).toHaveBeenCalledWith(record.enrollment, bound, expect.any(Object), expect.any(Function))
          expect(screen.getByTestId('screen')).toHaveTextContent('success')
        }
      }
    },
  )

  it('quotes and funds Light Lightning through shared Review with its own renewal ceremony', async () => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1000)
    const { record, bound } = await renderLight()
    const funding = { ...reviewed, amountSats: 2125, feeSats: 50 }
    mocks.reserve.mockResolvedValue(funding)
    mocks.send.mockImplementation(async (enrollment, status, quote, unlock) => {
      expect(enrollment).toEqual(record.enrollment)
      expect(status).toEqual(bound)
      expect(quote).toEqual(funding)
      const ceremony = unlock(enrollment, status, quote.bundleDigest)
      try {
        await ceremony.unlock()
      } finally {
        ceremony.dispose()
      }
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
    expect(mocks.authorizeRenewals).toHaveBeenCalledOnce()
    expect(mocks.recordLightningFunding).toHaveBeenCalledOnce()
  })

  it('cancels Light Bitcoin review when opening watch-only Savings', async () => {
    await renderLight()
    let approved: boolean | undefined
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
      approved = await approve({ feeSats: 400 })
      return { state: 'cancelled' }
    })
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Show Savings'))
    await waitFor(() => expect(approved).toBe(false))
    expect(screen.getByTestId('account')).toHaveTextContent('spend')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('reviews and completes a Bitcoin payment through the canonical send route with one confirmation', async () => {
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, outputs, approve) => {
      expect(outputs).toEqual([{ script: '0014' + '43'.repeat(20), amountSats: 1500 }])
      const approved = await approve({ feeSats: 400 })
      return approved ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) } : { state: 'cancelled' }
    })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
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
        expect(await approve({ feeSats: 400 })).toBe(true)
        if (outcome === 'lost response') throw new Error('Payment response unavailable')
        return { state: 'uncertain' }
      })
      render(
        <VaultProvider>
          <Probe />
        </VaultProvider>,
      )
      await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
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
  it('funds signer approval outputs through the same Review and confirmation', async () => {
    const outputs = Array.from({ length: 2 }, () => ({ script: '0014' + '43'.repeat(20), amountSats: 500 }))
    mocks.signerOutputs.mockResolvedValue({ address: bitcoinDestination, outputs })
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, actual, approve) => {
      expect(actual).toEqual(outputs)
      return (await approve({ feeSats: 400 }))
        ? { state: 'submitted', commitmentTxid: 'ab'.repeat(32) }
        : { state: 'cancelled' }
    })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByText('Fund signer'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    expect(screen.getByTestId('fee')).toHaveTextContent('400')
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('success'))
    expect(screen.getByTestId('sent-amount')).toHaveTextContent('1000')
    expect(mocks.bitcoinSend).toHaveBeenCalledOnce()
  })
  it('cancels Bitcoin approval when leaving Review without submitting another payment', async () => {
    let approved: boolean | undefined
    mocks.bitcoinSend.mockImplementation(async (_enrollment, _status, _outputs, approve) => {
      approved = await approve({ feeSats: 400 })
      return { state: 'cancelled' }
    })
    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByText('Set Bitcoin draft'))
    fireEvent.click(screen.getByText('Review'))
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('review'))
    fireEvent.click(screen.getByText('Go home'))
    await waitFor(() => expect(approved).toBe(false))
    expect(screen.getByTestId('screen')).toHaveTextContent('home')
  })
  it('starts another vault with an editable descriptor and accepts a different hardware key', async () => {
    const oldStatus = { ...status, externalOwnerWalletPub: golden.fixtures.exitHardwarePub }
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
    const savedEnrollment = localStorage.getItem(`${ENROLL_STORE}:vault-a`)
    function SetupProbe() {
      const vault = useContext(VaultContext)
      return (
        <>
          <span data-testid='old-vault'>{vault.status?.vaultId}</span>
          <span data-testid='new-key'>{vault.setup.hardwarePub}</span>
          <span data-testid='setup-screen'>{vault.screen}</span>
          <button onClick={() => vault.acceptDesign('standard')}>Start another vault</button>
          {vault.screen === 'hardware' ? <VaultHardware /> : null}
        </>
      )
    }
    render(
      <VaultProvider>
        <SetupProbe />
      </VaultProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('old-vault')).toHaveTextContent('vault-a'))
    fireEvent.click(screen.getByText('Start another vault'))
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    const input = screen.getByRole('textbox', { name: 'Wallet descriptor' })
    expect(input).toHaveValue('')
    expect(input).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Use this hardware key' })).toBeDisabled()
    fireEvent.change(input, { target: { value: CONNECTOR_TEST_DESCRIPTOR } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this hardware key' }))
    await waitFor(() => expect(screen.getByTestId('setup-screen')).toHaveTextContent('conditions'))
    expect(screen.getByTestId('new-key')).toHaveTextContent(CONNECTOR_TEST_PUB)
    expect(localStorage.getItem(`${ENROLL_STORE}:vault-a`)).toBe(savedEnrollment)
  })

  it('resumes an existing Arkade payment with no available balance and without another reservation', async () => {
    mocks.availableSats = 0
    persistVtxoSpend({ ...reviewed, vaultId: 'vault-a', arkTxid: 'aa'.repeat(32), stage: 'operator-submitted' })
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
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), status, reviewed, expect.any(Function))
  })

  it('restores an authorized Lightning payment without a new quote, balance, or expiry gate', async () => {
    mocks.availableSats = 0
    const funding = { ...reviewed, amountSats: 2125, feeSats: 50 }
    persistVtxoSpend({ ...funding, vaultId: 'vault-a', arkTxid: 'aa'.repeat(32), stage: 'operator-submitted' })
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
    )
  })

  it('does not open Home when a stored enrollment has no pinned Vault Program', async () => {
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
    expect(mocks.reserve).toHaveBeenCalledWith(expect.any(Object), status, destination, 2_125, { phoneSecret })
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
    expect(mocks.send).toHaveBeenCalledWith(expect.any(Object), status, lightningFunding, undefined)
    expect(mocks.sdkWallet.mock.calls[0]?.[3]).toBeUndefined()
  })

  it.each(['quote', 'reservation'])('clears the unlocked phone key when Lightning %s fails', async (stage) => {
    mocks.lightningEnabled.mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1_000)
    const phoneSecret = new Uint8Array(32).fill(7)
    mocks.unlock.mockResolvedValue(phoneSecret)
    const failed = stage === 'quote' ? mocks.requestLightning : mocks.reserve
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
    expect(phoneSecret).toEqual(new Uint8Array(32))
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('restores a pending Savings handoff and reopens its hardware step', async () => {
    mocks.loadHandoff.mockReturnValue({
      version: 1,
      vaultId: 'vault-a',
      psbtHex: 'phone-signed-psbt',
      destAddress: destination,
      amountSats: 12_000,
      feeSats: 1_500,
      network: 'mutinynet',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Show Savings' }))
    await waitFor(() => expect(screen.getByTestId('activity')).toHaveTextContent('savings-handoff'))
    fireEvent.click(screen.getByRole('button', { name: 'Open first activity' }))
    expect(screen.getByTestId('screen')).toHaveTextContent('handoff')
    expect(screen.getByTestId('fee')).toHaveTextContent('1500')
  })

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
    expect(mocks.sdkWallet.mock.calls.at(-1)?.[3]).toEqual({ refundRfqId: '44'.repeat(32) })
    expect(phoneSecret).toEqual(new Uint8Array(32))
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })
})
