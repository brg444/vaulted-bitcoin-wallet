import type { LedgerSavingsPayment } from '../../lib/vault/ledgerSavings'
import type { LedgerApprovalPhase } from '../../lib/vault/ledgerApproval'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary } from './qg/QgScreen'
import QgGuidance from './qg/QgGuidance'

type Props = {
  onBack: () => void
  onApprove: () => Promise<unknown>
  busy: boolean
  phase: LedgerApprovalPhase
  error: string
} & ({ mode: 'register' } | { mode: 'sign'; payment: LedgerSavingsPayment })

/** The operation owner supplies the saved candidate and performs every device action. */
export default function LedgerSavingsApproval(props: Props) {
  const { busy, error } = props
  const registering = props.mode === 'register'
  const finished = props.phase === 'complete' || props.phase === 'check'
  const supported = globalThis.isSecureContext && typeof navigator !== 'undefined' && 'hid' in navigator
  const message =
    props.phase === 'connecting'
      ? 'Connect your Ledger and open its Bitcoin app.'
      : props.phase === 'approving'
        ? registering
          ? 'Review Vaulted Savings on your Ledger, then verify its receiving address.'
          : 'Check the recipient, amount and fee on your Ledger, then approve the payment.'
        : props.phase === 'saving'
          ? 'Saving your approval…'
          : props.phase === 'complete'
            ? registering
              ? 'Savings address verified.'
              : 'Ledger approval verified.'
            : props.phase === 'check'
              ? 'Return to your wallet to check this action before trying again.'
              : ''

  return (
    <WalletScreen
      title={registering ? 'Set up Ledger' : 'Approve on Ledger'}
      back={busy ? undefined : props.onBack}
      footer={
        <QgPrimary
          label={
            busy
              ? 'Check your Ledger…'
              : finished
                ? 'Return to your wallet'
                : registering
                  ? 'Connect and set up Ledger'
                  : 'Approve with Ledger'
          }
          disabled={busy || !supported}
          onClick={() => (finished ? props.onBack() : void props.onApprove().catch(() => undefined))}
        />
      }
    >
      <h1>{registering ? 'Verify your Savings wallet' : 'Review your payment'}</h1>
      <p className='qg-copy'>
        {registering
          ? 'Vaulted sends the complete wallet policy to your Ledger. Review it once on the device, then confirm the Savings address before receiving bitcoin.'
          : 'Your phone has approved this payment. Check the recipient address, amount and fee on your Ledger before signing.'}
      </p>
      {props.mode === 'sign' ? (
        <dl className='qg-stack' aria-label='Payment details'>
          <dt>Recipient</dt>
          <dd className='qg-full-value'>{props.payment.destAddress}</dd>
          <dt>Amount</dt>
          <dd>{props.payment.amountSats.toLocaleString()} sats</dd>
          <dt>Network fee</dt>
          <dd>{props.payment.feeSats.toLocaleString()} sats</dd>
        </dl>
      ) : (
        <QgGuidance title='One setup, then ordinary payment approval'>
          <p>
            The device reviews several public keys as part of one policy. Vaulted supplies them automatically; you don’t
            enter keys individually.
          </p>
          <p>
            Your Ledger backup restores its keys. Keep your Vaulted recovery package too, so the exact Savings policy
            can be registered again if needed.
          </p>
        </QgGuidance>
      )}
      {!supported ? (
        <p role='status'>
          USB signing is available in a supported desktop browser. Open this signing flow there with your Ledger
          connected.
        </p>
      ) : null}
      {message ? (
        <p role='status' aria-live='polite'>
          {message}
        </p>
      ) : null}
      {error ? <p role='alert'>{error}</p> : null}
    </WalletScreen>
  )
}
