import { useEffect, useSyncExternalStore } from 'react'
import { bitcoinPaymentsForSession } from '../lib/vault/bitcoinPayments'
import type { VaultSession } from '../lib/vault/session'

export function useBitcoinPayments(session: Pick<VaultSession, 'getSnapshot' | 'subscribe'>) {
  const payments = bitcoinPaymentsForSession(session)
  const snapshot = useSyncExternalStore(payments.subscribe, payments.getSnapshot)
  useEffect(() => payments.retain(), [payments])
  return { payments, ...snapshot }
}
