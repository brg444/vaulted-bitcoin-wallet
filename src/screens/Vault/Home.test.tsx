import type { SpendingPaymentContextProps } from '../../vault/spendingPaymentContext'
import type { BitcoinPaymentContextProps } from '../../vault/bitcoinPaymentContext'
import {
  VaultTestProvider,
  type VaultTestContextProps as VaultContextProps,
} from '../../test/fixtures/VaultTestProvider'
import { accountBalanceReads } from '../../test/accountBalances'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { Fiats } from '../../lib/types'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../../lib/vault/fiatDisplay'
import { saveVaultBalanceUnit } from '../../lib/vault/prefs'
import VaultHome from './Home'

vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: () => Promise.resolve(false) }))

function renderHome(
  overrides: Partial<VaultContextProps> & { balanceUnit?: VaultBalanceUnit },
  bitcoinPayment?: Partial<BitcoinPaymentContextProps>,
  spendingPayment?: Partial<SpendingPaymentContextProps>,
) {
  const { balanceUnit: initialUnit = 'sats', ...rest } = overrides
  const value = {
    account: 'spend',
    accountReads: accountBalanceReads(),
    boardingAddress: 'tb1pboardingdestination',
    busy: false,
    canSend: true,
    dailyLimit: 100_000,
    dailyRemaining: 100_000,
    error: '',
    history: [],
    initiateAlert: '',
    liveNetwork: false,
    navigate: vi.fn(),
    openRecover: vi.fn(),
    openSendScan: vi.fn(),
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    savingsAddress: 'tb1psavingsaddress',
    positions: {
      spending: { availableSats: 12_000, pendingSats: 0, totalSats: 12_000 },
      savings: { availableSats: 50_000, pendingSats: 0, totalSats: 50_000 },
    },
    setAccount: vi.fn(),
    clearSpendDraft: vi.fn(),
    setSpendDraft: vi.fn(),
    spendingArkAddress: 'tark1spendingaddress',
    ...rest,
  } as unknown as VaultContextProps
  const legacySetFiat = value.setFiatDisplay
  function Harness() {
    const [unit, setUnit] = useState<VaultBalanceUnit>(initialUnit)
    const [rate, setRate] = useState<VaultFiatDisplayRate | null>(value.fiatDisplayRate ?? null)
    // Mirrors the provider: one persisted preference, sats fallback when the rate fails.
    const setBalanceUnit =
      value.setBalanceUnit ??
      (async (next: VaultBalanceUnit) => {
        try {
          saveVaultBalanceUnit(next)
        } catch {
          // Storage failures keep the in-memory unit.
        }
        setUnit(next)
        if (next === 'sats') {
          setRate(null)
          await legacySetFiat?.(false)
          return null
        }
        const loaded = (await legacySetFiat?.(true)) ?? null
        setRate(loaded)
        return loaded
      })
    return (
      <ToastProvider>
        <VaultTestProvider
          bitcoinPayment={bitcoinPayment}
          spendingPayment={spendingPayment}
          value={
            {
              ...value,
              balanceUnit: unit,
              fiatDisplayRate: rate,
              balanceRateStatus: rate ? 'ready' : unit === 'usd' ? 'unavailable' : 'idle',
              setBalanceUnit,
            } as unknown as VaultContextProps
          }
        >
          <VaultHome />
        </VaultTestProvider>
      </ToastProvider>
    )
  }
  render(<Harness />)
  return value
}

