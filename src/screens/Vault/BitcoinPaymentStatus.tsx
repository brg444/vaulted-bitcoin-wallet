import { useBitcoinPayment } from '../../vault/bitcoinPaymentContext'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { vaultAddressNetwork } from '../../lib/vault/bitcoin'
import { bitcoinPlanOutputs, type BitcoinPaymentJournal } from '../../lib/vault/spendingBitcoinStore'
import type { VaultStatus } from '../../lib/vault/types'
import { QgSecondary } from './qg/QgScreen'
import { useBalanceDenomination } from './AccountBalance'

/** Details for the selected history row; reconciliation continues automatically. */
export default function BitcoinPaymentStatus({
  status,
  operation,
  error = '',
}: {
  status: VaultStatus
  operation: BitcoinPaymentJournal | null
  error?: string
}) {
  const payment = useBitcoinPayment()
  const busy = payment.pending !== null
  const message =
    payment.error || (payment.notice?.operationId === operation?.operationId ? payment.notice?.message : '')
  const denom = useBalanceDenomination()
  const money = { unit: denom.unit, rate: denom.rate }
  if (!operation) return error ? <p role='alert'>{error}</p> : null
  const outputs = operation.plan ? bitcoinPlanOutputs(operation.plan.plan) : operation.outputs || []
  return (
    <>
      {error ? <p role='alert'>{error}</p> : null}
      <section className='qg-details' aria-label='Bitcoin payment outputs'>
        {outputs.map((output, i) => (
          // Output position identifies immutable duplicate approval outputs.
          // eslint-disable-next-line react/no-array-index-key
          <div key={`${i}:${output.script}`}>
            <span>
              Output {i + 1} · {formatMoney(output.amountSats, money)}
            </span>
            <strong style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
              {Address(vaultAddressNetwork(status.network)).encode(OutScript.decode(hex.decode(output.script)))}
            </strong>
          </div>
        ))}
      </section>
      <p className='qg-copy'>
        {operation.stage === 'confirmed'
          ? 'Payment confirmed. Saving updated Spending recovery data.'
          : operation.receipt?.state === 'submitted'
            ? 'Waiting for Bitcoin confirmation. Your remaining change may be unavailable until the replacement Spending output appears.'
            : 'The payment outcome is still being checked. Its funds remain reserved.'}
      </p>
      {message ? (
        <p role='status' className='qg-copy'>
          {message}
        </p>
      ) : null}
      <QgSecondary
        label={busy ? 'Checking…' : 'Check payment status'}
        disabled={busy}
        onClick={() => {
          void payment.check(operation.operationId).catch(() => undefined)
        }}
      />
      {!operation.final && !operation.receipt?.commitmentTxid ? (
        <QgSecondary
          label='Cancel payment'
          disabled={busy}
          onClick={() => {
            void payment.cancel(operation.operationId).catch(() => undefined)
          }}
        />
      ) : null}
    </>
  )
}
