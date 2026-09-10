import PaymentNotice from './qg/PaymentNotice'
import PaymentArrivalBanners from './PaymentArrivals'
import CatchUpBanner from './CatchUpBanner'
import { useContext, useEffect, type ReactNode } from 'react'
import { ChevronRight, ShieldAlert } from 'lucide-react'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { VaultContext } from '../../vault/context'
import AccountHome from './AccountHome'
import VaultHistory from './History'
import PendingPayment from './qg/PendingPayment'

export default function VaultHome({ children }: { children?: ReactNode }) {
  const {
    account,
    spendingBitcoin,
    balancesLoaded,
    boardingAddress,
    canSend,
    busy,
    error,
    balanceError,
    boardingError,
    pendingPayments = [],
    openPendingPayment,
    arrivals = [],
    dismissArrival,
    openArrival,
    catchUp,
    dismissCatchUp,
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
      {children}
      {spending && boardingError ? <PaymentNotice message={boardingError} /> : null}
      {spending && spendingBitcoin?.error ? <PaymentNotice message={spendingBitcoin.error} /> : null}
      {spending
        ? pendingPayments.map((payment) => (
            <PendingPayment
              key={payment.operationId}
              amount={payment.amountSats}
              description={
                payment.authorized
                  ? 'Not confirmed as paid. Its funds remain unavailable for another payment.'
                  : 'Reserved for review; this payment has not been authorized.'
              }
              label={payment.authorized ? 'Resume payment' : 'Review reserved payment'}
              disabled={busy}
              onResume={() => void openPendingPayment(payment.operationId)}
            />
          ))
        : null}
      {error && (pendingPayments.length > 0 || error !== balanceError) ? <PaymentNotice message={error} /> : null}

      <PaymentArrivalBanners
        arrivals={arrivals}
        onOpen={(arrival) => openArrival(arrival.key)}
        onDismiss={dismissArrival}
      />
      {catchUp ? (
        <CatchUpBanner catchUp={catchUp} onOpenActivity={() => navigate('activity')} onDismiss={dismissCatchUp} />
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
      <button type='button' className='qg-text' onClick={() => navigate('activity')}>
        See all activity
      </button>
    </AccountHome>
  )
}
