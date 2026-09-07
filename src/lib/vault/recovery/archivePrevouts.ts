import { ChainTxType, Transaction } from '@arkade-os/sdk'
import { RawTx } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { fetchTxHex } from '../esplora'
import { validateExitArchive, type ExitArchive, type ExitArchiveBinding } from './exitArchive'

export type RecoveryCommitmentReader = (txid: string) => Promise<string>

/** Pure metadata hydration; transaction IDs and signatures remain unchanged. */
export function hydrateArchivedPrevouts(tx: Transaction, transactions: Record<string, string>) {
  let changed = false
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    const parentId = hex.encode(input.txid!)
    const parentPsbt = transactions[parentId]
    if (!parentPsbt) {
      if (!input.witnessUtxo && !input.nonWitnessUtxo) throw new Error('Recovery parent output is missing')
      continue
    }
    const parent = Transaction.fromPSBT(base64.decode(parentPsbt))
    if (parent.id !== parentId || input.index === undefined || input.index >= parent.outputsLength)
      throw new Error('Recovery parent output changed')
    const previous = parent.getOutput(input.index)
    if (input.nonWitnessUtxo && Transaction.fromRaw(RawTx.encode(input.nonWitnessUtxo)).id !== parentId)
      throw new Error('Recovery parent transaction changed')
    for (const claimed of [input.witnessUtxo, input.nonWitnessUtxo?.outputs[input.index]]) {
      if (
        claimed &&
        (claimed.amount !== previous.amount || hex.encode(claimed.script) !== hex.encode(previous.script!))
      )
        throw new Error('Recovery parent output metadata changed')
    }
    if (!input.witnessUtxo && !input.nonWitnessUtxo) {
      tx.updateInput(i, { witnessUtxo: { amount: previous.amount!, script: previous.script! } })
      changed = true
    }
  }
  return changed
}

/** Fetch only a missing Bitcoin commitment named by the saved branch.
 * The returned copy includes the verified parent and can be reused offline. */
export async function prepareExitArchivePrevouts(
  archive: ExitArchive,
  binding: ExitArchiveBinding,
  readCommitment: RecoveryCommitmentReader = fetchTxHex,
): Promise<ExitArchive> {
  validateExitArchive(archive, binding)
  const result = { ...archive, transactions: { ...archive.transactions } }
  const commitments = new Set<string>()
  const needed = new Set<string>()
  for (const branch of Object.values(archive.branches)) {
    for (const node of branch) if (node.type === ChainTxType.COMMITMENT) commitments.add(node.txid)
  }
  for (const branch of Object.values(archive.branches)) {
    for (const node of branch) {
      if (node.type === ChainTxType.COMMITMENT) continue
      const tx = Transaction.fromPSBT(base64.decode(archive.transactions[node.txid]))
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i),
          parentId = hex.encode(input.txid!)
        if (!input.witnessUtxo && !input.nonWitnessUtxo && !result.transactions[parentId]) {
          if (!commitments.has(parentId)) throw new Error('Recovery parent transaction is missing')
          needed.add(parentId)
        }
      }
    }
  }
  for (const id of needed) {
    const raw = await readCommitment(id)
    if (raw.length > 2_000_000 || raw.length % 2 !== 0 || !/^[0-9a-f]+$/.test(raw))
      throw new Error('Invalid Bitcoin commitment transaction')
    const tx = Transaction.fromRaw(hex.decode(raw))
    if (tx.id !== id) throw new Error('Bitcoin commitment transaction changed')
    result.transactions[id] = base64.encode(tx.toPSBT())
  }
  for (const branch of Object.values(archive.branches)) {
    for (const node of branch) {
      if (node.type === ChainTxType.COMMITMENT) continue
      const tx = Transaction.fromPSBT(base64.decode(result.transactions[node.txid]))
      if (hydrateArchivedPrevouts(tx, result.transactions)) result.transactions[node.txid] = base64.encode(tx.toPSBT())
    }
  }
  validateExitArchive(result, binding)
  return result
}
