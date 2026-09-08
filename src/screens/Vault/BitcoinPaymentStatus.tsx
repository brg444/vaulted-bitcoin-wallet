import { Clock3 } from 'lucide-react'
import { useState } from 'react'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { vaultAddressNetwork } from '../../lib/vault/bitcoin'
import { bitcoinPlanOutputs, type BitcoinPaymentJournal } from '../../lib/vault/spendingBitcoinStore'
import { checkSpendingBitcoin } from '../../lib/vault/spendingBitcoinFunding'
import type { VaultStatus } from '../../lib/vault/types'
import { QgSecondary } from './qg/QgScreen'
export default function BitcoinPaymentStatus({
  status,
  operation,
  error = '',
}: {
  status: VaultStatus
  operation: BitcoinPaymentJournal | null
  error?: string
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const outputs = operation?.plan ? bitcoinPlanOutputs(operation.plan.plan) : operation?.outputs
  return (
    <section className='qg-arrival' aria-label='Pending Bitcoin payment'>
      <span className='qg-status-icon' aria-hidden>
        <Clock3 />
      </span>
      <div style={{ minWidth: 0 }}>
        <strong>Bitcoin payment from Spending</strong>
        {outputs?.map((output, i) => (
          // Output position distinguishes immutable duplicate approval outputs.
          // eslint-disable-next-line react/no-array-index-key
          <p key={i} className='qg-copy' style={{ overflowWrap: 'anywhere' }}>
            {output.amountSats.toLocaleString()} sats to{' '}
            {Address(vaultAddressNetwork(status.network)).encode(OutScript.decode(hex.decode(output.script)))}
          </p>
        ))}
        <p>
          {error ||
            message ||
            (operation?.stage === 'confirmed'
              ? 'Payment confirmed. Saving updated Spending recovery data.'
              : operation?.receipt?.state === 'submitted'
                ? 'Submitted. Waiting for Bitcoin confirmation.'
                : operation?.final
                  ? 'The payment outcome is still being checked. Its funds remain reserved.'
                  : 'Payment pending. Its funds remain reserved.')}
        </p>
        {operation?.plan ? <p>Fee: {operation.plan.plan.feeSats} sats</p> : null}
        <QgSecondary
          label={busy ? 'Checking…' : 'Check payment status'}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setMessage('')
            void checkSpendingBitcoin(status)
              .catch((e) => setMessage((e as Error).message))
              .finally(() => setBusy(false))
          }}
        />
      </div>
    </section>
  )
}
