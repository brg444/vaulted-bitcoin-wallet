import { useContext, useMemo, useState } from 'react'
import { groupVaultHistory, type VaultHistoryItem } from '../../lib/vault/history'
import { describePayment } from '../../lib/vault/payments'
import { VaultContext } from '../../vault/context'
import { VaultHistoryRow } from './History'
import QgScreen from './qg/QgScreen'
import styles from './History.module.css'

const ACTIVITY_PAGE_SIZE = 50

export type ActivityDirection = 'all' | 'received' | 'sent'
export type ActivityAccount = 'all' | 'spend' | 'savings'
export type ActivityStatus = 'all' | 'pending' | 'attention' | 'complete'

export interface ActivityFilters {
  direction: ActivityDirection
  account: ActivityAccount
  status: ActivityStatus
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = { direction: 'all', account: 'all', status: 'all' }

/** Attention first, then completion: unresolved funds never hide behind ordinary history. */
export function activityStatusOf(item: VaultHistoryItem): Exclude<ActivityStatus, 'all'> {
  const described = describePayment(item)
  if (described.attention !== 'none') return 'attention'
  return described.complete ? 'complete' : 'pending'
}

/** Stable-order filtering over loaded history; Home keeps its own bounded slice. */
export function filterActivity(rows: readonly VaultHistoryItem[], filters: ActivityFilters): VaultHistoryItem[] {
  return rows.filter(
    (item) =>
      (filters.direction === 'all' || item.type === filters.direction) &&
      (filters.account === 'all' || item.account === filters.account) &&
      (filters.status === 'all' || activityStatusOf(item) === filters.status),
  )
}

export default function VaultActivity() {
  const { allHistory, balancesLoaded, refreshingBalance, openTx, navigate, loadOlderActivity, olderActivity } =
    useContext(VaultContext)
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_ACTIVITY_FILTERS)
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE)
  const filtered = useMemo(() => filterActivity(allHistory, filters), [allHistory, filters])
  const page = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const groups = useMemo(() => groupVaultHistory(page), [page])
  const hasSavingsRows = useMemo(() => allHistory.some((item) => item.account === 'savings'), [allHistory])

  const setFilter = <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setVisibleCount(ACTIVITY_PAGE_SIZE)
  }

  return (
    <QgScreen title='Activity' dismiss={() => navigate('home')}>
      <section
        className='vault-history'
        data-testid='vault-activity'
        aria-busy={!balancesLoaded || refreshingBalance}
        aria-labelledby='vault-activity-full-title'
      >
        <div className={`vault-history-head ${styles.head}`}>
          <h2 id='vault-activity-full-title'>All activity</h2>
          <span className={styles.refresh} role='status'>
            {refreshingBalance ? 'Updating…' : ''}
          </span>
        </div>
        <div className='qg-activity-filters' role='group' aria-label='Filter activity'>
          <label>
            Direction
            <select
              data-testid='activity-filter-direction'
              value={filters.direction}
              onChange={(event) => setFilter('direction', event.target.value as ActivityDirection)}
            >
              <option value='all'>All</option>
              <option value='received'>Received</option>
              <option value='sent'>Sent</option>
            </select>
          </label>
          <label>
            Account
            <select
              data-testid='activity-filter-account'
              value={filters.account}
              onChange={(event) => setFilter('account', event.target.value as ActivityAccount)}
            >
              <option value='all'>All accounts</option>
              <option value='spend'>Spending</option>
              <option value='savings'>Savings</option>
            </select>
          </label>
          <label>
            Status
            <select
              data-testid='activity-filter-status'
              value={filters.status}
              onChange={(event) => setFilter('status', event.target.value as ActivityStatus)}
            >
              <option value='all'>All statuses</option>
              <option value='pending'>Pending</option>
              <option value='attention'>Needs attention</option>
              <option value='complete'>Completed</option>
            </select>
          </label>
        </div>
        {!balancesLoaded && allHistory.length === 0 ? (
          <div className='vault-history-empty' role='status'>
            <p className='qg-copy'>Loading activity…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className='vault-history-empty'>
            <p className='qg-copy'>
              {allHistory.length === 0
                ? 'No activity yet. Receive a payment to see it here.'
                : 'No payments match these filters.'}
            </p>
          </div>
        ) : (
          <div className={styles.groups}>
            {groups.map((group) => (
              <div className='vault-history-group' key={group.key}>
                <h3 className='vault-history-group-label'>{group.label}</h3>
                {group.items.map((tx) => (
                  <VaultHistoryRow key={`${tx.account}:${tx.txid}:${tx.type}`} tx={tx} openTx={openTx} />
                ))}
              </div>
            ))}
          </div>
        )}
        {visibleCount < filtered.length ? (
          <button
            type='button'
            className='qg-text'
            onClick={() => setVisibleCount((count) => count + ACTIVITY_PAGE_SIZE)}
          >
            Show more ({Math.min(visibleCount, filtered.length)} of {filtered.length})
          </button>
        ) : null}
        <p className='qg-copy' data-testid='activity-coverage'>
          Shows every loaded payment: all Vault and Lightning records plus the latest 100 Bitcoin records per address.
          Older Savings records load on request. Anything beyond the loaded window is not shown. Loaded activity is
          bounded at 300 records.
        </p>
        {hasSavingsRows && olderActivity.status !== 'exhausted' ? (
          <button
            type='button'
            className='qg-text'
            disabled={olderActivity.status === 'loading'}
            onClick={() => void loadOlderActivity()}
          >
            {olderActivity.status === 'loading' ? 'Loading older records…' : 'Load older Savings records'}
          </button>
        ) : null}
        {olderActivity.status === 'exhausted' ? <p className='qg-copy'>No older Savings records.</p> : null}
        {olderActivity.status === 'error' ? (
          <p className='qg-field-error' role='alert'>
            {olderActivity.error}
          </p>
        ) : null}
      </section>
    </QgScreen>
  )
}
