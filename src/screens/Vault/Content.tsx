import type { ReactNode } from 'react'
import VaultRefresher from './Refresher'

interface VaultContentProps {
  children: ReactNode
  className?: string
  noFade?: boolean
  noRefresh?: boolean
  onRefresh?: () => Promise<void>
}

/** Scroll container owned by the Vault application. */
export default function VaultContent({ children, className, noFade, noRefresh, onRefresh }: VaultContentProps) {
  const classes = [noFade ? 'content no-content-fade' : 'content', className].filter(Boolean).join(' ')
  return (
    <div className={classes} tabIndex={0}>
      {noRefresh ? null : <VaultRefresher onRefresh={onRefresh} />}
      <div className='content-shell'>{children}</div>
    </div>
  )
}
