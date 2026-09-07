import { useContext, useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock3, QrCode, ScanLine, Shield, ShieldAlert } from 'lucide-react'
import { useToast } from '../../components/Toast'
import { prettyNumber } from '../../lib/format'
import { hapticLight, hapticSubtle } from '../../lib/haptics'
import { homeBalanceDisplay, type VaultFiatDisplayRate } from '../../lib/vault/fiatDisplay'
import { loadVaultBalanceUnit, saveVaultBalanceUnit } from '../../lib/vault/prefs'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { VaultContext } from '../../vault/context'
import Content from './Content'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import VaultHistory from './History'
import { QgMark } from './qg/QgScreen'

export default function VaultHome() {
  const {
    account,
    balancesLoaded,
    boardingAddress,
    canSend,
    busy,
    error,
    pendingPayments = [],
    openPendingPayment,
    fiatDisplayRate,
    navigate,
    openSendScan,
    openRecover,
    initiateAlert,
    refreshingBalance,
    positions,
    clearSpendDraft,
    setSpendDraft,
    setFiatDisplay,
  } = useContext(VaultContext)
  const { toast } = useToast()

  useEffect(() => {
    void reloadIfNewerWallet()
    const onFocus = () => {
      void reloadIfNewerWallet()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

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
  const spending = account === 'spend'
  const position = spending ? positions.spending : positions.savings
  const sats = position.totalSats
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
    <Content className='qg-home-content'>
      <main className='qg-home'>
        <header className='qg-account-bar vault-account-bar'>
          <div className='qg-account' data-testid='account-switcher'>
            <QgMark />
            <strong>{spending ? 'Spending' : 'Savings'}</strong>
          </div>
          <div className='qg-utilities'>
            <button
              type='button'
              className={initiateAlert ? 'qg-recovery-shortcut needs-attention' : 'qg-recovery-shortcut'}
              aria-label='Open Recovery'
              data-testid='account-recovery'
              onClick={() => {
                hapticSubtle()
                openRecover('lost', 'home')
              }}
            >
              <Shield />
              {initiateAlert ? <span aria-hidden='true' /> : null}
            </button>
            <i className='qg-utility-divider' aria-hidden='true' />
            <button
              type='button'
              aria-label={spending ? 'Scan a Spending payment' : 'Scan a Savings destination'}
              data-testid='account-scan'
              onClick={() => {
                hapticSubtle()
                openSendScan()
              }}
            >
              <ScanLine />
            </button>
            <button
              type='button'
              aria-label={spending ? 'Receive to Spending' : 'Deposit'}
              data-testid='account-receive'
              onClick={() => navigate('receive')}
            >
              <QrCode />
            </button>
          </div>
        </header>

        {initiateAlert ? (
          <button
            type='button'
            className='qg-recovery-alert'
            data-testid='initiate-alert'
            onClick={() => openRecover('lost', 'home')}
          >
            <span>
              <ShieldAlert />
            </span>
            <div>
              <strong>Savings recovery detected</strong>
              <p>{initiateAlert}</p>
            </div>
            <ChevronRight />
          </button>
        ) : null}

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
              ? `${spending ? 'Spending' : 'Savings'} balance: ${balance.label}. Show ${
                  balanceUnit === 'usd' ? 'bitcoin' : 'USD'
                }`
              : `${spending ? 'Spending' : 'Savings'} balance loading`
          }
          onClick={() => void toggleBalanceUnit()}
        >
          <strong>
            <QgAmount value={balancesLoaded ? balance.amount : '—'} />
          </strong>
          {balancesLoaded && balance.unit ? <span>{balance.unit}</span> : null}
        </button>
        {balancesLoaded && position.pendingSats > 0 ? (
          <p className='qg-available'>
            ₿{prettyNumber(position.availableSats)} available · ₿{prettyNumber(position.pendingSats)} pending
          </p>
        ) : null}
        <div className='qg-actions'>
          <button
            type='button'
            disabled={spending ? !canSend : positions.savings.availableSats <= 330}
            onClick={() => {
              hapticLight()
              clearSpendDraft()
              if (!spending && boardingAddress) setSpendDraft({ address: boardingAddress })
              navigate('send')
            }}
          >
            <span>
              <ArrowUpRight />
              <b>{spending ? 'Send' : 'Move to Spending'}</b>
            </span>
          </button>
          <button
            type='button'
            onClick={() => {
              hapticLight()
              navigate('receive')
            }}
          >
            <span>
              <ArrowDownLeft />
              <b>{spending ? 'Receive' : 'Deposit'}</b>
            </span>
          </button>
        </div>

        {spending
          ? pendingPayments.map((payment) => (
              <section className='qg-arrival' aria-label='Pending payment' key={payment.operationId}>
                <span className='qg-status-icon' aria-hidden>
                  <Clock3 />
                </span>
                <div>
                  <strong>Pending payment · ₿{prettyNumber(payment.amountSats)}</strong>
                  <p>
                    {payment.authorized
                      ? 'Not confirmed as paid. Its funds remain unavailable for another payment.'
                      : 'Reserved for review; this payment has not been authorized.'}
                  </p>
                  <button
                    className='qg-text'
                    type='button'
                    disabled={busy}
                    onClick={() => void openPendingPayment(payment.operationId)}
                  >
                    {payment.authorized ? 'Resume payment' : 'Review reserved payment'}
                  </button>
                </div>
              </section>
            ))
          : null}
        {error && pendingPayments.length > 0 ? (
          <p className='qg-footer-error' role='alert'>
            {error}
          </p>
        ) : null}

        {!spending ? (
          <button
            type='button'
            className='qg-text'
            onClick={() => {
              clearSpendDraft()
              navigate('send')
            }}
          >
            Send to a Bitcoin address
          </button>
        ) : null}
        <VaultHistory />
      </main>
    </Content>
  )
}
