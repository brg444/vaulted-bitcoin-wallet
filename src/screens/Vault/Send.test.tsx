import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fiats } from '../../lib/types'
import { ToastProvider } from '../../components/Toast'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../../lib/vault/fiatDisplay'
import { saveVaultBalanceUnit } from '../../lib/vault/prefs'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultSend from './Send'

vi.mock('../../lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticSubtle: vi.fn(),
}))

vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: () => Promise.resolve(false) }))

vi.mock('./Scanner', () => ({
  default: ({ close, manual, label }: { close: () => void; manual: () => void; label: string }) => (
    <div>
      <h2>{label}</h2>
      <button type='button' onClick={manual}>
        Enter manually
      </button>
      <button type='button' onClick={close}>
        Cancel
      </button>
    </div>
  ),
}))

function renderSend(overrides: Partial<VaultContextProps> & { balanceUnit?: VaultBalanceUnit } = {}) {
  const { balanceUnit: initialUnit = 'sats', ...rest } = overrides
  const value = {
    account: 'spend',
    boardingAddress: 'tb1pboardingdestination',
    busy: false,
    clearSendScan: vi.fn(),
    dailyRemaining: 100_000,
    error: '',
    navigate: vi.fn(),
    reviewSpend: vi.fn(),
    scanOnSend: false,
    setFiatDisplay: vi.fn().mockResolvedValue({ currency: Fiats.USD, pricePerBtc: 100_000 }),
    setSpendDraft: vi.fn(),
    spend: { address: '', amount: 0, fee: 0 },
    setup: { dailyLimitSats: 100_000, txCapSats: 50_000 },
    status: { network: 'mutinynet' },
    positions: {
      spending: { availableSats: 80_000, pendingSats: 0, totalSats: 80_000 },
      savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
    },
    ...rest,
  } as unknown as VaultContextProps
  const legacySetFiat = value.setFiatDisplay
  function Harness() {
    const [unit, setUnit] = useState<VaultBalanceUnit>(initialUnit)
    const [rate, setRate] = useState<VaultFiatDisplayRate | null>(value.fiatDisplayRate ?? null)
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
        <VaultContext.Provider
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
          <VaultSend />
        </VaultContext.Provider>
      </ToastProvider>
    )
  }
  render(<Harness />)
  return value
}

