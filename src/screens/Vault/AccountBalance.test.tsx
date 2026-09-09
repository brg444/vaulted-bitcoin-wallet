import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { Fiats } from '../../lib/types'
import type { VaultBalanceUnit, VaultFiatDisplayRate } from '../../lib/vault/fiatDisplay'
import { saveVaultBalanceUnit } from '../../lib/vault/prefs'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import AccountBalance from './AccountBalance'

const RATE = { currency: Fiats.USD, pricePerBtc: 100_000 }

function renderBalance({
  sats = 128_000,
  unit = 'sats',
  rate = null,
  setBalanceUnit,
}: {
  sats?: number
  unit?: VaultBalanceUnit
  rate?: VaultFiatDisplayRate | null
  setBalanceUnit?: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
} = {}) {
  const calls: VaultBalanceUnit[] = []
  function Harness() {
    const [current, setCurrent] = useState(unit)
    const [currentRate, setCurrentRate] = useState(rate)
    const toggle =
      setBalanceUnit ??
      (async (next: VaultBalanceUnit) => {
        calls.push(next)
        try {
          saveVaultBalanceUnit(next)
        } catch {
          // Storage failures keep the in-memory unit.
        }
        setCurrent(next)
        // A cached provider rate resolves without refetching.
        const loaded = next === 'usd' ? (currentRate ?? RATE) : null
        if (next === 'usd' && !currentRate) setCurrentRate(RATE)
        if (next === 'sats') setCurrentRate(null)
        return loaded
      })
    return (
      <ToastProvider>
        <VaultContext.Provider
          value={
            {
              balanceUnit: current,
              fiatDisplayRate: currentRate,
              balanceRateStatus: currentRate ? 'ready' : current === 'usd' ? 'unavailable' : 'idle',
              setBalanceUnit: toggle,
            } as unknown as VaultContextProps
          }
        >
          <AccountBalance sats={sats} account='Spending' balancesLoaded />
        </VaultContext.Provider>
      </ToastProvider>
    )
  }
  render(<Harness />)
  return { calls }
}

describe('AccountBalance denomination', () => {
  afterEach(() => {
    localStorage.removeItem('arkade-vault-balance-unit')
  })

  it('updates the preference on tap when a cached rate already exists', async () => {
    const user = userEvent.setup()
    const { calls } = renderBalance({ rate: RATE })

    const hero = screen.getByTestId('vault-balance')
    expect(hero).toHaveTextContent('₿128,000')
    await user.click(hero)

    expect(calls).toEqual(['usd'])
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('$128.00')
    expect(screen.getByTestId('vault-balance')).toHaveAttribute('data-balance-unit', 'usd')
  })

  it('returns to sats and clears the saved preference', async () => {
    const user = userEvent.setup()
    renderBalance({ unit: 'usd', rate: RATE })

    expect(screen.getByTestId('vault-balance')).toHaveTextContent('$128.00')
    await user.click(screen.getByTestId('vault-balance'))
    expect(screen.getByTestId('vault-balance')).toHaveTextContent('₿128,000')
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBeNull()
  })

  it('falls back to sats without erasing the preference when the rate is missing', () => {
    localStorage.setItem('arkade-vault-balance-unit', 'usd')
    renderBalance({ unit: 'usd', rate: null })

    const hero = screen.getByTestId('vault-balance')
    expect(hero).toHaveTextContent('₿128,000')
    expect(hero).toHaveAttribute('data-balance-unit', 'usd')
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
    expect(screen.getByText('USD rate unavailable — showing bitcoin.')).toBeTruthy()
  })

  it('explains when switching to USD has no rate to show', async () => {
    const user = userEvent.setup()
    const setBalanceUnit = vi.fn(async () => null)
    renderBalance({ setBalanceUnit })

    await user.click(screen.getByTestId('vault-balance'))
    expect(setBalanceUnit).toHaveBeenCalledWith('usd')
    expect(await screen.findByText('USD balance is unavailable. Try again later.')).toBeTruthy()
  })
})
