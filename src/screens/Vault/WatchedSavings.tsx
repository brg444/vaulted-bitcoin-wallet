import { useContext, useState } from 'react'
import { Eye, Pencil, Plus } from 'lucide-react'
import { VaultContext } from '../../vault/context'
import AccountHome from './AccountHome'
import VaultHistory from './History'
import QgScreen, { QgPrimary } from './qg/QgScreen'

export default function WatchedSavings() {
  const {
    watchedSavings,
    updateWatchedSavings,
    positions,
    balancesLoaded,
    refreshingBalance,
    refreshBalance,
    navigate,
    openRecover,
    balanceError,
  } = useContext(VaultContext)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState(watchedSavings?.address || '')
  const [label, setLabel] = useState(watchedSavings?.label || '')
  const [error, setError] = useState('')
  const edit = () => {
    setAddress(watchedSavings?.address || '')
    setLabel(watchedSavings?.label || '')
    setError('')
    setEditing(true)
  }
  if (editing)
    return (
      <QgScreen
        title='Watch Savings'
        back={() => setEditing(false)}
        footer={
          <QgPrimary
            label='Save address'
            onClick={() => {
              try {
                if (!updateWatchedSavings) throw new Error('Wallet is not ready')
                updateWatchedSavings(address, label)
                setEditing(false)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Check the address')
              }
            }}
          />
        }
      >
        <h1>Your Savings, in view</h1>
        <p className='qg-copy'>
          Add a Bitcoin receiving address from your other wallet to follow its balance and activity.
        </p>
        <label className='qg-field'>
          <span>Bitcoin address</span>
          <input
            aria-label='Savings Bitcoin address'
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
          />
        </label>
        <label className='qg-field'>
          <span>Label</span>
          <input
            aria-label='Savings label'
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            placeholder='My Savings'
          />
        </label>
        <p className='qg-copy'>Funds stay in your other wallet. Use that wallet to send them.</p>
        {error ? (
          <p role='alert' className='qg-copy'>
            {error}
          </p>
        ) : null}
      </QgScreen>
    )
  return (
    <AccountHome
      account='Savings'
      totalSats={watchedSavings ? positions.savings.totalSats : undefined}
      balancesLoaded={balancesLoaded}
      refreshingBalance={refreshingBalance}
      onRefresh={() => refreshBalance()}
      security={{ label: 'Open Recovery', onClick: () => openRecover('lost', 'home') }}
      primaryAction={{
        label: watchedSavings ? 'Edit address' : 'Add address',
        icon: watchedSavings ? <Pencil /> : <Plus />,
        onClick: edit,
      }}
      secondaryAction={watchedSavings ? { label: 'Deposit', onClick: () => navigate('receive') } : undefined}
      description={
        <>
          <p>
            <Eye size={16} aria-hidden='true' /> {watchedSavings?.label || 'Watch-only Savings'}
          </p>
          <p className='qg-copy'>
            {watchedSavings ? 'Held in your other wallet.' : 'Keep an eye on Savings held in another Bitcoin wallet.'}
          </p>
        </>
      }
    >
      {balanceError ? (
        <p role='status' className='qg-copy'>
          {balanceError}
        </p>
      ) : null}
      {watchedSavings ? (
        <>
          <VaultHistory />
          <button type='button' className='qg-text' onClick={() => navigate('activity')}>
            See all activity
          </button>
        </>
      ) : null}
    </AccountHome>
  )
}
