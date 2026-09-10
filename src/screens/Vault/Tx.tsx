import BitcoinPaymentStatus from './BitcoinPaymentStatus'
import { useContext } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, Clock3 } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { prettyDate } from '../../lib/format'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { vaultTransactionExplorer } from '../../lib/vault/explorer'
import { describePayment } from '../../lib/vault/payments'
import { VaultContext } from '../../vault/context'
import { useBalanceDenomination, type BalanceDenomination } from './AccountBalance'
import QgAmount, { amountSizeStyle } from './qg/QgAmount'
import TransactionReference from './qg/TransactionReference'
import QgScreen, { QgPrimary, QgSecondary } from './qg/QgScreen'

export default function VaultTx({ denomination }: { denomination?: BalanceDenomination }) {
  const {
    busy,
    error,
    navigate,
    retryLightningRefund,
    selectedTx,
    spendingBitcoin,
    status: vaultStatus,
    txReturn,
  } = useContext(VaultContext)
  const denom = useBalanceDenomination(denomination)
  const money = { unit: denom.unit, rate: denom.rate }
  const bitcoin = selectedTx?.activity === 'bitcoin'
  const operation =
    bitcoin && spendingBitcoin?.operation && spendingBitcoin.operation.operationId === selectedTx?.bitcoinOperationId
      ? spendingBitcoin.operation
      : null
  const sent = selectedTx?.type === 'sent'
  const boarding = selectedTx?.activity === 'boarding'
  const lightning = selectedTx?.activity === 'lightning'
  const described = selectedTx ? describePayment(selectedTx) : null
  const explorer =
    selectedTx && !selectedTx.txid.startsWith('bitcoin:')
      ? vaultTransactionExplorer(
          selectedTx.txid,
          boarding || bitcoin || selectedTx.account === 'savings' ? 'onchain' : 'arkade',
          vaultStatus?.network,
        )
      : null
  const status = described?.state || 'Unknown'
  const complete = described?.complete || false
  const needsAction = (described?.attention || 'none') !== 'none'
  const state = !selectedTx ? 'unknown' : complete ? 'complete' : needsAction ? 'attention' : 'pending'
  const StatusIcon = !selectedTx ? CircleHelp : complete ? CircleCheck : needsAction ? CircleAlert : Clock3
  const copy = !selectedTx
    ? 'Transaction details are not available.'
    : described?.copy || 'Transaction details are not available.'
  const amount = selectedTx?.displayAmount ?? selectedTx?.amount ?? 0

  return (
    <QgScreen
      title={lightning ? 'Lightning payment' : bitcoin ? 'Bitcoin payment' : 'Transaction'}
      dismiss={() => navigate(txReturn)}
      footer={
        <>
          <ErrorMessage error={Boolean(error)} text={error} />
          {sent && selectedTx?.lightningState === 'needs_counterparty' && selectedTx.lightningRfqId ? (
            <QgPrimary
              onClick={() => retryLightningRefund(selectedTx.lightningRfqId!)}
              disabled={busy}
              loading={busy}
              label='Return to Spending'
            />
          ) : null}
          <QgSecondary onClick={() => navigate(txReturn)} label='Back to Wallet' />
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
        <h1 style={amountSizeStyle(`${sent ? '−' : '+'}${formatMoney(amount, money)}`)}>
          <QgAmount value={`${sent ? '−' : '+'}${formatMoney(amount, money)}`} />
        </h1>
      </div>
      <section className='qg-details'>
        {(lightning || bitcoin) && selectedTx?.fee !== undefined ? (
          <div>
            <span>{lightning && !sent ? 'Fee paid by sender' : 'Fee'}</span>
            <strong>
              <QgAmount value={formatMoney(selectedTx.fee, money)} />
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
      <TransactionReference
        txid={selectedTx?.txid.startsWith('bitcoin:') ? '' : selectedTx?.txid || ''}
        explorer={explorer}
        funding={lightning}
      />
      {operation && vaultStatus ? (
        <BitcoinPaymentStatus status={vaultStatus} operation={operation} />
      ) : (
        <p className='qg-copy'>{copy}</p>
      )}
    </QgScreen>
  )
}
