import { Clock3 } from 'lucide-react'
import { formatMoney } from '../../../lib/vault/fiatDisplay'
import { useBalanceDenomination, type BalanceDenomination } from '../AccountBalance'

export default function PendingPayment({
  amount,
  description,
  label,
  disabled,
  onResume,
  denomination,
}: {
  amount: number
  description: string
  label: string
  disabled?: boolean
  onResume: () => void
  denomination?: BalanceDenomination
}) {
  const denom = useBalanceDenomination(denomination)
  return (
    <section className='qg-arrival' aria-label='Pending payment'>
      <span className='qg-status-icon' aria-hidden='true'>
        <Clock3 />
      </span>
      <div>
        <strong>Pending payment · {formatMoney(amount, { unit: denom.unit, rate: denom.rate })}</strong>
        <p>{description}</p>
        <button className='qg-text' type='button' disabled={disabled} onClick={onResume}>
          {label}
        </button>
      </div>
    </section>
  )
}
