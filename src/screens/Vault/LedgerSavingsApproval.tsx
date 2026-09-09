import { useEffect, useRef, useState } from 'react'
import type { LedgerSavingsContract, LedgerSavingsPayment } from '../../lib/vault/ledgerSavings'
import type { LedgerSavingsRegistration } from '../../lib/vault/ledgerClient'
import QgScreen, { QgPrimary } from './qg/QgScreen'
import QgGuidance from './qg/QgGuidance'

// The enrolled native coordinator supplies the reconstructed contract and retained
// phone approval. This component never selects a contract or broadcasts a payment.
type Props = {
  onBack: () => void
} & (
  | {
      mode: 'register'
      contract: LedgerSavingsContract
      onRegistered: (record: LedgerSavingsRegistration) => Promise<void>
    }
  | {
      mode: 'sign'
      payment: LedgerSavingsPayment
      phonePsbt: string
      registration: LedgerSavingsRegistration
      onSigned: (psbt: string) => Promise<void>
    }
)

export default function LedgerSavingsApproval(props: Props) {
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const identity = JSON.stringify(
    props.mode === 'register' ? props.contract : [props.payment, props.phonePsbt, props.registration],
  )
  const activeIdentity = useRef(identity)
  activeIdentity.current = identity
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    setFinished(false)
    setError('')
    setMessage(
      inFlight.current
        ? 'The payment changed. Finish or reject the previous request on your Ledger before continuing.'
        : '',
    )
  }, [identity])
  const registering = props.mode === 'register'
  const supported = globalThis.isSecureContext && typeof navigator !== 'undefined' && 'hid' in navigator

  const run = async () => {
    if (inFlight.current || finished) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setMessage('Connect your Ledger and open its Bitcoin app.')
    const requestIdentity = identity
    const current = () => mounted.current && activeIdentity.current === requestIdentity
    let session:
      | Awaited<ReturnType<(typeof import('../../lib/vault/ledgerClient'))['connectLedgerSavings']>>
      | undefined
    let saving = false
    try {
      const client = await import('../../lib/vault/ledgerClient')
      if (!current()) return
      session = await client.connectLedgerSavings()
      if (!current()) return
      if (props.mode === 'register') {
        setMessage('Review Vaulted Savings on your Ledger, then verify its receiving address.')
        const registration = await client.registerLedgerSavings(session.app, props.contract)
        if (!current()) return
        saving = true
        await props.onRegistered(registration)
      } else {
        setMessage('Check the recipient, amount and fee on your Ledger, then approve the payment.')
        const signed = await client.signLedgerSavings(session.app, props.payment, props.phonePsbt, props.registration)
        if (!current()) return
        saving = true
        await props.onSigned(signed)
      }
      if (current()) {
        setFinished(true)
        setMessage(registering ? 'Savings address verified.' : 'Ledger approval verified.')
      }
    } catch {
      if (current()) {
        setMessage('')
        if (saving) setFinished(true)
        setError(
          saving
            ? 'The approval could not be saved. Return to your wallet to check this action before trying again.'
            : 'Ledger approval was not completed. Check the device and connection, then try again when you’re ready.',
        )
      }
    } finally {
      // Cleanup must not turn an already accepted signature into a failed payment.
      await session?.close().catch(() => {})
      inFlight.current = false
      if (mounted.current) {
        setBusy(false)
        if (!current()) setMessage('Review this payment before approving on Ledger.')
      }
    }
  }

  return (
    <QgScreen
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
          onClick={() => (finished ? props.onBack() : void run())}
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
    </QgScreen>
  )
}
