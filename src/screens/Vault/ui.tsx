import { useState, type ReactNode } from 'react'
import Text from '../../components/Text'
import { prettyAmount } from '../../lib/format'
import { waitLabel } from '../../lib/vault/policy'

export function IconBubble({ children, small }: { children: ReactNode; small?: boolean }) {
  return <div className={small ? 'vault-icon sm' : 'vault-icon'}>{children}</div>
}

export function HubGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className='vault-section'>
      {label ? <p className='vault-section-label'>{label}</p> : null}
      <div className='vault-hub'>{children}</div>
    </div>
  )
}

export function HubRow({
  icon,
  title,
  detail,
  status,
  signal,
  onClick,
  testId,
  danger,
  chevron,
}: {
  icon?: ReactNode
  title: string
  detail?: string
  status?: string
  signal?: 'ok' | 'bad' | 'wait'
  onClick?: () => void
  testId?: string
  danger?: boolean
  chevron?: boolean
}) {
  const signalLabel =
    signal === 'ok' ? 'Online' : signal === 'bad' ? 'Can’t reach' : signal === 'wait' ? 'Checking' : ''
  const body = (
    <>
      {icon ? <IconBubble small>{icon}</IconBubble> : null}
      <div className='vault-hub-copy'>
        <Text small bold>
          {title}
        </Text>
        {detail ? (
          <Text color='neutral-600' tiny wrap>
            {detail}
          </Text>
        ) : null}
      </div>
      {signal || status ? (
        <span className='vault-hub-end'>
          {signal ? (
            <span
              className={`vault-hub-signal ${signal}`}
              aria-hidden={Boolean(status)}
              aria-label={status ? undefined : signalLabel}
              title={signalLabel}
            />
          ) : null}
          {status ? (
            <Text color='neutral-600' tiny>
              {status}
            </Text>
          ) : null}
        </span>
      ) : null}
      {onClick && chevron !== false ? (
        <span className='vault-hub-chevron' aria-hidden='true'>
          ›
        </span>
      ) : null}
    </>
  )
  const className = danger ? 'vault-hub-row is-danger' : 'vault-hub-row'
  if (onClick) {
    return (
      <button type='button' className={className} onClick={onClick} data-testid={testId}>
        {body}
      </button>
    )
  }
  return (
    <div className={className} data-testid={testId}>
      {body}
    </div>
  )
}

export function Panel({
  children,
  selected,
  onClick,
  testId,
}: {
  children: ReactNode
  selected?: boolean
  onClick?: () => void
  testId?: string
}) {
  if (onClick) {
    return (
      <button
        type='button'
        className={selected ? 'vault-panel selected' : 'vault-panel'}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </button>
    )
  }
  return (
    <div className={selected ? 'vault-panel selected' : 'vault-panel'} data-testid={testId}>
      {children}
    </div>
  )
}

export function Reveal({
  label,
  children,
  defaultOpen = false,
}: {
  label: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className='vault-reveal'>
      <button type='button' className='vault-inline-action' onClick={() => setOpen((v) => !v)}>
        <Text color='neutral-600' tiny>
          {open ? 'Hide details' : label}
        </Text>
      </button>
      <div className={open ? 'vault-reveal-content is-open' : 'vault-reveal-content'}>{children}</div>
    </div>
  )
}

export function PolicyTimeline({
  txCap,
  dailyLimit,
  phoneRecoveryBlocks,
  hardwareRecoveryBlocks,
  network,
}: {
  txCap: number
  dailyLimit: number
  phoneRecoveryBlocks: number
  hardwareRecoveryBlocks: number
  network?: string
}) {
  const rows = [
    {
      title: 'Spending limits',
      detail: `${prettyAmount(txCap)} per payment, ${prettyAmount(dailyLimit)} over a rolling 24 hours.`,
    },
    {
      title: 'If you lose this device',
      detail: `Sign in on another device, or start recovery with hardware (${waitLabel(hardwareRecoveryBlocks, network)}).`,
    },
    {
      title: 'If you lose hardware',
      detail: `Start recovery from this device (${waitLabel(phoneRecoveryBlocks, network)}). Cancel if it wasn’t you.`,
    },
    {
      title: 'Savings',
      detail: 'This device + hardware now. Or start recovery, wait, then move.',
    },
  ]
  return (
    <div className='vault-path'>
      {rows.map((row, i) => (
        <div className='vault-path-row' key={row.title}>
          <div className='vault-path-mark'>
            <span className='vault-path-dot' />
            {i < rows.length - 1 ? <span className='vault-path-line' /> : null}
          </div>
          <div style={{ paddingBottom: i < rows.length - 1 ? '0.85rem' : 0 }}>
            <Text small bold>
              {row.title}
            </Text>
            <Text color='neutral-600' tiny wrap>
              {row.detail}
            </Text>
          </div>
        </div>
      ))}
    </div>
  )
}