describe('Vault send scanner origin', () => {
  afterEach(() => localStorage.clear())

  it.each(['spend', 'savings'] as const)('returns Home when the %s Home camera is cancelled', (account) => {
    const value = renderSend({
      account,
      scanOnSend: true,
      spend: { address: 'tark1previousattempt', amount: 12_000, fee: 0 },
    })
    expect(
      screen.getByRole('heading', { name: account === 'savings' ? 'Scan Bitcoin address' : 'Scan payment' }),
    ).toBeTruthy()
    expect(screen.queryByDisplayValue('tark1previousattempt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(value.clearSendScan).toHaveBeenCalled()
    expect(value.navigate).toHaveBeenCalledWith('home')
    expect(screen.queryByRole('heading', { name: 'Send' })).toBeNull()
  })

  it('stays on Send when the in-form camera is cancelled', () => {
    const value = renderSend({ spend: { address: '', amount: 0, fee: 0 } })
    fireEvent.click(screen.getByRole('button', { name: 'Scan destination' }))
    expect(screen.getByRole('heading', { name: 'Scan payment' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(value.navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Send' })).toBeTruthy()
    expect(screen.getByLabelText('To')).toHaveValue('')
  })

  it('does not keep a previous destination in the To field', () => {
    renderSend({ spend: { address: '', amount: 0, fee: 0 } })
    expect(screen.getByLabelText('To')).toHaveValue('')
  })

  it('enters bitcoin by default and converts USD edits to integer satoshis', async () => {
    const user = userEvent.setup()
    const value = renderSend()
    const denomination = screen.getByRole('button', { name: /Amount in bitcoin satoshis/i })
    expect(denomination).toHaveTextContent('₿')

    await user.click(denomination)
    expect(screen.getByRole('button', { name: /Amount in US dollars/i })).toHaveTextContent('$')
    await user.type(screen.getByTestId('vault-send-amount'), '12.50')
    expect(value.setSpendDraft).toHaveBeenLastCalledWith({ amount: 12_500 })
  })

  it('preserves all 331 sats across a USD round trip without editing', async () => {
    const user = userEvent.setup()
    const value = renderSend({ spend: { address: 'tark1destination', amount: 331, fee: 0 } })
    expect(screen.getByTestId('vault-send-amount')).toHaveValue('331')

    await user.click(screen.getByRole('button', { name: /Amount in bitcoin satoshis/i }))
    // 331 sats round to two decimals; the canonical amount is untouched until edited.
    expect(screen.getByTestId('vault-send-amount')).toHaveValue('0.33')
    await user.click(screen.getByRole('button', { name: /Amount in US dollars/i }))
    expect(screen.getByTestId('vault-send-amount')).toHaveValue('331')
    expect(value.setSpendDraft).not.toHaveBeenCalledWith({ amount: expect.anything() })
  })

  it('offers abort for a reserved send and never a localStorage-only Send anyway', () => {
    const value = renderSend({
      canReplaceInFlightSend: true,
      error: 'A reserved send is still open. Abort it before sending a different amount.',
      replaceInFlightSend: vi.fn(),
      spend: { address: 'tark1same', amount: 20_000, fee: 0 },
    })
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Abort reserved send' }))
    expect(value.replaceInFlightSend).toHaveBeenCalled()
  })

  it('shows the reserved value and resumes the exact persisted payment instead of displaying zero', () => {
    localStorage.setItem(
      'arkade-vault-vtxo-spend:vault-a',
      JSON.stringify({
        vaultId: 'vault-a',
        operationId: '11'.repeat(16),
        bundleDigest: '',
        destAddress: 'tark1same',
        amountSats: 15_000,
        arkTxid: '',
        stage: 'pre-reserve',
      }),
    )
    const reviewSpend = vi.fn()
    renderSend({
      reviewSpend,
      spend: { address: 'tark1same', amount: 15_000, fee: 0 },
      status: { network: 'mutinynet', vaultId: 'vault-a' } as VaultContextProps['status'],
      positions: {
        spending: { availableSats: 0, pendingSats: 0, totalSats: 0 },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })

    expect(screen.getByText('₿15,000 reserved for this payment')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume payment' }))
    expect(reviewSpend).toHaveBeenCalled()
  })

  it('syncs scanned amounts into the USD field while preserving typed input', async () => {
    const user = userEvent.setup()
    const rate = { currency: Fiats.USD, pricePerBtc: 100_000 }
    function ScanHarness() {
      const [spend, setSpend] = useState({ address: '', amount: 0, fee: 0 })
      const [unit, setUnit] = useState<VaultBalanceUnit>('usd')
      return (
        <ToastProvider>
          <VaultContext.Provider
            value={
              {
                account: 'spend',
                busy: false,
                clearSendScan: vi.fn(),
                dailyRemaining: 100_000,
                error: '',
                navigate: vi.fn(),
                reviewSpend: vi.fn(),
                scanOnSend: false,
                setFiatDisplay: vi.fn(),
                setSpendDraft: (draft: Partial<{ address: string; amount: number; fee: number }>) =>
                  setSpend((prev) => ({ ...prev, ...draft })),
                spend,
                setup: { dailyLimitSats: 100_000, txCapSats: 50_000 },
                status: { network: 'mutinynet' },
                positions: {
                  spending: { availableSats: 80_000, pendingSats: 0, totalSats: 80_000 },
                  savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
                },
                balanceUnit: unit,
                fiatDisplayRate: rate,
                balanceRateStatus: 'ready',
                setBalanceUnit: async (next: VaultBalanceUnit) => {
                  setUnit(next)
                  return next === 'usd' ? rate : null
                },
              } as unknown as VaultContextProps
            }
          >
            <VaultSend />
            <button type='button' onClick={() => setSpend({ address: 'tark1scanned', amount: 12_500, fee: 0 })}>
              simulate-scan
            </button>
            <button type='button' onClick={() => setSpend({ address: 'tark1scanned', amount: 331, fee: 0 })}>
              simulate-small-scan
            </button>
          </VaultContext.Provider>
        </ToastProvider>
      )
    }
    render(<ScanHarness />)
    const field = screen.getByTestId('vault-send-amount')

    await user.click(screen.getByRole('button', { name: 'simulate-scan' }))
    expect(field).toHaveValue('12.50')

    await user.clear(field)
    await user.type(field, '1.00')
    expect(field).toHaveValue('1.00')

    await user.click(screen.getByRole('button', { name: 'simulate-small-scan' }))
    expect(field).toHaveValue('0.33')
  })
})

describe('Send maximum respects actual capacity', () => {
  it.each([
    [80000, 100000, 0, 50000],
    [30000, 100000, 500, 29500],
    [80000, 20000, 500, 19500],
    [100, 100000, 500, 0],
  ])('uses available=%i, remaining=%i and fee=%i', (available, remaining, fee, expected) => {
    const value = renderSend({
      dailyRemaining: remaining,
      spend: { address: 'tark1destination', amount: 0, fee },
      positions: {
        spending: { availableSats: available, pendingSats: 0, totalSats: available },
        savings: { availableSats: 0, pendingSats: 0, totalSats: 0 },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    expect(value.setSpendDraft).toHaveBeenCalledWith({ amount: expected })
  })
})

it('opens manual entry from the Home camera without returning Home', () => {
  const value = renderSend({ scanOnSend: true })
  fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }))
  expect(value.clearSendScan).toHaveBeenCalled()
  expect(value.navigate).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'To' })).toBeVisible()
})
