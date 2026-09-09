import { useContext, useState } from 'react'
import { useToast } from '../../components/Toast'
import { hapticSubtle } from '../../lib/haptics'
import {
  homeBalanceDisplay,
  isRateUnavailable,
  type VaultBalanceUnit,
  type VaultFiatDisplayRate,
} from '../../lib/vault/fiatDisplay'
import type { VaultRateStatus } from '../../lib/vault/useDisplayUnit'
import { VaultContext } from '../../vault/context'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'

export interface BalanceDenomination {
  unit: VaultBalanceUnit
  rate: VaultFiatDisplayRate | null
  rateStatus: VaultRateStatus
  setUnit: (unit: VaultBalanceUnit) => Promise<VaultFiatDisplayRate | null>
}

export function useBalanceDenomination(override?: BalanceDenomination): BalanceDenomination {
  const context = useContext(VaultContext)
  if (override) return override
  return {
    unit: context.balanceUnit ?? 'sats',
    rate: context.fiatDisplayRate ?? null,
    rateStatus: context.balanceRateStatus ?? 'idle',
    setUnit: (unit) => context.setBalanceUnit?.(unit) ?? Promise.resolve(null),
  }
}

export default function AccountBalance({
  sats,
  account,
  balancesLoaded,
  refreshingBalance = false,
  denomination,
}: {
  sats: number
  account: 'Spending' | 'Savings'
  balancesLoaded: boolean
  refreshingBalance?: boolean
  denomination?: BalanceDenomination
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const denom = useBalanceDenomination(denomination)
  const balance = homeBalanceDisplay(sats, denom.unit, denom.rate)
  const loadingRate = busy || denom.rateStatus === 'loading'
  const unavailable = isRateUnavailable({ unit: denom.unit, rate: denom.rate })

  const toggleBalanceUnit = async () => {
    if (!balancesLoaded || loadingRate) return
    hapticSubtle()
    if (denom.unit === 'usd') {
      setBusy(true)
      try {
        await denom.setUnit('sats')
      } finally {
        setBusy(false)
      }
      return
    }
    setBusy(true)
    try {
      // Always update the preference on tap, even when a cached rate exists.
      const rate = await denom.setUnit('usd')
      if (!rate) toast('USD balance is unavailable. Try again later.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='qg-balance-wrap'>
      <button
        type='button'
        className='qg-balance'
        data-testid='vault-balance'
        data-balance-unit={denom.unit}
        style={amountSizeStyle(balance.amount)}
        disabled={!balancesLoaded || loadingRate}
        aria-busy={!balancesLoaded || refreshingBalance || loadingRate ? true : undefined}
        aria-live='polite'
        aria-label={
          balancesLoaded
            ? `${account} balance: ${balance.label}. Show ${denom.unit === 'usd' ? 'bitcoin' : 'USD'}`
            : `${account} balance loading`
        }
        onClick={() => void toggleBalanceUnit()}
      >
        <strong>
          <QgAmount value={balancesLoaded ? balance.amount : '—'} />
        </strong>
        {balancesLoaded && balance.unit ? <span>{balance.unit}</span> : null}
      </button>
      {balancesLoaded && denom.rateStatus === 'loading' ? (
        <p className='qg-balance-note' role='status'>
          Loading USD rate…
        </p>
      ) : null}
      {balancesLoaded && unavailable ? (
        <p className='qg-balance-note' role='status'>
          USD rate unavailable — showing bitcoin.
        </p>
      ) : null}
    </div>
  )
}
