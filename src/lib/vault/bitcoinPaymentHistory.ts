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
  if (!operation) return history
  const plan = operation.plan?.plan
  const outputs = plan ? bitcoinPlanOutputs(plan) : operation.outputs
  if (!outputs?.length) return history
  const txid = operation.receipt?.commitmentTxid || `bitcoin:${operation.operationId}`
  const observed = history.find((row) => row.account === 'spend' && row.txid === txid && row.type === 'sent')
  const row: VaultHistoryItem = {
    ...observed,
    txid,
    type: 'sent',
    // Match normal transaction history: account outflow includes the fee.
    amount: outputs.reduce((total, output) => total + output.amountSats, 0) + (plan?.feeSats || 0),
    fee: plan?.feeSats,
    bitcoinStage: operation.stage,
    confirmed: operation.stage === 'confirmed',
    account: 'spend',
    activity: 'bitcoin',
    bitcoinOperationId: operation.operationId,
  }
  return [row, ...history.filter((item) => !(item.account === 'spend' && item.txid === txid))]
}
