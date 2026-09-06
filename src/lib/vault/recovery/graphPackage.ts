import { p2tr } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import {
  ChainTxType,
  Transaction,
  TxWeightEstimator,
  getNetwork,
  type ExitDelay,
  type ExitPackage,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { networkPins } from '../networkPins'
import { scriptHexFromAddress } from '../bitcoin'
import { validateExitArchive, type ExitArchive, type ExitArchiveBinding } from './exitArchive'

export interface RecoveryFeeLimits {
  absoluteFeeCapSats: number
  feerateCapSatVb: number
}
export interface RecoveryGraphSweep {
  tx: Transaction
  coin: Pick<VirtualCoin, 'txid' | 'vout' | 'value'>
  fee: number
  delay: ExitDelay
  path: string
}

/** Callers verify their named script's signatures before passing finalized sweeps.
 * This shared assembly includes every ancestor, even when confirmed at prepare
 * time, so a later reorg never depends on data omitted from the transport. */
export function canonicalRecoveryGraph(input: {
  archive: ExitArchive
  archiveBinding: ExitArchiveBinding
  phonePub: string
  pkg: ExitPackage
  sweeps: RecoveryGraphSweep[]
  feeLimits: RecoveryFeeLimits
}): ExitPackage {
  const { archive, archiveBinding, phonePub, pkg, sweeps, feeLimits } = input
  const { coins } = validateExitArchive(archive, archiveBinding)
  const pins = networkPins(archiveBinding.network)
  if (
    !Number.isSafeInteger(feeLimits.absoluteFeeCapSats) ||
    feeLimits.absoluteFeeCapSats < 0 ||
    !Number.isFinite(feeLimits.feerateCapSatVb) ||
    feeLimits.feerateCapSatVb < 1 ||
    !pkg ||
    pkg.version !== 1 ||
    pkg.mode !== 'graph' ||
    pkg.network !== pins.sdkNetwork ||
    !Number.isFinite(pkg.feeRate) ||
    pkg.feeRate < 1 ||
    pkg.feeRate > feeLimits.feerateCapSatVb ||
    !Number.isSafeInteger(pkg.createdAt) ||
    pkg.createdAt <= 0 ||
    sweeps.length !== coins.length ||
    !coins.length ||
    !/^(02|03)[0-9a-f]{64}$/.test(phonePub)
  )
    throw new Error('Recovery package does not cover the saved outputs')
  const destination = scriptHexFromAddress(pkg.sweepAddress, archiveBinding.network)
  const signed = new Map<string, RecoveryGraphSweep>()
  for (const item of sweeps) {
    const key = `${item.coin.txid}:${item.coin.vout}`
    const coin = coins.find((coin) => `${coin.txid}:${coin.vout}` === key)
    if (
      !coin ||
      coin.value !== item.coin.value ||
      signed.has(key) ||
      item.tx.inputsLength !== 1 ||
      item.tx.outputsLength !== 1 ||
      hex.encode(item.tx.getInput(0).txid!) !== coin.txid ||
      item.tx.getInput(0).index !== coin.vout ||
      hex.encode(item.tx.getOutput(0).script!) !== destination ||
      item.tx.getOutput(0).amount !== BigInt(coin.value - item.fee) ||
      !Number.isSafeInteger(item.fee) ||
      item.fee < 0 ||
      item.fee > feeLimits.absoluteFeeCapSats ||
      item.fee > Math.ceil(item.tx.vsize * feeLimits.feerateCapSatVb)
    )
      throw new Error('Recovery sweep transaction or fee changed')
    // Extraction requires a finalized transaction; partial signing data never
    // becomes an executable sweep through this assembly helper.
    item.tx.extract()
    signed.set(key, item)
  }
  const parents = new Map<string, { tx: Transaction; forVtxos: Set<string>; type: ChainTxType }>()
  for (const coin of coins) {
    const outpoint = `${coin.txid}:${coin.vout}`
    const chain = new Map(archive.branches[outpoint].map((node) => [node.txid, node]))
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const node = chain.get(id)!
      if (node.type === ChainTxType.COMMITMENT) return
      node.spends.forEach(visit)
      const existing = parents.get(id)
      if (existing) {
        if (existing.type !== node.type) throw new Error('Recovery ancestors disagree about transaction type')
        existing.forVtxos.add(outpoint)
        return
      }
      const tx = Transaction.fromPSBT(base64.decode(archive.transactions[id]))
      // Current SDK TREE witness completion; other nodes use its ordinary finalizer.
      if (node.type === ChainTxType.TREE) {
        const input = tx.getInput(0)
        if (!input.tapKeySig) throw new Error('Recovery tree signature missing')
        tx.updateInput(0, { finalScriptWitness: [input.tapKeySig] })
      } else tx.finalize()
      parents.set(id, { tx, forVtxos: new Set([outpoint]), type: node.type })
    }
    visit(coin.txid)
  }
  const network = getNetwork(pins.sdkNetwork)
  const feeAddress = p2tr(hex.decode(phonePub).slice(1), undefined, network).address!
  const childVsize = Number(
    TxWeightEstimator.create().addP2AInput().addKeySpendInput(true).addOutputAddress(feeAddress, network).vsize().value,
  )
  const funding = [...parents.values()].reduce(
    (sum, parent) => sum + Math.ceil(pkg.feeRate * (parent.tx.vsize + childVsize)),
    0,
  )
  if (!Number.isSafeInteger(funding)) throw new Error('Recovery fee estimate exceeds supported amount')
  const vtxos = coins.map((coin) => {
    const outpoint = `${coin.txid}:${coin.vout}`,
      item = signed.get(outpoint)!
    return { outpoint, value: coin.value, sweepFee: item.fee, path: item.path, delay: item.delay }
  })
  const steps: ExitPackage['steps'] = [...parents.values()].map(({ tx, forVtxos }) => ({
    kind: 'bump',
    parentTxid: tx.id,
    parentHex: hex.encode(tx.extract()),
    forVtxos: [...forVtxos].sort(),
  }))
  for (const vtxo of vtxos) {
    const item = signed.get(vtxo.outpoint)!
    steps.push({
      kind: 'sweep',
      vtxo: vtxo.outpoint,
      txid: item.tx.id,
      hex: hex.encode(item.tx.extract()),
      dependsOnTxid: item.coin.txid,
      delay: item.delay,
    })
  }
  // All caller-supplied steps, totals, skipped outputs and metadata are discarded.
  return {
    version: 1,
    mode: 'graph',
    network: pins.sdkNetwork,
    createdAt: pkg.createdAt,
    feeRate: pkg.feeRate,
    sweepAddress: pkg.sweepAddress,
    steps,
    vtxos,
    totals: {
      txCount: parents.size * 2 + coins.length,
      fundingRequiredSats: funding,
      totalFeeSats: funding + vtxos.reduce((sum, v) => sum + v.sweepFee, 0),
      recoveredSats: vtxos.reduce((sum, v) => sum + v.value - v.sweepFee, 0),
    },
  }
}
