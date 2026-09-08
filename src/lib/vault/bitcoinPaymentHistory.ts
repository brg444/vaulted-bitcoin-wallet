import type { VaultHistoryItem } from './history'
import { bitcoinPlanOutputs, type BitcoinPaymentJournal } from './spendingBitcoinStore'

/** The retained payment fills the gap before SDK activity observes its batch.
 * Its exact commitment replaces the same SDK row, never the original receive.
 * History is display data and never grants signing or spending authority.
 */
export function withBitcoinPaymentHistory(
  history: VaultHistoryItem[],
  operation: BitcoinPaymentJournal | null | undefined,
): VaultHistoryItem[] {
  if (!operation?.plan) return history
  const plan = operation.plan.plan
  const txid = operation.receipt?.commitmentTxid || `bitcoin:${operation.operationId}`
  const observed = history.find((row) => row.account === 'spend' && row.txid === txid && row.type === 'sent')
  const row: VaultHistoryItem = {
    ...observed,
    txid,
    type: 'sent',
    // Match normal transaction history: account outflow includes the fee.
    amount: bitcoinPlanOutputs(plan).reduce((total, output) => total + output.amountSats, 0) + plan.feeSats,
    fee: plan.feeSats,
    confirmed: operation.stage === 'confirmed',
    account: 'spend',
    activity: 'bitcoin',
    bitcoinOperationId: operation.operationId,
  }
  return [row, ...history.filter((item) => !(item.account === 'spend' && item.txid === txid))]
}
