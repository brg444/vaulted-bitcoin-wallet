import { createContext, useContext } from 'react'
import type { BitcoinPayments } from '../lib/vault/bitcoinPayments'

export function bitcoinPaymentView(snapshot: ReturnType<BitcoinPayments['getSnapshot']>, payments: BitcoinPayments) {
  return {
    operation: snapshot.operation,
    journalError: snapshot.journalError,
    outputs: snapshot.review?.outputs,
    pending: snapshot.pending,
    error: snapshot.error,
    paymentError: snapshot.paymentError,
    notice: snapshot.notice,
    check: payments.check,
    cancel: payments.cancel,
  }
}
export type BitcoinPaymentContextProps = ReturnType<typeof bitcoinPaymentView>
export const BitcoinPaymentContext = createContext<BitcoinPaymentContextProps | null>(null)
export function useBitcoinPayment() {
  const payment = useContext(BitcoinPaymentContext)
  if (!payment) throw new Error('Bitcoin payment provider required')
  return payment
}