describe('Vault home account boundaries', () => {
  afterEach(() => {
    localStorage.removeItem('arkade-vault-balance-unit')
  })

  it('shows a known deposit without asserting an available Spending balance before the SDK is ready', () => {
    renderHome({
      canSend: false,
      accountReads: accountBalanceReads({ loaded: false, fresh: false }),
      positions: {
        spending: { availableSats: 0, pendingSats: 33_458, totalSats: 33_458 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('—')
    expect(screen.getByText('₿33,458 pending')).toBeVisible()
    expect(screen.queryByText(/available/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeEnabled()
  })

  it('keeps a submitted payment awaiting confirmation out of Home notices', () => {
    renderHome(
      {
        canSend: false,
        positions: {
          spending: { availableSats: 0, pendingSats: 31953, totalSats: 31953 },
          savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
        },
      },
      undefined,
      {
        openPendingPayment: vi.fn(),
        pendingPayments: [
          { operationId: 'submitted', amountSats: 1505, destination: 'tark1pending', authorized: true },
        ],
      },
    )
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    // Ordinary settlement waiting is background/Activity, not a Home action.
    expect(screen.queryByRole('region', { name: 'Pending payment' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume payment' })).toBeNull()
  })

  it('surfaces a reserved payment that needs review and resumes it', async () => {
    const user = userEvent.setup()
    const openPendingPayment = vi.fn().mockResolvedValue(undefined)
    renderHome({}, undefined, {
      openPendingPayment,
      pendingPayments: [{ operationId: 'reserved', amountSats: 1505, destination: 'tark1pending', authorized: false }],
    })
    expect(screen.getByRole('region', { name: 'Pending payment' })).toHaveTextContent('Reserved for review')
    await user.click(screen.getByRole('button', { name: 'Review reserved payment' }))
    expect(openPendingPayment).toHaveBeenCalledWith('reserved')
  })

  it('puts a pending Bitcoin send in Recent without labelling the remaining balance pending', async () => {
    const openTx = vi.fn()
    const tx = {
      txid: 'commitment',
      type: 'sent' as const,
      amount: 1400,
      fee: 400,
      confirmed: false,
      account: 'spend' as const,
      activity: 'bitcoin' as const,
      bitcoinOperationId: 'payment',
    }
    renderHome(
      {
        canSend: false,
        openTx,
        history: [tx],
        positions: {
          spending: { availableSats: 0, pendingSats: 25859, totalSats: 25859 },
          savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
        },
      },
      { operation: { operationId: 'payment' } as never },
    )
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('₿25,859')
    expect(screen.queryByText(/available ·/)).toBeNull()
    expect(screen.queryByText('Bitcoin payment from Spending')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check payment status' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Bitcoin payment ₿1,400.*Checking status/ }))
    expect(openTx).toHaveBeenCalledWith(tx)
  })

  it('opens full activity from Home without disturbing the recent list', async () => {
    const user = userEvent.setup()
    const value = renderHome({
      history: [{ txid: 'known', type: 'received', amount: 12000, confirmed: true, blockTime: 10, account: 'spend' }],
    })
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'See all activity' }))
    expect(value.navigate).toHaveBeenCalledWith('activity')
  })

  it('keeps receive details behind the explicit Home utilities', () => {
    renderHome({ account: 'spend' })
    expect(screen.queryByTestId('account-address')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scan a Spending payment' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Receive to Spending' })).toBeTruthy()
    expect(document.querySelector('.vault-refresh')).toBeTruthy()
  })

  it('starts Savings to Spending at the pinned boarding address', async () => {
    const user = userEvent.setup()
    const value = renderHome({ account: 'savings' })
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    expect(value.clearSpendDraft).toHaveBeenCalled()
    expect(value.setSpendDraft).toHaveBeenCalledWith({ address: value.boardingAddress })
    expect(value.navigate).toHaveBeenCalledWith('send')
  })

  it('starts Spending send from a blank draft', async () => {
    const user = userEvent.setup()
    const value = renderHome({ account: 'spend' })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(value.clearSpendDraft).toHaveBeenCalled()
    expect(value.setSpendDraft).not.toHaveBeenCalled()
    expect(value.navigate).toHaveBeenCalledWith('send')
  })

  it('keeps the Savings actions explicit without adding send instructions to Home', () => {
    renderHome({ account: 'savings' })
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Deposit' })).toHaveLength(2)
    expect(screen.queryByText(/hardware key/i)).toBeNull()
  })

  it.each(['this device', 'hardware', 'recovery'])(
    'shows the recovery alert for %s without substituting another key',
    (key) => {
      const initiateAlert = `Someone started recovery on Savings with ${key}. If this wasn’t you, cancel it.`
      renderHome({ initiateAlert })
      expect(screen.getByTestId('initiate-alert')).toHaveTextContent('Savings recovery detected')
      expect(screen.getByTestId('initiate-alert')).toHaveTextContent(initiateAlert)
      expect(screen.getByRole('button', { name: 'Open Recovery' })).toBeTruthy()
    },
  )

  it('toggles the hero between ₿sats and USD using the fetched price', async () => {
    const user = userEvent.setup()
    const rate = { currency: Fiats.USD, pricePerBtc: 125_000 }
    const setFiatDisplay = vi.fn(async (enabled: boolean) => (enabled ? rate : null))
    renderHome({
      account: 'spend',
      fiatDisplayRate: null,
      setFiatDisplay,
      positions: {
        spending: { availableSats: 80_000, pendingSats: 48_000, totalSats: 128_000 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    const hero = screen.getByTestId('vault-balance')
    expect(hero).toHaveTextContent('₿128,000')
    await user.click(hero)
    expect(hero).toHaveTextContent('$160.00')
    expect(screen.getByText('$100.00 available · $60.00 pending')).toBeTruthy()
    expect(setFiatDisplay).toHaveBeenCalledWith(true)
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
    await user.click(hero)
    expect(hero).toHaveTextContent('₿128,000')
    expect(setFiatDisplay).toHaveBeenCalledWith(false)
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBeNull()
  })

  it('keeps the USD preference with a sats fallback when the price is unavailable', async () => {
    const user = userEvent.setup()
    const setFiatDisplay = vi.fn().mockResolvedValue(null)
    renderHome({ fiatDisplayRate: null, setFiatDisplay })

    const hero = screen.getByTestId('vault-balance')
    await user.click(hero)

    expect(hero).toHaveTextContent('₿12,000')
    expect(hero).toHaveAttribute('data-balance-unit', 'usd')
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
    expect(await screen.findByText('USD balance is unavailable. Try again later.')).toBeTruthy()
    expect(await screen.findByText('USD rate unavailable — showing bitcoin.')).toBeTruthy()
  })

  it('shows total Spending balance even when some sats are still arriving', () => {
    renderHome({
      account: 'spend',
      positions: {
        spending: { availableSats: 80_000, pendingSats: 48_000, totalSats: 128_000 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    expect(screen.queryByText('Available to spend')).toBeNull()
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('₿128,000')
    expect(screen.getByText(/48,000 pending/)).toBeVisible()
    expect(screen.queryByTestId('spending-total')).toBeNull()
    expect(screen.queryByText(/currently spendable/i)).toBeNull()
  })

  it('shows total Savings balance even when some sats are not yet spendable', () => {
    renderHome({
      account: 'savings',
      positions: {
        spending: { availableSats: 0, pendingSats: 0, totalSats: 0 },
        savings: { availableSats: 20_000, pendingSats: 30_000, totalSats: 50_000 },
      },
    })
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('₿50,000')
    expect(screen.queryByText(/currently spendable/i)).toBeNull()
  })

  it('shows the current account without a picker on Home', () => {
    renderHome({ account: 'spend' })
    expect(screen.getByTestId('account-switcher')).toHaveTextContent('Spending')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByTestId('account-spend')).toBeNull()
    expect(screen.queryByTestId('account-savings')).toBeNull()
  })

  it('does not present zero as the balance before the first snapshot loads', () => {
    renderHome({
      accountReads: accountBalanceReads({ loaded: false }),
      positions: {
        spending: { availableSats: 0, pendingSats: 0, totalSats: 0 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('—')
    expect(screen.getByTestId('vault-balance')).toHaveAccessibleName('Spending balance loading')
  })

  it('keeps an unknown balance distinct from zero and reports the failed account read', () => {
    renderHome({ accountReads: accountBalanceReads({ loaded: false, error: 'Wallet activity is unavailable.' }) })

    expect(screen.getByTestId('vault-balance')).toHaveAttribute('aria-busy')
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('—')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Wallet activity is unavailable.')
  })

  it('shows a boarding failure beside the retained Spending balance', () => {
    const message = 'Deposit boarding needs attention. Guardian could not complete this attempt.'
    renderHome({
      boardingError: message,
      positions: {
        spending: { availableSats: 1_300, pendingSats: 30_608, totalSats: 31_908 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('₿31,908')
  })

  it('shows a rejected Bitcoin payment even with no retained pending operation', () => {
    renderHome({ error: 'Bitcoin payment was not sent. Registration was rejected.' })
    expect(screen.getByRole('alert')).toHaveTextContent('Bitcoin payment was not sent')
  })

  it('does not show a background refresh failure over a known balance', () => {
    renderHome({
      accountReads: accountBalanceReads({ error: 'Something went wrong. Try again.' }),
      error: 'Something went wrong. Try again.',
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByText('Something went wrong. Try again.')).toBeNull()
  })
})
