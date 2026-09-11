import { LEDGER_NATIVE_TEMPLATE } from '../../lib/vault/program/ledgerNativeKeys'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { VaultContext, type VaultAccount, type VaultContextProps } from '../../vault/context'
import VaultReceive from './Receive'
import { DUAL_CONNECTOR_TEMPLATE } from '../../lib/vault/program/connector'

const gates = vi.hoisted(() => ({ receive: false, address: false }))
vi.mock('../../lib/vault/lightningConfig', () => ({ vaultLightningReceiveEnabled: () => gates.receive }))
vi.mock('../../lib/vault/lnurl', () => ({
  lightningAddressEnabled: () => gates.address,
  loadLightningAddress: () => ({ active: true, address: 'alex@ln.getvaulted.xyz' }),
}))
vi.mock('./LightningAddress', () => ({
  default: ({ primary }: { primary?: boolean }) => (
    <div data-testid='primary-lightning' data-primary={String(primary)}>
      alex@ln.getvaulted.xyz
    </div>
  ),
}))
vi.mock('./LightningReceive', () => ({
  default: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>Invoice amount; back to Receive</button>,
}))

vi.mock('./ConnectorSetup', () => ({ default: () => <h1>Savings signer setup</h1> }))

vi.mock('../../components/QrCode', () => ({
  default: ({ large, value }: { large?: boolean; value: string }) => (
    <div data-large={String(Boolean(large))} data-testid='receive-qr'>
      {value}
    </div>
  ),
}))

function renderReceive(account: VaultAccount, connector = false, lightning = false, light = false) {
  const refreshBalance = vi.fn().mockResolvedValue(undefined)
  const value = {
    account,
    ...(lightning ? { status: { network: 'mainnet', vaultId: 'fixture-vault' } } : {}),
    ...(connector ? { status: { templateVersion: DUAL_CONNECTOR_TEMPLATE } } : {}),
    boardingAddress: light ? '' : 'tb1qboarding',
    liveNetwork: true,
    navigate: () => {},
    refreshBalance,
    savingsAddress: 'tb1qsavings',
    spendingArkAddress: 'tark1spending',
  } as unknown as VaultContextProps
  const rendered = render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultReceive />
      </VaultContext.Provider>
    </ToastProvider>,
  )
  return { ...rendered, refreshBalance }
}

function renderReceiveWithoutAddresses(account: VaultAccount) {
  const value = {
    account,
    boardingAddress: '',
    liveNetwork: true,
    navigate: () => {},
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    savingsAddress: '',
    spendingArkAddress: '',
  } as unknown as VaultContextProps
  return render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultReceive />
      </VaultContext.Provider>
    </ToastProvider>,
  )
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'canShare')
})

