import { X } from 'lucide-react'
import { prettyNumber } from '../../lib/format'
import type { PaymentArrival } from '../../vault/usePaymentArrivals'

/**
 * Visible arrival feedback for verified incoming payments. Each banner names
 * the amount and destination account, opens the payment details, and can be
 * dismissed. The payer stays unknown: a deposit on a reusable address names
 * where funds landed, never who sent them. Announcements use a polite live
 * region so screen readers hear arrivals without interrupting the current
 * task; the banner stays fully usable with sound and haptics disabled.
 */
export default function PaymentArrivalBanners({
  arrivals,
  onOpen,
  onDismiss,
}: {
  arrivals: PaymentArrival[]
  onOpen: (arrival: PaymentArrival) => void
  onDismiss: (key: string) => void
}) {
  if (arrivals.length === 0) return null
  return (
    <section className='qg-payment-arrivals' role='status' aria-live='polite' aria-label='New payments received'>
      {arrivals.map((arrival) => {
        const amount = arrival.item.displayAmount ?? arrival.item.amount
        const account = arrival.item.account === 'savings' ? 'Savings' : 'Spending'
        return (
          <div className='qg-payment-arrival' key={arrival.key} data-testid={`payment-arrival-${arrival.key}`}>
            <div>
              <strong>{`Received ₿${prettyNumber(amount)} in ${account}.`}</strong>
            </div>
            <div className='qg-payment-arrival-actions'>
              <button type='button' onClick={() => onOpen(arrival)}>
                View details
              </button>
              <button
                type='button'
                className='qg-payment-arrival-dismiss'
                aria-label={`Dismiss arrival of ₿${prettyNumber(amount)} bitcoin in ${account}`}
                onClick={() => onDismiss(arrival.key)}
              >
                <X size={18} />
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
