import { recoveryChainResolver } from './pagedIndexer'
import {
  ChainTxType,
  ChainedTxType,
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  type ChainTx,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { vaultArkServer, type PersistedVtxoSpend } from '../vtxo/spend'
import type { VaultStatus } from '../types'
import { LIGHT_PROFILE, lightDescriptorDigest } from '../light/contract'
import { requireLightStatus } from '../light/status'
import { lightExitRepository } from '../light/exitRepository'
import { vaultExitRepository } from '../vtxo/exitRepository'
import { normalizeRecoveryChain, packExitArchive, validateExitArchive, type ExitArchive } from './exitArchive'
import { recoveryFileStore } from './fileStore'

/** Persist the already-validated signed successor and ancestors before the
 * wallet releases finalization. Never signs, submits, or changes payment state. */
export async function retainFinalizationRecovery(status: VaultStatus, pending: PersistedVtxoSpend) {
  if (!pending.operatorArkPsbt || !pending.checkpointPsbts?.length || !pending.reservedInputs?.length)
    throw new Error('Signed recovery evidence is unavailable before finalization')
  const light = status.templateVersion === LIGHT_PROFILE ? requireLightStatus(status).lightDescriptor! : undefined
  const repository = light ? lightExitRepository(light) : vaultExitRepository(status.vaultId, status.network)
  const script = light?.scriptPubKey ?? String(status.spendingArkScript)
  const binding = {
    network: status.network,
    scriptPubKey: script,
    descriptorHash: light ? lightDescriptorDigest(light) : status.vaultId,
  }
  try {
    const indexer = new RestIndexerProvider(vaultArkServer(status.network))
    const resolver = recoveryChainResolver(indexer, repository)
    const info = await new RestArkProvider(vaultArkServer(status.network)).getInfo()
    const nodes = new Map<string, ChainTx>()
    const inputBranches: Record<string, ChainTx[]> = {}
    for (const input of pending.reservedInputs) {
      const chain = normalizeRecoveryChain(await resolver.getVtxoChain(input))
      inputBranches[`${input.txid}:${input.vout}`] = chain
      for (const node of chain) {
        const prior = nodes.get(node.txid)
        if (prior && JSON.stringify(prior) !== JSON.stringify(node)) throw new Error('Recovery ancestors disagree')
        nodes.set(node.txid, node)
      }
    }
    if (nodes.size > 4096) throw new Error('Recovery transaction limit exceeded')
    const transactions: Record<string, string> = {}
    const ids = [...nodes.values()].filter((node) => node.type !== ChainTxType.COMMITMENT).map((node) => node.txid)
    for (let i = 0; i < ids.length; i += 100)
      for (const raw of await resolver.getVirtualTxs(ids.slice(i, i + 100)))
        transactions[Transaction.fromPSBT(base64.decode(raw)).id] = raw
    // Validate ancestors even for a payment without a self-owned successor.
    validateExitArchive(
      {
        version: 1,
        descriptorHash: binding.descriptorHash,
        capturedAt: new Date().toISOString(),
        info: packExitArchive(info),
        coins: packExitArchive(
          pending.reservedInputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            value: input.valueSats,
            script: input.scriptHex,
            isSpent: false,
            createdAt: new Date(),
          })),
        ),
        branches: inputBranches,
        transactions,
      },
      binding,
    )
    const ark = Transaction.fromPSBT(base64.decode(pending.operatorArkPsbt))
    if (ark.id !== pending.arkTxid) throw new Error('Finalization recovery transaction changed')
    for (const raw of [...pending.checkpointPsbts, pending.operatorArkPsbt]) {
      const tx = Transaction.fromPSBT(base64.decode(raw))
      const spends = Array.from({ length: tx.inputsLength }, (_, i) => hex.encode(tx.getInput(i).txid!))
      nodes.set(tx.id, {
        txid: tx.id,
        type: tx.id === ark.id ? ChainTxType.ARK : ChainTxType.CHECKPOINT,
        spends,
        expiresAt: '0',
      })
      transactions[tx.id] = raw
    }
    const coins = Array.from({ length: ark.outputsLength }, (_, vout) => ({ output: ark.getOutput(vout), vout }))
      .filter(({ output }) => output.script && hex.encode(output.script) === script)
      .map(({ output, vout }) => ({
        txid: ark.id,
        vout,
        value: Number(output.amount),
        script,
        isSpent: false,
        createdAt: new Date(),
        commitmentTxIds: [...nodes.values()].filter((n) => n.type === ChainTxType.COMMITMENT).map((n) => n.txid),
      }))
    // No self-owned successor means the existing operation journal carries the
    // payment result. Still retain the signed graph for any funded contract.
    const archive: ExitArchive = {
      version: 1,
      descriptorHash: binding.descriptorHash,
      capturedAt: new Date().toISOString(),
      info: packExitArchive(info),
      coins: packExitArchive(coins),
      branches: Object.fromEntries(coins.map((coin) => [`${coin.txid}:${coin.vout}`, [...nodes.values()]])),
      transactions,
    }
    validateExitArchive(archive, binding)
    await recoveryFileStore(`finalization:${status.network}:${status.vaultId}:${ark.id}`, archive)
    const types = {
      [ChainTxType.COMMITMENT]: ChainedTxType.Commitment,
      [ChainTxType.ARK]: ChainedTxType.Ark,
      [ChainTxType.TREE]: ChainedTxType.Tree,
      [ChainTxType.CHECKPOINT]: ChainedTxType.Checkpoint,
      [ChainTxType.UNSPECIFIED]: ChainedTxType.Unspecified,
    }
    await repository.upsertVirtualTxs(
      [...nodes.values()].map((n) => ({
        txid: n.txid,
        psbt: transactions[n.txid] ?? null,
        expiresAt: null,
        type: types[n.type],
      })),
    )
    for (const coin of coins)
      await repository.setBranch(
        coin,
        [...nodes.values()].map((n, position) => ({
          vtxoTxid: coin.txid,
          vtxoVout: coin.vout,
          virtualTxid: n.txid,
          position,
        })),
      )
  } finally {
    await repository[Symbol.asyncDispose]()
  }
}
