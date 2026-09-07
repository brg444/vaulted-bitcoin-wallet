import { useContext, useEffect, useState } from 'react'
import { useToast } from '../../components/Toast'
import { hapticSubtle } from '../../lib/haptics'
import { homeBalanceDisplay, type VaultFiatDisplayRate } from '../../lib/vault/fiatDisplay'
import { loadVaultBalanceUnit, saveVaultBalanceUnit } from '../../lib/vault/prefs'
import { VaultContext } from '../../vault/context'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'

export default function AccountBalance({
  sats,
  account,
  balancesLoaded,
  refreshingBalance = false,
}: {
  sats: number
  account: 'Spending' | 'Savings'
  balancesLoaded: boolean
  refreshingBalance?: boolean
}) {
  const { fiatDisplayRate, setFiatDisplay } = useContext(VaultContext)
  const { toast } = useToast()
  const [balanceUnit, setBalanceUnit] = useState<'sats' | 'usd'>('sats')
  const [loadingFiat, setLoadingFiat] = useState(false)
  const [homeFiatRate, setHomeFiatRate] = useState<VaultFiatDisplayRate | null>(fiatDisplayRate)

  useEffect(() => {
    if (fiatDisplayRate) setHomeFiatRate(fiatDisplayRate)
  }, [fiatDisplayRate])

  useEffect(() => {
    let active = true
    let preferred: 'sats' | 'usd' = 'sats'
    try {
      preferred = loadVaultBalanceUnit()
    } catch {
      return
    }
    if (preferred !== 'usd') return
    setLoadingFiat(true)
    void setFiatDisplay(true)
      .then((rate) => {
        if (!active) return
        if (rate) {
          setHomeFiatRate(rate)
          setBalanceUnit('usd')
        } else saveVaultBalanceUnit('sats')
      })
      .finally(() => {
        if (active) setLoadingFiat(false)
      })
    return () => {
      active = false
    }
  }, [setFiatDisplay])
  const balance = homeBalanceDisplay(sats, balanceUnit, fiatDisplayRate || homeFiatRate)

  const toggleBalanceUnit = async () => {
    if (!balancesLoaded || loadingFiat) return
    hapticSubtle()
    if (balanceUnit === 'usd') {
      setBalanceUnit('sats')
      setHomeFiatRate(null)
      saveVaultBalanceUnit('sats')
      await setFiatDisplay(false)
      return
    }
    setLoadingFiat(true)
    try {
      const rate = fiatDisplayRate || (await setFiatDisplay(true))
      if (!rate) {
        toast('USD balance is unavailable. Try again later.')
        return
      }
      setHomeFiatRate(rate)
      setBalanceUnit('usd')
      saveVaultBalanceUnit('usd')
    } finally {
      setLoadingFiat(false)
    }
  }

  return (
    <button
      type='button'
      className='qg-balance'
      data-testid='vault-balance'
      data-balance-unit={balanceUnit}
      style={amountSizeStyle(balance.amount)}
      disabled={!balancesLoaded || loadingFiat}
      aria-busy={!balancesLoaded || refreshingBalance || loadingFiat ? true : undefined}
      aria-live='polite'
      aria-label={
        balancesLoaded
          ? `${account} balance: ${balance.label}. Show ${balanceUnit === 'usd' ? 'bitcoin' : 'USD'}`
          : `${account} balance loading`
      }
      onClick={() => void toggleBalanceUnit()}
    >
      <strong>
        <QgAmount value={balancesLoaded ? balance.amount : '—'} />
      </strong>
      {balancesLoaded && balance.unit ? <span>{balance.unit}</span> : null}
    </button>
  )
}
