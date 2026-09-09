import { useContext } from 'react'
import Text from '../../components/Text'
import TransferArrowIcon from '../../icons/TransferArrow'
import { prettyAmount, prettyNumber } from '../../lib/format'
import { hapticSubtle } from '../../lib/haptics'
import { RECENT_HISTORY_LIMIT } from '../../lib/vault/constants'
import { groupVaultHistory, type VaultHistoryItem } from '../../lib/vault/history'
import { describePayment } from '../../lib/vault/payments'
import { VaultContext } from '../../vault/context'
import styles from './History.module.css'

function historyTime(blockTime?: number): string {
  if (!blockTime) return ''
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(blockTime * 1000))
}

export function historyRowState(tx: VaultHistoryItem): string {
  const described = describePayment(tx)
  const time = historyTime(tx.blockTime)
  // Confirmed availability keeps its time; pending and attention rows keep
  // the shared state wording untouched.
  return time && described.complete && ['arkade', 'boarding', 'bitcoin-savings'].includes(described.route)
    ? `${described.state} · ${time}`
    : described.state
}

/** One activity row, shared by the Home recent list and full activity. */
export function VaultHistoryRow({ tx, openTx }: { tx: VaultHistoryItem; openTx: (tx: VaultHistoryItem) => void }) {
  const sent = tx.type === 'sent'
  const described = describePayment(tx)
  const amount = tx.displayAmount ?? tx.amount
  const state = historyRowState(tx)
  return (
    <button
      type='button'
      key={`${tx.account}:${tx.txid}:${tx.type}`}
      className='vault-history-row'
      data-testid={`vault-tx-${tx.txid}`}
      aria-label={`${described.title} ${prettyAmount(amount)}. ${state}.`}
      onClick={() => {
        hapticSubtle()
        openTx(tx)
      }}
    >
      <span className='vault-history-icon' aria-hidden='true'>
        <TransferArrowIcon incoming={!sent} />
      </span>
      <span className='vault-history-copy'>
        <Text small bold>
          {described.title}
        </Text>
        <Text color='neutral-600' tiny>
          {state}
        </Text>
      </span>
      <span className={sent ? 'vault-history-amt' : 'vault-history-amt is-in'}>
        {sent ? '−' : '+'}
        <span className='vault-history-unit'>₿</span>
        {prettyNumber(amount)}
      </span>
    </button>
  )
}

export default function VaultHistory() {
  const { account, balancesLoaded, history, openTx, refreshingBalance } = useContext(VaultContext)
  return (
    <VaultHistoryList
      account={account}
      balancesLoaded={balancesLoaded}
      history={history}
      openTx={openTx}
      refreshingBalance={refreshingBalance}
    />
  )
}

export function VaultHistoryList({
  account,
  balancesLoaded,
  history,
  openTx,
  refreshingBalance = false,
}: {
  account: 'spend' | 'savings'
  balancesLoaded: boolean
  history: VaultHistoryItem[]
  openTx: (tx: VaultHistoryItem) => void
  refreshingBalance?: boolean
}) {
  return (
    <section
      className='vault-history'
      data-testid='vault-history'
      aria-busy={!balancesLoaded || refreshingBalance}
      aria-labelledby='vault-activity-title'
    >
      <div className={`vault-history-head ${styles.head}`}>
        <h2 id='vault-activity-title'>Recent</h2>
        <span className={styles.refresh} role='status'>
          {refreshingBalance ? 'Updating…' : ''}
        </span>
      </div>
      {history.length === 0 ? (
        <div className='vault-history-empty' role={!balancesLoaded ? 'status' : undefined}>
          <p className='qg-copy'>
            {!balancesLoaded
              ? 'Loading activity…'
              : account === 'savings'
                ? 'No Savings activity yet. Add bitcoin to your Savings address to see it here.'
                : 'No Spending activity yet. Receive a payment to see it here.'}
          </p>
        </div>
      ) : (
        <div className={styles.groups}>
          {groupVaultHistory(history).map((group) => (
            <div className='vault-history-group' key={group.key}>
              <h3 className='vault-history-group-label vault-visually-hidden'>{group.label}</h3>
              {group.items.map((tx) => (
                <VaultHistoryRow key={`${tx.account}:${tx.txid}:${tx.type}`} tx={tx} openTx={openTx} />
              ))}
            </div>
          ))}
        </div>
      )}
      {history.length >= RECENT_HISTORY_LIMIT ? (
        <Text color='neutral-600' tiny wrap>
          Showing the latest {RECENT_HISTORY_LIMIT} transactions.
        </Text>
      ) : null}
    </section>
  )
}
