import { useContext } from 'react'
import Text from '../../components/Text'
import TransferArrowIcon from '../../icons/TransferArrow'
import { prettyAmount, prettyNumber } from '../../lib/format'
import { hapticSubtle } from '../../lib/haptics'
import { RECENT_HISTORY_LIMIT } from '../../lib/vault/constants'
import { groupVaultHistory, type VaultHistoryItem } from '../../lib/vault/history'
import { VaultContext } from '../../vault/context'
import styles from './History.module.css'

function historyTime(blockTime?: number): string {
  if (!blockTime) return ''
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(blockTime * 1000))
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
              {group.items.map((tx) => {
                const sent = tx.type === 'sent'
                const lightning = tx.activity === 'lightning'
                const savingsHandoff = tx.activity === 'savings-handoff'
                const connector = tx.activity === 'savings-connector'
                const connectorLabel =
                  tx.connectorStage === 'broadcast'
                    ? 'Savings transfer pending'
                    : tx.connectorStage === 'signer'
                      ? 'Waiting for signer'
                      : 'Savings approval pending'
                const amount = tx.displayAmount ?? tx.amount
                const time = historyTime(tx.blockTime)
                const state = connector
                  ? tx.connectorStage === 'broadcast'
                    ? 'Check or retry broadcast'
                    : 'Continue payment'
                  : savingsHandoff
                    ? 'Complete or cancel'
                    : lightning
                      ? ['claimed', 'settled'].includes(tx.lightningState || '')
                        ? 'Paid'
                        : tx.lightningState === 'refunded'
                          ? 'Refunded'
                          : tx.lightningState === 'needs_counterparty'
                            ? 'Ready to return'
                            : tx.lightningState === 'failed'
                              ? 'Needs recovery'
                              : 'Processing'
                      : tx.confirmed
                        ? time
                          ? `Confirmed · ${time}`
                          : 'Confirmed'
                        : 'Pending'
                return (
                  <button
                    type='button'
                    key={`${tx.account}:${tx.txid}:${tx.type}`}
                    className='vault-history-row'
                    data-testid={`vault-tx-${tx.txid}`}
                    aria-label={`${connector ? connectorLabel : savingsHandoff ? 'Waiting for hardware' : lightning ? 'Lightning payment' : sent ? 'Sent' : 'Received'} ${prettyAmount(amount)}. ${state}.`}
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
                        {connector
                          ? connectorLabel
                          : savingsHandoff
                            ? 'Waiting for hardware'
                            : lightning
                              ? 'Lightning payment'
                              : sent
                                ? 'Sent'
                                : 'Received'}
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
              })}
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
