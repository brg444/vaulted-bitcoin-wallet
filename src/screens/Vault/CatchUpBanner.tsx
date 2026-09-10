import { X } from 'lucide-react'
import { formatMoney } from '../../lib/vault/fiatDisplay'
import { useBalanceDenomination } from './AccountBalance'
import type { PaymentCatchUp } from '../../vault/usePaymentArrivals'

/**
 * One accessible catch-up notice for newly verified incoming payments that
 * landed together, such as after reconnect or reopen. It names the count and
 * total, links to full Activity, and dismisses without replay: the covered
 * payments are already claimed and marked seen. Amounts follow the same
 * in-app convention as arrival banners; the notice stays fully usable with
 * haptics disabled.
 */
export default function CatchUpBanner({
  catchUp,
  onOpenActivity,
  onDismiss,
}: {
  catchUp: PaymentCatchUp
  onOpenActivity: () => void
  onDismiss: () => void
}) {
  const denomination = useBalanceDenomination()
  const amount = formatMoney(catchUp.totalSats, denomination)
  return (
    <section className='qg-payment-arrivals' role='status' aria-live='polite' aria-label='New payments summary'>
      <div className='qg-payment-arrival' data-testid='payment-catch-up'>
        <div>
          <strong>
            {catchUp.count === 1
              ? `1 new payment received · ${amount}.`
              : `${catchUp.count} new payments received · ${amount} total.`}
          </strong>
        </div>
        <div className='qg-payment-arrival-actions'>
          <button type='button' onClick={onOpenActivity}>
            View activity
          </button>
          <button
            type='button'
            className='qg-payment-arrival-dismiss'
            aria-label='Dismiss new payments summary'
            onClick={onDismiss}
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </section>
  )
}
