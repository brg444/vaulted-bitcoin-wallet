import QgAmount from './qg/QgAmount'
import { useContext } from 'react'
import { prettyAmount } from '../../lib/format'
import { vaultTransactionExplorer } from '../../lib/vault/explorer'
import { truncateAddress } from '../../lib/vault/policy'
import { VaultContext } from '../../vault/context'
import TransactionReference from './qg/TransactionReference'
import QgScreen, { QgCheck, QgPrimary } from './qg/QgScreen'

export default function VaultSuccess() {
  const { account, boardingAddress, lastSend, lastTxid, lastTxKind, navigate, status } = useContext(VaultContext)
  const movingToSpending = Boolean(lastSend && boardingAddress && lastSend.address === boardingAddress)
  const lightning = lastTxKind === 'lightning'
  const onchain = lastTxKind === 'onchain'
  const explorer = lastTxKind
    ? vaultTransactionExplorer(lastTxid, lastTxKind === 'onchain' ? 'onchain' : 'arkade', status?.network)
    : null

  const headline = onchain
    ? account === 'savings'
      ? 'Savings transfer submitted'
      : 'Bitcoin payment submitted'
    : lightning
      ? 'Payment started'
      : 'Payment sent'
  const copy = movingToSpending
    ? 'Bitcoin confirmation is next'
    : lightning
      ? 'Quote accepted. The Lightning payment is completing.'
      : lastTxKind === 'vtxo'
        ? 'Fast transfer complete'
        : onchain
          ? 'Bitcoin confirmation is next'
          : 'Done'

  return (
    <QgScreen variant='success' footer={<QgPrimary onClick={() => navigate('home')} label='Done' />}>
      <div className='qg-centered qg-success-screen'>
        <div className='qg-success-label'>
          <span>
            <QgCheck />
          </span>
          <p>{onchain ? 'Submitted' : lightning ? 'Started' : 'Sent'}</p>
        </div>
        <h1>{headline}</h1>
        <p className='qg-copy'>{copy}</p>
        {lastSend ? (
          <section className='qg-details'>
            <div>
              <span>Amount</span>
              <strong>
                <QgAmount value={prettyAmount(lastSend.amount)} />
              </strong>
            </div>
            <div>
              <span>To</span>
              <strong>
                {movingToSpending ? 'Spending' : lightning ? 'Lightning' : truncateAddress(lastSend.address, 8)}
              </strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{status?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
            </div>
          </section>
        ) : null}
        <TransactionReference txid={lastTxid} explorer={explorer} funding={lightning} />
      </div>
    </QgScreen>
  )
}
