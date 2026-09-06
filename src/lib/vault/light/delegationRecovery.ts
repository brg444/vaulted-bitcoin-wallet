import {
  Transaction,
  TxTree,
  validateVtxoTxGraph,
  validateConnectorsTxGraph,
  CSVMultisigTapscript,
  assertValidBatchExpiry,
  defaultBatchExpiryPolicy,
  getNetwork,
  getArkPsbtFields,
  CosignerPublicKey,
  ChainedTxType,
  type TxTreeNode,
  type ArkInfo,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { keyAggregate, sortKeys } from '@scure/btc-signer/musig2.js'
import { taprootTweakPubkey } from '@scure/btc-signer/utils.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { networkPins } from '../networkPins'
import { requireExitArchiveInfo } from '../recovery/exitArchive'
import { lightDescriptorDigest, type LightDescriptor } from './contract'
import { lightExitRepository } from './exitRepository'
import { requireDelegationRecovery, validateDelegationStatusForBinding } from './delegationClient'
import type { GuardianDelegationStatus } from './delegationStore'
import type { VaultNetwork } from '../constants'

function checkedTree(nodes: TxTreeNode[]) {
  const raw = new Map<string, { node: TxTreeNode; tx: Transaction }>()
  const descendants = new Set<string>()
  for (const node of nodes) {
    if (
      !/^[0-9a-f]{64}$/.test(node.txid) ||
      raw.has(node.txid) ||
      typeof node.tx !== 'string' ||
      node.tx.length > 1_000_000 ||
      !node.children ||
      typeof node.children !== 'object' ||
      Array.isArray(node.children)
    )
      throw new Error('Invalid replacement tree')
    const tx = Transaction.fromPSBT(base64.decode(node.tx))
    if (tx.id !== node.txid || tx.inputsLength !== 1) throw new Error('Replacement transaction changed')
    for (const [index, id] of Object.entries(node.children)) {
      if (
        !/^(0|[1-9][0-9]*)$/.test(index) ||
        Number(index) >= tx.outputsLength ||
        !/^[0-9a-f]{64}$/.test(id) ||
        descendants.has(id)
      )
        throw new Error('Invalid replacement ancestry')
      descendants.add(id)
    }
    raw.set(node.txid, { node, tx })
  }
  const roots = [...raw.keys()].filter((id) => !descendants.has(id))
  if (roots.length !== 1) throw new Error('Replacement tree must have one root')
  const visited = new Set<string>()
  const build = (id: string): TxTree => {
    const item = raw.get(id)
    if (!item || visited.has(id)) throw new Error('Replacement ancestry is incomplete or cyclic')
    visited.add(id)
    return new TxTree(
      item.tx,
      new Map(Object.entries(item.node.children).map(([vout, child]) => [Number(vout), build(child)])),
    )
  }
  const tree = build(roots[0])
  if (visited.size !== nodes.length) throw new Error('Replacement graph contains unrelated transactions')
  return { tree, raw }
}

/** Validate every signed Bitcoin path and recipient before writing the SDK repository. */
export async function importGuardianReplacement(
  descriptor: LightDescriptor,
  response: GuardianDelegationStatus,
  operatorInfo: ArkInfo,
  coin: VirtualCoin,
) {
  return importDelegationReplacementForBinding(
    {
      network: descriptor.network,
      descriptorHash: lightDescriptorDigest(descriptor),
      scriptPubKey: descriptor.scriptPubKey,
      cosignerPub: descriptor.cosignerPub,
      absoluteFeeCapSats: descriptor.spendingPolicy.absoluteFeeCapSats,
    },
    response,
    operatorInfo,
    coin,
    () => lightExitRepository(descriptor),
  )
}

/** Callers reconstruct the binding from their verified program and choose its existing SDK repository. */
export async function importDelegationReplacementForBinding(
  binding: {
    network: VaultNetwork
    descriptorHash: string
    scriptPubKey: string
    cosignerPub: string
    absoluteFeeCapSats: number
    program?: string
  },
  response: GuardianDelegationStatus,
  operatorInfo: ArkInfo,
  coin: VirtualCoin,
  repository: () => ReturnType<typeof lightExitRepository>,
) {
  const d = structuredClone(binding),
    status = validateDelegationStatusForBinding(response, d)
  const recovery = requireDelegationRecovery(status),
    info = structuredClone(operatorInfo),
    current = structuredClone(coin)
  const pins = networkPins(d.network)
  requireExitArchiveInfo(info, {
    network: d.network,
    descriptorHash: d.descriptorHash,
    scriptPubKey: d.scriptPubKey,
  })
  if (
    status.state !== 'confirmed' ||
    current.txid !== status.receiverTxid ||
    current.vout !== status.receiverVout ||
    current.script !== d.scriptPubKey ||
    current.value !== status.receiverSats ||
    !current.commitmentTxIds?.includes(status.commitmentTxid!) ||
    current.isSpent ||
    !current.expiresAt ||
    !Number.isFinite(current.expiresAt.getTime()) ||
    current.expiresAt.getTime() <= 0 ||
    (status.receiverExpiresAt !== undefined &&
      Math.floor(current.expiresAt.getTime() / 1000) !== status.receiverExpiresAt)
  )
    throw new Error('Replacement output is not independently confirmed by the indexer')
  const timelock = assertValidBatchExpiry(BigInt(recovery.batchExpiry), {
    ...defaultBatchExpiryPolicy(getNetwork(pins.sdkNetwork)),
    ...(info.vtxoTreeExpiry !== undefined ? { advertisedVtxoTreeExpiry: BigInt(info.vtxoTreeExpiry) } : {}),
  })
  const sweep = CSVMultisigTapscript.encode({
    timelock,
    pubkeys: [hex.decode(pins.checkpointForfeitPub).slice(1)],
  }).script
  const sweepRoot = tapLeafHash(sweep)
  const commitment = Transaction.fromPSBT(base64.decode(recovery.commitmentPsbt))
  if (commitment.id !== status.commitmentTxid) throw new Error('Replacement commitment changed')
  const { tree, raw } = checkedTree(recovery.vtxoTree)
  validateVtxoTxGraph(tree, commitment, sweepRoot)
  if (recovery.connectors.length)
    validateConnectorsTxGraph(recovery.commitmentPsbt, checkedTree(recovery.connectors).tree)
  const recipient = raw.get(status.receiverTxid!)
  if (!recipient || Object.keys(recipient.node.children).length || status.receiverVout! >= recipient.tx.outputsLength)
    throw new Error('Replacement recipient is not a tree leaf')
  const output = recipient.tx.getOutput(status.receiverVout!)
  if (hex.encode(output.script!) !== d.scriptPubKey || output.amount !== BigInt(status.receiverSats))
    throw new Error('Replacement recipient changed')
  const all = new Map([...raw].map(([id, v]) => [id, v.tx]))
  all.set(commitment.id, commitment)
  const path: string[] = []
  let next = status.receiverTxid!
  while (next !== commitment.id) {
    const tx = all.get(next)
    if (!tx || path.includes(next)) throw new Error('Replacement path is incomplete')
    path.push(next)
    next = hex.encode(tx.getInput(0).txid!)
  }
  path.push(commitment.id)
  path.reverse()
  for (const { tx } of raw.values()) {
    const input = tx.getInput(0)
    const parent = input.txid ? all.get(hex.encode(input.txid)) : undefined
    if (!parent || input.index === undefined || input.index >= parent.outputsLength)
      throw new Error('Replacement parent missing')
    const previous = parent.getOutput(input.index)
    const cosigners = getArkPsbtFields(tx, 0, CosignerPublicKey).map((k) => k.key)
    if (
      !cosigners.length ||
      cosigners.length > 512 ||
      new Set(cosigners.map((k) => hex.encode(k))).size !== cosigners.length ||
      (path.includes(tx.id) && !cosigners.some((k) => hex.encode(k).slice(2) === d.cosignerPub))
    )
      throw new Error('Replacement Guardian signing authority changed')
    const internal = keyAggregate(sortKeys(cosigners)).aggPublicKey.toBytes(true).slice(1)
    const [expectedKey] = taprootTweakPubkey(internal, sweepRoot)
    if (
      hex.encode(previous.script!) !== `5120${hex.encode(expectedKey)}` ||
      !input.tapKeySig ||
      input.tapKeySig.length !== 64 ||
      !schnorr.verify(input.tapKeySig, tx.preimageWitnessV1(0, [previous.script!], 0, [previous.amount!]), expectedKey)
    )
      throw new Error('Replacement tree signature or recovery delay changed')
  }
  const repo = repository()
  try {
    for (const id of path) {
      const existing = await repo.getVirtualTx(id)
      const candidate = base64.encode(all.get(id)!.toPSBT())
      if (existing?.psbt && existing.psbt !== candidate) {
        const old = Transaction.fromPSBT(base64.decode(existing.psbt))
        if (hex.encode(old.unsignedTx) !== hex.encode(all.get(id)!.unsignedTx))
          throw new Error('Stored recovery transaction conflicts')
      }
    }
    await repo.upsertVirtualTxs(
      path.map((id) => ({
        txid: id,
        psbt: base64.encode(all.get(id)!.toPSBT()),
        expiresAt: current.expiresAt!.getTime(),
        type: id === commitment.id ? ChainedTxType.Commitment : ChainedTxType.Tree,
      })),
    )
    await repo.setBranch(
      { txid: current.txid, vout: current.vout },
      path.map((id, position) => ({ vtxoTxid: current.txid, vtxoVout: current.vout, virtualTxid: id, position })),
    )
  } finally {
    await repo[Symbol.asyncDispose]()
  }
}
