import { useContext } from 'react'
import { X } from 'lucide-react'
import { VaultContext } from '../../../vault/context'

export default function PaymentNotice({ message }: { message: string }) {
  const { error, paymentError, dismissError } = useContext(VaultContext)
  const payment = paymentError?.message === message ? paymentError : undefined
  const waiting = Boolean(payment?.retryAt)
  return (
    <section
      className={`qg-payment-notice${waiting ? ' qg-payment-notice-wait' : ''}`}
      role={waiting ? 'status' : 'alert'}
    >
      {error === message && dismissError ? (
        <button type='button' className='qg-payment-notice-dismiss' aria-label='Dismiss message' onClick={dismissError}>
          <X size={18} />
        </button>
      ) : null}
      {payment ? (
        <strong>
          {waiting
            ? 'Onchain payment unavailable'
            : payment.outcome === 'not_sent'
              ? 'Payment not sent'
              : 'Payment needs attention'}
        </strong>
      ) : null}
      <p>{message}</p>
      {payment?.details ? (
        <details>
          <summary>Technical details</summary>
          <pre>{payment.details}</pre>
        </details>
      ) : null}
    </section>
  )
}
