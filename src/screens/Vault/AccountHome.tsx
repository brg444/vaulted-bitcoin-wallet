import type { ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, QrCode, ScanLine, Shield } from 'lucide-react'
import { prettyNumber } from '../../lib/format'
import { hapticLight, hapticSubtle } from '../../lib/haptics'
import Content from './Content'
import AccountBalance from './AccountBalance'
import { QgMark } from './qg/QgScreen'
import styles from './AccountHome.module.css'

type Action = { label: string; onClick: () => void; disabled?: boolean; icon?: ReactNode }

export default function AccountHome({
  account,
  totalSats,
  availableSats = 0,
  pendingSats = 0,
  balancesLoaded,
  refreshingBalance = false,
  onRefresh,
  security,
  onScan,
  onReceive,
  utilitiesDisabled = false,
  primaryAction,
  secondaryAction,
  alert,
  description,
  children,
}: {
  account: 'Spending' | 'Savings'
  totalSats?: number
  availableSats?: number
  pendingSats?: number
  balancesLoaded: boolean
  refreshingBalance?: boolean
  onRefresh?: () => Promise<void>
  security: { label: string; onClick: () => void; attention?: boolean; disabled?: boolean }
  onScan?: () => void
  onReceive?: () => void
  utilitiesDisabled?: boolean
  primaryAction: Action
  secondaryAction?: Action
  alert?: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  const spending = account === 'Spending'
  return (
    <Content className={`qg-home-content ${styles.content}`} onRefresh={onRefresh}>
      <main className={`qg-home ${styles.home}`}>
        <header className='qg-account-bar vault-account-bar'>
          <div className='qg-account' data-testid='account-switcher'>
            <QgMark />
            <strong>{account}</strong>
          </div>
          <div className='qg-utilities'>
            <button
              type='button'
              className={security.attention ? 'qg-recovery-shortcut needs-attention' : 'qg-recovery-shortcut'}
              aria-label={security.label}
              data-testid='account-recovery'
              disabled={security.disabled}
              onClick={() => {
                hapticSubtle()
                security.onClick()
              }}
            >
              <Shield />
              {security.attention ? <span aria-hidden='true' /> : null}
            </button>
            {onScan || onReceive ? <i className='qg-utility-divider' aria-hidden='true' /> : null}
            {onScan ? (
              <button
                type='button'
                aria-label={spending ? 'Scan a Spending payment' : 'Scan a Savings destination'}
                data-testid='account-scan'
                disabled={utilitiesDisabled}
                onClick={() => {
                  hapticSubtle()
                  onScan()
                }}
              >
                <ScanLine />
              </button>
            ) : null}
            {onReceive ? (
              <button
                type='button'
                aria-label={spending ? 'Receive to Spending' : 'Deposit'}
                data-testid='account-receive'
                disabled={utilitiesDisabled}
                onClick={onReceive}
              >
                <QrCode />
              </button>
            ) : null}
          </div>
        </header>
        {alert}
        {totalSats !== undefined ? (
          <AccountBalance
            sats={totalSats}
            account={account}
            balancesLoaded={balancesLoaded}
            refreshingBalance={refreshingBalance}
          />
        ) : null}
        {balancesLoaded && pendingSats > 0 ? (
          <p className='qg-available'>
            ₿{prettyNumber(availableSats)} available · ₿{prettyNumber(pendingSats)} pending
          </p>
        ) : null}
        {description ? <div className={styles.description}>{description}</div> : null}
        <div className='qg-actions'>
          <button
            type='button'
            disabled={primaryAction.disabled}
            onClick={() => {
              hapticLight()
              primaryAction.onClick()
            }}
          >
            <span>
              {primaryAction.icon ?? <ArrowUpRight />}
              <b>{primaryAction.label}</b>
            </span>
          </button>
          {secondaryAction ? (
            <button
              type='button'
              disabled={secondaryAction.disabled}
              onClick={() => {
                hapticLight()
                secondaryAction.onClick()
              }}
            >
              <span>
                {secondaryAction.icon ?? <ArrowDownLeft />}
                <b>{secondaryAction.label}</b>
              </span>
            </button>
          ) : null}
        </div>
        {children}
      </main>
    </Content>
  )
}
