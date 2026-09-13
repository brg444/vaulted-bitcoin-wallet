import { useEffect, useSyncExternalStore } from 'react'
import { ledgerPaymentsForSession } from '../lib/vault/ledgerPayments'
import type { VaultSession } from '../lib/vault/session'

export function useLedgerPayments(session: Pick<VaultSession, 'getSnapshot' | 'subscribe'>) {
  const payments = ledgerPaymentsForSession(session)
  const snapshot = useSyncExternalStore(payments.subscribe, payments.getSnapshot)
  useEffect(() => payments.retain(), [payments])
  return { payments, ...snapshot }
}
