import { useContext, useEffect } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock3, QrCode, ScanLine, Shield, ShieldAlert } from 'lucide-react'
import { prettyNumber } from '../../lib/format'
import { hapticLight, hapticSubtle } from '../../lib/haptics'
import { reloadIfNewerWallet } from '../../lib/vault/update'
import { VaultContext } from '../../vault/context'
import Content from './Content'
import AccountBalance from './AccountBalance'
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

        <AccountBalance
          sats={position.totalSats}
          account={spending ? 'Spending' : 'Savings'}
          balancesLoaded={balancesLoaded}
          refreshingBalance={refreshingBalance}
        />
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
