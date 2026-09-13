import { createContext, useContext } from 'react'
import type { LedgerPayments } from '../lib/vault/ledgerPayments'

export function ledgerPaymentView(snapshot: ReturnType<LedgerPayments['getSnapshot']>, payments: LedgerPayments) {
  return {
    view: snapshot.view,
    pending: snapshot.pending,
    hardwarePhase: snapshot.hardwarePhase,
    error: snapshot.error,
    approveWithLedger: payments.approveWithLedger,
    cancelHardware: payments.cancelHardware,
  }
}
export type LedgerPaymentContextProps = ReturnType<typeof ledgerPaymentView>
export const LedgerPaymentContext = createContext<LedgerPaymentContextProps | null>(null)
export function useLedgerPayment() {
  const payment = useContext(LedgerPaymentContext)
  if (!payment) throw new Error('Ledger payment provider required')
  return payment
}
