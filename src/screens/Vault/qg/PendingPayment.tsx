import { Clock3 } from 'lucide-react'
import { prettyAmount } from '../../../lib/format'

export default function PendingPayment({
  amount,
  description,
  label,
  disabled,
  onResume,
}: {
  amount: number
  description: string
  label: string
  disabled?: boolean
  onResume: () => void
}) {
  return (
    <section className='qg-arrival' aria-label='Pending payment'>
      <span className='qg-status-icon' aria-hidden='true'>
        <Clock3 />
      </span>
      <div>
        <strong>Pending payment · {prettyAmount(amount)}</strong>
        <p>{description}</p>
        <button className='qg-text' type='button' disabled={disabled} onClick={onResume}>
          {label}
        </button>
      </div>
    </section>
  )
}
