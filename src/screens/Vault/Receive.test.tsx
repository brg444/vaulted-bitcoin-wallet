import { LEDGER_NATIVE_TEMPLATE } from '../../lib/vault/program/ledgerNativeKeys'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { VaultContext, type VaultAccount, type VaultContextProps } from '../../vault/context'
import VaultReceive from './Receive'
import { DUAL_CONNECTOR_TEMPLATE } from '../../lib/vault/program/connector'

vi.mock('./ConnectorSetup', () => ({ default: () => <h1>Savings signer setup</h1> }))

vi.mock('../../components/QrCode', () => ({
  default: ({ large, value }: { large?: boolean; value: string }) => (
    <div data-large={String(Boolean(large))} data-testid='receive-qr'>
      {value}
    </div>
  ),
}))

function renderReceive(account: VaultAccount, connector = false) {
  const value = {
    account,
    ...(connector ? { status: { templateVersion: DUAL_CONNECTOR_TEMPLATE } } : {}),
    boardingAddress: 'tb1qboarding',
    liveNetwork: true,
    navigate: () => {},
    savingsAddress: 'tb1qsavings',
    spendingArkAddress: 'tark1spending',
  } as unknown as VaultContextProps
  return render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultReceive />
      </VaultContext.Provider>
    </ToastProvider>,
  )
}

function renderReceiveWithoutAddresses(account: VaultAccount) {
  const value = {
    account,
    boardingAddress: '',
    liveNetwork: true,
    navigate: () => {},
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

describe('Vault receive', () => {
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

  it('shows an arrival above the reusable address and opens its details', async () => {
    const user = userEvent.setup()
    const openArrival = vi.fn()
    const dismissArrival = vi.fn()
    const value = {
      account: 'spend',
      boardingAddress: 'tb1qboarding',
      liveNetwork: true,
      navigate: () => {},
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

    expect(screen.getByText('Received ₿12,000 in Spending.')).toBeVisible()
    expect(screen.getByTestId('receive-bitcoin-address')).toBeVisible()
    expect(screen.getByTestId('receive-arkade-address')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'View details' }))
    expect(openArrival).toHaveBeenCalledWith('tx:mutinynet:vault:spend:deposit:received')
  })
})

it('leaves connector setup when the enrolled contract changes to native Savings', async () => {
  const value = {
    account: 'savings',
    status: { templateVersion: DUAL_CONNECTOR_TEMPLATE },
    savingsAddress: 'tb1qsavings',
    navigate: vi.fn(),
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
