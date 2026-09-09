import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestArkProvider, RestEmulatorProvider } from '@arkade-os/sdk'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import LightningReceive from './LightningReceive'
import { networkPins } from '../../lib/vault/networkPins'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  approve: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  backup: vi.fn(),
  reconcile: vi.fn(),
}))
vi.mock('../../lib/vault/lightningReceive', async (original) => ({
  ...(await original<typeof import('../../lib/vault/lightningReceive')>()),
  requestVaultLightningReceive: mocks.request,
  approveVaultLightningReceive: mocks.approve,
}))
vi.mock('../../lib/vault/lightningReceiveClaim', () => ({ reconcileVaultLightningReceives: mocks.reconcile }))
vi.mock('../../lib/vault/lightning', () => ({
  discoverVaultLightningSolver: async () => ({ network: 'bitcoin' }),
  withVaultLightningTransport: async (_profile: unknown, run: (t: object) => unknown) => run({}),
}))
vi.mock('../../lib/vault/lightningLock', () => ({
  withVaultLightningLifecycleLock: async (_id: unknown, run: () => unknown) => run(),
}))
vi.mock('../../lib/vault/vtxo/walletWorker', () => ({
  withVaultWalletState: async (_status: unknown, run: (s: object) => unknown) =>
    run({ swapRepository: { getAllRfqSwaps: mocks.list, getRfqSwap: mocks.read }, contracts: {} }),
}))
vi.mock('../../components/QrCode', () => ({
  default: ({ value }: { value: string }) => <span data-testid='invoice-qr'>{value}</span>,
}))
vi.mock('./qg/QgScreen', () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
  QgPrimary: ({
    label,
    loading,
    disabled,
    onClick,
  }: {
    label: string
    loading?: boolean
    disabled?: boolean
    onClick: () => void
  }) => (
    <button disabled={loading || disabled} onClick={onClick}>
      {label}
    </button>
  ),
  QgSecondary: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
}))
function record(expired = false) {
  const now = Math.floor(Date.now() / 1000)
  return {
    kind: 'lightning_receive',
    rfqId: 'ab'.repeat(32),
    amount: 1000,
    state: 'pending',
    createdAt: now,
    profile: {
      vaultLightningReceive: {
        version: 1,
        network: 'bitcoin',
        vaultId: 'aa',
        phonePub: '02' + '11'.repeat(32),
        estimatedPaySats: 1004,
        payoutAddress: 'ark1payout',
        invoice: 'lnbc-fixture',
        invoiceExpiresAt: now + (expired ? -1 : 300),
        quote: { from_amount: 1004, to_amount: 1000, refund_locktime: now + 3600 },
      },
    },
  }
}
function show() {
  const value = {
    status: { enrolled: true, vaultId: 'aa', network: 'mainnet', arkadeCosignerOrigin: 'https://emulator.invalid' },
    backupRecoveryArchive: mocks.backup,
    refreshBalance: async () => {},
  } as unknown as VaultContextProps
  return render(
    <VaultContext.Provider value={value}>
      <LightningReceive status={value.status!} refreshBalance={value.refreshBalance} onBack={() => {}} />
    </VaultContext.Provider>,
  )
}
beforeEach(() => {
  mocks.list.mockResolvedValue([])
  mocks.read.mockResolvedValue(undefined)
  mocks.backup.mockRejectedValue(new Error('Cloud backup is unavailable'))
  mocks.request.mockResolvedValue(record())
  mocks.approve.mockImplementation(async () => {
    const r = record()
    return { ...r, profile: { vaultLightningReceive: { ...r.profile.vaultLightningReceive, approvedPaySats: 1004 } } }
  })
  vi.spyOn(RestEmulatorProvider.prototype, 'getInfo').mockResolvedValue({
    signerPubkey: networkPins('mainnet').emulatorSignerPub,
  } as never)
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue({} as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
async function create(amount = '1000') {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox'), amount)
  await user.click(screen.getByRole('button', { name: 'Create invoice' }))
}
describe('Lightning receive screen', () => {
  it.each(['pending', 'settled', 'expired'])('opens the amount prompt with an earlier %s invoice', async (state) => {
    const previous = { ...record(state === 'expired'), state: state === 'expired' ? 'pending' : state }
    mocks.list.mockResolvedValue([previous])
    show()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('requests and reviews an invoice without starting authentication or backup', async () => {
    show()
    await create()
    await screen.findByRole('button', { name: 'Confirm fee and show invoice' })
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.backup).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
  })
  it('shares after local fee approval even when cloud backup is unavailable', async () => {
    const approved = await mocks.approve()
    mocks.approve.mockClear()
    let finish!: (value: typeof approved) => void
    mocks.approve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    show()
    await create()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Confirm fee and show invoice' }))
    expect(screen.getByRole('button', { name: 'Saving invoice…' })).toBeDisabled()
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
    await act(async () => finish(approved))
    expect(await screen.findByTestId('invoice-qr')).toHaveTextContent('lightning:lnbc-fixture')
    expect(mocks.approve).toHaveBeenCalledOnce()
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('keeps the QR hidden if local fee approval cannot be saved', async () => {
    mocks.approve.mockRejectedValue(new Error('disk full'))
    show()
    await create()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Confirm fee and show invoice' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy invoice' })).toBeNull()
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('reuses an active invoice for the requested amount without a cloud backup marker or authentication', async () => {
    mocks.list.mockResolvedValue([await mocks.approve()])
    show()
    await create()
    await screen.findByTestId('invoice-qr')
    expect(mocks.backup).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('does not substitute an earlier invoice for a different requested amount', async () => {
    mocks.list.mockResolvedValue([record()])
    show()
    await create('2000')
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ amountSats: 2000 })))
    expect(await mocks.list()).toHaveLength(1)
  })
  it('shows the exact sender total and fee above the estimate before approval', async () => {
    const r = record()
    r.profile.vaultLightningReceive.quote.from_amount = 1006
    mocks.request.mockResolvedValue(r)
    show()
    await create()
    await screen.findByRole('button', { name: 'Confirm fee and show invoice' })
    expect(screen.getByText('1,006 sats')).toBeTruthy()
    expect(screen.getByText('6 sats')).toBeTruthy()
    expect(screen.getByText(/2 sats above/)).toBeTruthy()
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
  })
  it('shows a new receipt during polling but returns to amount entry when reopened', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval')
    const pending = await mocks.approve()
    mocks.list.mockResolvedValue([pending])
    mocks.read.mockResolvedValue(pending)
    const first = show()
    await create()
    await screen.findByTestId('invoice-qr')
    const settled = { ...pending, state: 'settled' }
    mocks.reconcile.mockImplementationOnce(async () => {
      mocks.read.mockResolvedValue(settled)
    })
    const poll = timer.mock.calls.find((call) => call[1] === 5000)![0] as () => void
    await act(async () => {
      poll()
    })
    expect(await screen.findByRole('status')).toHaveTextContent('1,000 sats received in Spending.')
    expect(screen.queryByTestId('invoice-qr')).toBeNull()
    first.unmount()
    mocks.list.mockResolvedValue([settled])
    show()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('allows a new invoice after expiry while retaining the earlier recovery record', async () => {
    const expired = record(true)
    mocks.list.mockResolvedValue([expired])
    show()
    await create()
    await screen.findByRole('button', { name: 'Confirm fee and show invoice' })
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(await mocks.list()).toEqual([expired])
    expect(mocks.backup).not.toHaveBeenCalled()
  })
})
