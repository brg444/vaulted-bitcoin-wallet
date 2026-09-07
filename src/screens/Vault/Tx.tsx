import { useContext } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, Clock3 } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { prettyAmount, prettyDate } from '../../lib/format'
import { vaultTransactionExplorer } from '../../lib/vault/explorer'
import { VaultContext } from '../../vault/context'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import TransactionReference from './qg/TransactionReference'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

export default function VaultTx() {
  const { busy, error, navigate, retryLightningRefund, selectedTx, status: vaultStatus } = useContext(VaultContext)
  const sent = selectedTx?.type === 'sent'
  const boarding = selectedTx?.activity === 'boarding'
  const lightning = selectedTx?.activity === 'lightning'
  const explorer = selectedTx
    ? vaultTransactionExplorer(
        selectedTx.txid,
        boarding || selectedTx.account === 'savings' ? 'onchain' : 'arkade',
        vaultStatus?.network,
      )
    : null
  const status = selectedTx
    ? lightning
      ? ['claimed', 'settled'].includes(selectedTx.lightningState || '')
        ? 'Paid'
        : selectedTx.lightningState === 'refunded'
          ? 'Refunded'
          : selectedTx.lightningState === 'needs_counterparty'
            ? 'Ready to return'
            : selectedTx.lightningState === 'failed'
              ? 'Needs recovery'
              : 'Processing'
      : selectedTx.confirmed
        ? 'Confirmed'
        : 'Pending'
    : 'Unknown'
  const complete = lightning ? ['Paid', 'Refunded'].includes(status) : Boolean(selectedTx?.confirmed)
  const needsAction = ['Ready to return', 'Needs recovery'].includes(status)
  const state = !selectedTx ? 'unknown' : complete ? 'complete' : needsAction ? 'attention' : 'pending'
  const StatusIcon = !selectedTx ? CircleHelp : complete ? CircleCheck : needsAction ? CircleAlert : Clock3
  const copy = lightning
    ? status === 'Paid'
      ? 'This Lightning payment is complete.'
      : status === 'Refunded'
        ? 'This Lightning payment was refunded.'
        : status === 'Ready to return'
          ? 'Return the remaining payment funds to Spending.'
          : status === 'Needs recovery'
            ? 'This Lightning payment needs recovery.'
            : 'This Lightning payment is still processing.'
    : !selectedTx
      ? 'Transaction details are not available.'
      : selectedTx.confirmed
        ? 'This payment is confirmed.'
        : boarding || selectedTx.account === 'savings'
          ? 'This will update automatically after Bitcoin confirmation.'
          : 'This transfer is still processing.'
  const amount = selectedTx?.displayAmount ?? selectedTx?.amount ?? 0

  return (
    <QgScreen
      title={lightning ? 'Lightning payment' : 'Transaction'}
      dismiss={() => navigate('home')}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error} />
          {selectedTx?.lightningState === 'needs_counterparty' && selectedTx.lightningRfqId ? (
            <QgPrimary
              onClick={() => retryLightningRefund(selectedTx.lightningRfqId!)}
              disabled={busy}
              loading={busy}
              label='Return to Spending'
            />
          ) : null}
          <QgSecondary onClick={() => navigate('home')} label='Back to Wallet' />
        </>
      }
    >
      <div className='qg-pending-label' data-state={state}>
        <StatusIcon role='img' aria-label={`${status} status`} />
        <span>
          <strong>{status}</strong>
          <small>
            {selectedTx?.account === 'savings'
              ? sent
                ? 'From Savings'
                : 'To Savings'
              : lightning
                ? 'Lightning'
                : sent
                  ? 'Sent'
                  : 'Received'}
          </small>
        </span>
      </div>
      <div className='qg-transaction-amount'>
        <h1 style={amountSizeStyle(`${sent ? '−' : '+'}${prettyAmount(amount)}`)}>
          <QgAmount value={`${sent ? '−' : '+'}${prettyAmount(amount)}`} />
        </h1>
      </div>
      <section className='qg-details'>
        {lightning && selectedTx?.fee !== undefined ? (
          <div>
            <span>Fee</span>
            <strong>
              <QgAmount value={prettyAmount(selectedTx.fee)} />
            </strong>
          </div>
        ) : null}
        <div>
          <span>When</span>
          <strong>{selectedTx?.blockTime ? prettyDate(selectedTx.blockTime) : 'Not available yet'}</strong>
        </div>
        <div>
          <span>Account</span>
          <strong>{selectedTx?.account === 'savings' ? 'Savings' : 'Spending'}</strong>
        </div>
        <div>
          <span>Network</span>
          <strong>{vaultStatus?.network === 'mainnet' ? 'Bitcoin' : 'Mutinynet'}</strong>
        </div>
      </section>
      <TransactionReference txid={selectedTx?.txid || ''} explorer={explorer} funding={lightning} />
      <p className='qg-copy'>{copy}</p>
    </QgScreen>
  )
}
