import { ArrowRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { hapticSubtle } from '../../../lib/haptics'
import type { LightningAddress as Address } from '../../../lib/vault/lnurl'
import type { VaultStatus } from '../../../lib/vault/types'
import LightningAddress from '../LightningAddress'
import { QgTextButton } from './QgScreen'

export interface ReceiveMethod {
  id: string
  label: string
  icon?: ReactNode
  render: () => ReactNode
}

/**
 * Method tabs for receive screens. Exactly one method is visible; the parent
 * keeps the selected id so QR and Share payloads always match the method.
 */
export default function ReceiveMethods({
  methods,
  activeId,
  defaultId,
  onChange,
}: {
  methods: ReceiveMethod[]
  activeId?: string
  defaultId?: string
  onChange?: (id: string) => void
}) {
  const [internal, setInternal] = useState(defaultId ?? methods[0]?.id)
  const current = methods.find((method) => method.id === (activeId ?? internal)) ?? methods[0]
  if (!current) return null
  return (
    <div className='qg-receive-methods'>
      <div className='qg-methods-tabs' role='group' aria-label='Receive methods'>
        {methods.map((method) => {
          const on = method.id === current.id
          return (
            <button
              key={method.id}
              type='button'
              data-testid={`receive-method-${method.id}`}
              className={on ? 'qg-method-tab is-on' : 'qg-method-tab'}
              aria-pressed={on}
              onClick={() => {
                hapticSubtle()
                if (activeId === undefined) setInternal(method.id)
                onChange?.(method.id)
              }}
            >
              {method.icon ? <span aria-hidden='true'>{method.icon}</span> : null}
              {method.label}
            </button>
          )
        })}
      </div>
      <div className='qg-method-panel'>{current.render()}</div>
    </div>
  )
}

/** First-class Lightning method shared by the protected and Light receive screens. */
export function LightningReceiveMethod({
  status,
  onAddress,
  onInvoice,
}: {
  status: VaultStatus
  onAddress?: (address: Address | undefined) => void
  onInvoice: () => void
}) {
  return (
    <div className='qg-method-lightning'>
      <LightningAddress status={status} primary onChange={onAddress} />
      <QgTextButton
        label='Create invoice'
        testId='create-invoice'
        onClick={onInvoice}
        icon={<ArrowRight size={20} />}
      />
    </div>
  )
}
