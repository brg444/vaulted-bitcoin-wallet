import { Transaction, type TxTree, type TxTreeNode } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import type { VtxoAuthorizeRequest } from './cosignerClient'

// The SDK constructs and validates intents, trees, MuSig sessions and forfeits.
// Vault code supplies the named cosigner boundary and durable recovery journal.
export function flattenTree(tree: TxTree): TxTreeNode[] {
  const result: TxTreeNode[] = []
  const queue = [tree]
  const seen = new Set<string>()
  while (queue.length) {
    const node = queue.pop()!
    if (seen.has(node.root.id) || result.length >= 512) throw new Error('Invalid renewal recovery graph')
    seen.add(node.root.id)
    result.push({
      txid: node.root.id,
      tx: base64.encode(node.root.toPSBT()),
      children: Object.fromEntries([...node.children].map(([index, child]) => [index, child.root.id])),
    })
    queue.push(...node.children.values())
  }
  return result
}

// Bind final evidence to the captured pre-signing PSBT and tree topology,
// attaching only the SDK's completed signature. The runtime independently
// checks the complete signed graph and its aggregate keys.
export function serializeBitcoinBatchTree(tree: TxTree, unsigned: TxTreeNode[]): TxTreeNode[] {
  const signed = flattenTree(tree)
  if (signed.length !== unsigned.length) throw new Error('Renewal tree changed while signing')
  const originals = new Map(unsigned.map((node) => [node.txid, node]))
  if (originals.size !== unsigned.length) throw new Error('Repeated renewal tree transaction')
  return signed.map((node) => {
    const original = originals.get(node.txid)
    if (!original || JSON.stringify(original.children) !== JSON.stringify(node.children))
      throw new Error('Renewal tree changed while signing')
    const tx = Transaction.fromPSBT(base64.decode(original.tx))
    const completed = Transaction.fromPSBT(base64.decode(node.tx))
    const signature = completed.getInput(0).tapKeySig
    if (tx.id !== completed.id || !signature || signature.length !== 64)
      throw new Error('Renewal tree signature is missing')
    tx.updateInput(0, { tapKeySig: signature })
    return { ...original, tx: base64.encode(tx.toPSBT()) }
  })
}

export function serializeBitcoinForfeit(raw: string): string {
  const tx = Transaction.fromPSBT(base64.decode(raw))
  if (tx.inputsLength !== 2 || (tx.getInput(0).sighashType ?? 0) !== 0)
    throw new Error('Unexpected Bitcoin forfeit signature mode')
  // btcd omits an explicit SIGHASH_DEFAULT PSBT field. Its omission retains
  // exactly the same BIP-341 digest and 64-byte owner signature.
  tx.updateInput(0, { sighashType: undefined }, true)
  return base64.encode(tx.toPSBT())
}

export interface BitcoinRegisterRequest {
  vaultId: string
  operationId: string
  psbt: string
  message: string
  assertion: Pick<VtxoAuthorizeRequest, 'credentialId' | 'clientDataJSON' | 'authenticatorData' | 'signature'>
  directSig: string
}
export interface BitcoinBatchFinalEvidence {
  batchId: string
  batchExpiry: number
  commitmentPsbt: string
  vtxoTree: TxTreeNode[]
  connectors: TxTreeNode[]
  ownerForfeitPsbt: string
}
export interface BitcoinOperationRequest {
  vaultId: string
  operationId: string
}
export interface BitcoinPaymentResponse {
  reason?: string
  state: string
  intentId?: string
  commitmentTxid?: string
  receiverTxid?: string
  receiverVout?: number
}
