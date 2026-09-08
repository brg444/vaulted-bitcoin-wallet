import { useContext, useEffect, useState } from 'react'
import { ChevronRight, Clock3, ShieldAlert } from 'lucide-react'
import { prettyNumber } from '../../lib/format'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { VaultContext } from '../../vault/context'
import ConnectorSetup from './ConnectorSetup'
import ConnectorDeposit from './ConnectorDeposit'
import AccountHome from './AccountHome'
import VaultHistory from './History'

export default function VaultHome() {
  const {
    account,
    status,
    spendingBitcoin,
    balancesLoaded,
    boardingAddress,
    canSend,
    busy,
    error,
    pendingPayments = [],
    openPendingPayment,
    navigate,
    openSendScan,
    openRecover,
    initiateAlert,
    refreshingBalance,
    positions,
    clearSpendDraft,
    setSpendDraft,
  } = useContext(VaultContext)

  useEffect(() => {
    void reloadIfNewerWallet()
    const onFocus = () => {
      void reloadIfNewerWallet()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const [setupView, setSetupView] = useState<'home' | 'setup' | 'deposit'>('home')
  if (status && setupView === 'setup')
    return (
      <ConnectorSetup status={status} onBack={() => setSetupView('home')} onDeposit={() => setSetupView('deposit')} />
    )
  if (status && setupView === 'deposit')
    return (
      <ConnectorDeposit status={status} onBack={() => setSetupView('setup')} onAddress={() => setSetupView('home')} />
    )
  const spending = account === 'spend'
  const position = spending ? positions.spending : positions.savings

  return (
    <AccountHome
      account={spending ? 'Spending' : 'Savings'}
      totalSats={position.totalSats}
      availableSats={position.availableSats}
      pendingSats={spending && spendingBitcoin?.operation ? 0 : position.pendingSats}
      balancesLoaded={balancesLoaded}
      refreshingBalance={refreshingBalance}
      security={{ label: 'Open Recovery', attention: !!initiateAlert, onClick: () => openRecover('lost', 'home') }}
      onScan={openSendScan}
      onReceive={() => navigate('receive')}
      primaryAction={{
        label: spending ? 'Send' : 'Transfer',
        disabled: spending
          ? !canSend || !!spendingBitcoin?.operation || !!spendingBitcoin?.error
          : positions.savings.availableSats <= 330,
        onClick: () => {
          clearSpendDraft()
          if (!spending && boardingAddress) setSpendDraft({ address: boardingAddress })
          navigate('send')
        },
      }}
      secondaryAction={{ label: spending ? 'Receive' : 'Deposit', onClick: () => navigate('receive') }}
      alert={
        initiateAlert ? (
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
        ) : null
      }
    >
      {spending && spendingBitcoin?.error ? (
        <p className='qg-footer-error' role='alert'>
          {spendingBitcoin.error}
        </p>
      ) : null}
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
    </AccountHome>
  )
}
