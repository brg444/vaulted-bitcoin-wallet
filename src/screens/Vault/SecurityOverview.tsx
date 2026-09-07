import { ChevronRight, FileKey, Fingerprint, RotateCw, Shield, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './SecurityOverview.module.css'

export type SecurityOverviewItem = {
  value: string
  attention?: boolean
  onClick: () => void
  testId?: string
}

export default function SecurityOverview({
  title,
  description,
  notice,
  attention = false,
  access,
  backup,
  limits,
  renewal,
  children,
}: {
  title: string
  description: string
  notice: string
  attention?: boolean
  access: SecurityOverviewItem
  backup: SecurityOverviewItem
  limits: SecurityOverviewItem
  renewal: SecurityOverviewItem
  children?: ReactNode
}) {
  const tiles = [
    { label: 'Keys and access', icon: Fingerprint, ...access },
    { label: 'Backups', icon: FileKey, ...backup },
    { label: 'Spending limits', icon: ShieldCheck, ...limits },
    { label: 'Renewal', icon: RotateCw, ...renewal },
  ]
  return (
    <div className={styles.overview} data-testid='security-overview'>
      <section className={styles.hero} aria-label='Vault status'>
        <Shield className={styles.emblem} strokeWidth={1.5} aria-hidden='true' />
        <div className={styles.identity}>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <p className={`${styles.notice} ${attention ? styles.attention : ''}`}>
          <span aria-hidden='true' />
          {notice}
        </p>
      </section>
      <div className={styles.grid} data-testid='security-grid'>
        {tiles.map(({ label, icon: Icon, value, attention, onClick, testId }) => (
          <button key={label} className={styles.tile} type='button' onClick={onClick} data-testid={testId}>
            <span className={styles.tileHead} aria-hidden='true'>
              <Icon size={24} strokeWidth={1.5} />
              <ChevronRight size={16} />
            </span>
            <span className={styles.tileCopy}>
              <strong>{label}</strong>
              <span className={attention ? styles.attention : undefined}>{value}</span>
            </span>
          </button>
        ))}
      </div>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </div>
  )
}
