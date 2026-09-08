import type { ReactNode } from 'react'
import { Clock3 } from 'lucide-react'
import { QgCheck, QgMark } from './QgScreen'

/** Presentation only: the caller supplies the evidenced outcome and available details. */
export default function PaymentResult({
  state,
  title,
  copy,
  children,
}: {
  state: 'sent' | 'submitted' | 'started'
  title: string
  copy?: string
  children?: ReactNode
}) {
  return (
    <div className='qg-centered qg-success-screen'>
      <section className='qg-result'>
        <div className='qg-result-heading'>
          <div className='qg-success-label' data-state={state}>
            <span>{state === 'sent' ? <QgCheck /> : <Clock3 aria-hidden='true' />}</span>
            <p>{state === 'sent' ? 'Sent' : state === 'submitted' ? 'Submitted' : 'Started'}</p>
          </div>
          <QgMark className='qg-mark qg-mark-imprint' />
        </div>
        <h1>{title}</h1>
        {copy ? <p className='qg-copy'>{copy}</p> : null}
        {children}
      </section>
    </div>
  )
}
