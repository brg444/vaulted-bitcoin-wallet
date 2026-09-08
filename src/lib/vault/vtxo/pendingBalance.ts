import { hasTerminalSpend } from '@arkade-os/sdk'
import type { PersistedVtxoSpend } from './spend'

type BalanceCoin = Parameters<typeof hasTerminalSpend>[0] & { txid: string; vout: number; value: number }

/** Project the same reserved outpoints and protected change onto the SDK snapshot.
 * Reserved value stays visible, but never becomes available for another payment.
 */
export function vtxoBalanceWithPending(
  coins: readonly BalanceCoin[],
  operations: readonly PersistedVtxoSpend[],
  setup?: {
    txid: string
    vout: number
    valueSats: number
    changeSats?: number
    receiverTxid?: string
    receiverVout?: number
    submitted: boolean
  } | null,
) {
  const byOutpoint = new Map(coins.map((coin) => [`${coin.txid}:${coin.vout}`, coin]))
  const observedTransactions = new Set(coins.map((coin) => coin.txid))
  const reservedOutpoints = new Set(
    operations.flatMap((operation) => (operation.reservedInputs || []).map((input) => `${input.txid}:${input.vout}`)),
  )
  const locked = new Set<string>()
  const projectedChange = new Set<string>()
  let pendingSats = 0
  for (const operation of operations) {
    if (!operation.reservedInputs?.length || operation.stage === 'pre-reserve') continue
    const outpoints = operation.reservedInputs.map((input) => `${input.txid}:${input.vout}`)
    // A corrupt overlapping journal must never inflate the displayed balance.
    if (outpoints.some((outpoint) => locked.has(outpoint))) continue
    outpoints.forEach((outpoint) => locked.add(outpoint))
    const submitted =
      ['operator-submitted', 'checkpoints-authorized', 'operator-finalized'].includes(operation.stage) ||
      observedTransactions.has(operation.arkTxid) ||
      outpoints.some((outpoint) => {
        const coin = byOutpoint.get(outpoint)
        return coin && hasTerminalSpend(coin)
      })
    if (!submitted) {
      pendingSats += operation.reservedInputs.reduce((sum, input) => sum + input.valueSats, 0)
      continue
    }
    const changeKey = `${operation.arkTxid}:${operation.changeVout}`
    // Presence includes already-spent change: neither case should be projected again.
    if (
      operation.changeSats &&
      !byOutpoint.has(changeKey) &&
      !reservedOutpoints.has(changeKey) &&
      !projectedChange.has(changeKey)
    ) {
      pendingSats += operation.changeSats
      projectedChange.add(changeKey)
    }
  }
  if (setup) {
    const inputKey = `${setup.txid}:${setup.vout}`
    const changeKey = `${setup.receiverTxid}:${setup.receiverVout}`
    const input = byOutpoint.get(inputKey)
    if (!locked.has(inputKey)) {
      locked.add(inputKey)
      const submitted = setup.submitted || byOutpoint.has(changeKey) || (input && hasTerminalSpend(input))
      if (!submitted) pendingSats += setup.valueSats
      else if (!byOutpoint.has(changeKey) && !reservedOutpoints.has(changeKey)) pendingSats += setup.changeSats || 0
    }
  }
  let availableSats = 0
  for (const [outpoint, coin] of byOutpoint) {
    if (!hasTerminalSpend(coin) && !locked.has(outpoint)) availableSats += coin.value
  }
  return { availableSats, pendingSats }
}
