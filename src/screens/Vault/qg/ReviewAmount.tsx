import type { ReactNode } from 'react'
import QgAmount, { amountSizeStyle } from './QgAmount'

export default function ReviewAmount({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children?: ReactNode
}) {
  return (
    <section className='qg-review-amount'>
      <small>{label}</small>
      <strong style={amountSizeStyle(value)}>
        <QgAmount value={value} />
      </strong>
      {children}
    </section>
  )
}
