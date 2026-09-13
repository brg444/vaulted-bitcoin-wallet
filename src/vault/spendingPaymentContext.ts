import { createContext, useContext } from 'react'
import type { SpendingPayments } from '../lib/vault/spendingPayments'

interface SpendingPaymentCommands {
  openPendingPayment: (operationId: string) => Promise<void>
  replaceInFlightSend: () => Promise<void>
  retryLightningRefund: (rfqId: string) => Promise<void>
}
export function spendingPaymentView(
  snapshot: ReturnType<SpendingPayments['getSnapshot']>,
  commands: SpendingPaymentCommands,
) {
  return {
    pendingPayments: snapshot.pendingPayments,
    resumingPayment: snapshot.review?.resuming || false,
    canReplaceInFlightSend: snapshot.canReplace,
    ...commands,
  }
}
export type SpendingPaymentContextProps = ReturnType<typeof spendingPaymentView>
export const SpendingPaymentContext = createContext<SpendingPaymentContextProps | null>(null)
export function useSpendingPayment() {
  const payment = useContext(SpendingPaymentContext)
  if (!payment) throw new Error('Spending payment provider required')
  return payment
}
