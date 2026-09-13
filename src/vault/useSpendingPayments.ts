import { useEffect, useSyncExternalStore } from 'react'
import { spendingPaymentsForSession } from '../lib/vault/spendingPayments'
import type { VaultSession } from '../lib/vault/session'

export function useSpendingPayments(session: Pick<VaultSession, 'getSnapshot' | 'subscribe'>) {
  const payments = spendingPaymentsForSession(session)
  const snapshot = useSyncExternalStore(payments.subscribe, payments.getSnapshot)
  useEffect(() => payments.retain(), [payments])
  return { payments, ...snapshot }
}