describe('Vault receive', () => {
  beforeEach(() => {
    gates.receive = false
    gates.address = false
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows one Spending BIP21 request with Arkade and boarding addresses', () => {
    renderReceive('spend')
    expect(screen.getByRole('heading', { name: 'Receive' })).toBeTruthy()
    expect(screen.queryByText('Works with Arkade and Bitcoin wallets.')).toBeNull()
    expect(screen.getByTestId('receive-qr').textContent).toBe('bitcoin:tb1qboarding?ark=tark1spending')
    expect(screen.getByTestId('receive-qr')).toHaveAttribute('data-large', 'true')
    expect(screen.queryByTestId('receive-address')).toBeNull()
    expect(screen.getByTestId('receive-arkade-address')).toBeTruthy()
    expect(screen.getByTestId('receive-bitcoin-address')).toBeTruthy()
    expect(screen.queryByText(/Testnet/)).toBeNull()
    expect(screen.queryByText('One payment request')).toBeNull()
    expect(screen.queryByText(/Confirmed Bitcoin deposits/)).toBeNull()
    expect(screen.queryByText('Savings')).toBeNull()
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy payment request' })).toBeNull()
  })

  it('keeps Light receiving usable when Lightning is disabled and no Bitcoin deposit address exists', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { share, canShare: () => true })
    renderReceive('spend', false, false, true)
    expect(screen.getByTestId('receive-qr')).toHaveTextContent('tark1spending')
    expect(screen.queryByTestId('receive-bitcoin-address')).toBeNull()
    await userEvent.click(screen.getByTestId('receive-share'))
    expect(share).toHaveBeenCalledWith({ title: 'Vaulted payment request', text: 'tark1spending' })
  })

  it('opens the native share sheet with the BIP21 payment request', async () => {
    const user = userEvent.setup()
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)
    Object.assign(navigator, { share, canShare })

    renderReceive('spend')
    await user.click(screen.getByTestId('receive-share'))
    expect(share).toHaveBeenCalledWith({
      title: 'Vaulted payment request',
      text: 'bitcoin:tb1qboarding?ark=tark1spending',
    })
  })

  it('keeps Savings receive on the same QR, address row, and Share layout', async () => {
    const user = userEvent.setup()
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)
    Object.assign(navigator, { share, canShare })

    renderReceive('savings')
    expect(screen.getByRole('heading', { name: 'Receive' })).toBeTruthy()
    expect(screen.queryByText('Add to Savings')).toBeNull()
    expect(screen.queryByText(/hardware key/i)).toBeNull()
    expect(screen.getByText('Two-key Savings')).toBeTruthy()
    expect(screen.getByTestId('receive-qr').textContent).toBe('tb1qsavings')
    expect(screen.getByTestId('receive-qr')).toHaveAttribute('data-large', 'true')
    expect(screen.getByTestId('receive-address')).toHaveTextContent('Bitcoin')
    expect(screen.getByTestId('receive-address')).toHaveTextContent('tb1qsavings')
    expect(screen.queryByTestId('receive-arkade-address')).toBeNull()
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()

    await user.click(screen.getByTestId('receive-share'))
    expect(share).toHaveBeenCalledWith({
      title: 'Vaulted Savings address',
      text: 'tb1qsavings',
    })
  })

  it('opens connector Savings on its address and QR, with signer setup separate', async () => {
    const user = userEvent.setup()
    renderReceive('savings', true)
    expect(screen.getByTestId('receive-qr').textContent).toBe('tb1qsavings')
    expect(screen.queryByRole('heading', { name: 'Fund Savings in one transaction' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Set up Savings signer' }))
    expect(screen.getByRole('heading', { name: 'Savings signer setup' })).toBeTruthy()
  })

  it('explains a missing Savings pin instead of suggesting setup is still processing', () => {
    renderReceiveWithoutAddresses('savings')
    expect(screen.getByText('Savings is not restored on this device. Sign in again to restore it.')).toBeTruthy()
    expect(screen.queryByText(/setup finishes/)).toBeNull()
  })

  it('refreshes while the request screen is open and stops on leave', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    vi.useFakeTimers()
    try {
      const { refreshBalance, unmount } = renderReceive('spend')
      // Immediate refresh on open plus the visible interval.
      expect(refreshBalance).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(refreshBalance).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refreshBalance).toHaveBeenCalledTimes(4)
      unmount()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshBalance).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'prerender' })
    }
  })

  it('skips polling while the document is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    vi.useFakeTimers()
    try {
      const { refreshBalance, unmount } = renderReceive('spend')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshBalance).not.toHaveBeenCalled()
      unmount()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'prerender' })
    }
  })

  it('never overlaps a slow refresh with the next tick', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    vi.useFakeTimers()
    try {
      const { refreshBalance, unmount } = renderReceive('spend')
      let concurrent = 0
      let maxConcurrent = 0
      refreshBalance.mockImplementation(async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise<void>((resolve) => setTimeout(resolve, 12_000))
        concurrent -= 1
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(maxConcurrent).toBeLessThanOrEqual(1)
      expect(refreshBalance.mock.calls.length).toBeGreaterThan(1)
      unmount()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'prerender' })
    }
  })

  it('shows a configured Lightning address on primary Receive and opens a specific invoice separately', async () => {
    gates.receive = true
    gates.address = true
    const user = userEvent.setup()
    renderReceive('spend', false, true)
    expect(screen.getByText('alex@ln.getvaulted.xyz')).toBeVisible()
    expect(screen.getByTestId('primary-lightning')).toHaveAttribute('data-primary', 'true')
    await user.click(screen.getByRole('button', { name: 'Create invoice' }))
    expect(screen.queryByTestId('primary-lightning')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Invoice amount; back to Receive' }))
    expect(screen.getByTestId('primary-lightning')).toBeVisible()
  })

  it('keeps Lightning out of Savings even when both gates are enabled', () => {
    gates.receive = true
    gates.address = true
    renderReceive('savings', false, true)
    expect(screen.queryByTestId('primary-lightning')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull()
    expect(screen.getByTestId('receive-qr')).toHaveTextContent('tb1qsavings')
  })

  it('retains invoice receive when reusable Lightning addresses are disabled', () => {
    gates.receive = true
    renderReceive('spend', false, true)
    expect(screen.queryByTestId('primary-lightning')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeVisible()
  })

  it('respects the Lightning receive gate even with reusable addresses enabled', () => {
    gates.address = true
    renderReceive('spend', false, true)
    expect(screen.queryByTestId('primary-lightning')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull()
  })
})

it('shares the destination for the selected receiving method', async () => {
  gates.receive = true
  gates.address = true
  const share = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  const user = userEvent.setup()
  renderReceive('spend', false, true)
  await user.click(screen.getByRole('button', { name: 'Share address' }))
  expect(share).toHaveBeenLastCalledWith({ title: 'Vaulted Lightning address', text: 'alex@ln.getvaulted.xyz' })
  await user.click(screen.getByTestId('receive-method-fast'))
  expect(screen.getByTestId('receive-qr')).toHaveTextContent('tark1spending')
  await user.click(screen.getByRole('button', { name: 'Share address' }))
  expect(share).toHaveBeenLastCalledWith({ title: 'Vaulted Spending address', text: 'tark1spending' })
  await user.click(screen.getByTestId('receive-method-bitcoin'))
  expect(screen.getByTestId('receive-qr')).toHaveTextContent('tb1qboarding')
  await user.click(screen.getByRole('button', { name: 'Share address' }))
  expect(share).toHaveBeenLastCalledWith({ title: 'Vaulted Bitcoin address', text: 'tb1qboarding' })
})

describe('Receive arrival and contract changes', () => {
  it('keeps receive addresses visible without an in-app arrival banner', () => {
    const openArrival = vi.fn()
    const dismissArrival = vi.fn()
    const value = {
      account: 'spend',
      boardingAddress: 'tb1qboarding',
      liveNetwork: true,
      navigate: () => {},
      refreshBalance: vi.fn().mockResolvedValue(undefined),
      savingsAddress: 'tb1qsavings',
      spendingArkAddress: 'tark1spending',
      arrivals: [
        {
          key: 'tx:mutinynet:vault:spend:deposit:received',
          item: { txid: 'deposit', type: 'received', amount: 12_000, confirmed: true, account: 'spend' },
        },
      ],
      dismissArrival,
      openArrival,
    } as unknown as VaultContextProps
    render(
      <ToastProvider>
        <VaultContext.Provider value={value}>
          <VaultReceive />
        </VaultContext.Provider>
      </ToastProvider>,
    )

    expect(screen.queryByText('Received ₿12,000 in Spending.')).not.toBeInTheDocument()
    expect(screen.getByTestId('receive-bitcoin-address')).toBeVisible()
    expect(screen.getByTestId('receive-arkade-address')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'View details' })).not.toBeInTheDocument()
  })
})

it('leaves connector setup when the enrolled contract changes to native Savings', async () => {
  const value = {
    account: 'savings',
    status: { templateVersion: DUAL_CONNECTOR_TEMPLATE },
    savingsAddress: 'tb1qsavings',
    navigate: vi.fn(),
    refreshBalance: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultContextProps
  const wrapper = (current: VaultContextProps) => (
    <ToastProvider>
      <VaultContext.Provider value={current}>
        <VaultReceive />
      </VaultContext.Provider>
    </ToastProvider>
  )
  const view = render(wrapper(value))
  await userEvent.click(screen.getByRole('button', { name: 'Set up Savings signer' }))
  expect(screen.getByRole('heading', { name: 'Savings signer setup' })).toBeVisible()
  view.rerender(wrapper({ ...value, status: { ...value.status!, templateVersion: LEDGER_NATIVE_TEMPLATE } }))
  expect(screen.queryByRole('heading', { name: 'Savings signer setup' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Set up Savings signer' })).toBeNull()
  expect(screen.getByTestId('receive-qr')).toBeVisible()
})
