import { CSVMultisigTapscript, CosignerPublicKey, Transaction, type TxTreeNode, type VirtualCoin } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { p2tr } from '@scure/btc-signer'
import { keyAggregate, nonceAggregate, nonceGen, Session, sortKeys } from '@scure/btc-signer/musig2.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { tapTweak, taprootTweakPubkey } from '@scure/btc-signer/utils.js'
import { numberToBytesBE } from '@noble/curves/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { scalarSecret } from '../../program/fixtures'
import { networkPins } from '../../networkPins'
import { ledgerRecoveryFacts } from '../../recovery/testdata/helpers'
import { sharedSpendingStatusForNetwork } from './sharedSpending'
import { renewalFixture } from './renewal'
import { guardianRenewalContextDigest } from '../renewalContext'
import type { SpendingRenewalStatus } from '../renewalStatus'

export const nativeRenewalAccounts = (['mainnet', 'mutinynet'] as const).flatMap((network) =>
  (['light', 'standard', 'advanced'] as const).map((tier) => ({ network, tier })),
)

// Synthetic native Batch Output paths signed by two known test scalars through
// MuSig2. These are failure-test inputs, not funded evidence or signing goldens.
export function nativeRenewalFixture({ network, tier } = nativeRenewalAccounts[0], pruned = false) {
  const status =
    tier === 'light'
      ? sharedSpendingStatusForNetwork(network, { phoneSecret: scalarSecret(3), cosignerSecret: scalarSecret(18) })
      : ledgerRecoveryFacts(tier === 'advanced', network).status
  const pins = networkPins(network)
  const batchExpiry = 604672
  const sweepRoot = tapLeafHash(
    CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: BigInt(batchExpiry) },
      pubkeys: [hex.decode(pins.checkpointForfeitPub.slice(2))],
    }).script,
  )
  const keys = sortKeys([18, 23].map((n) => secp256k1.getPublicKey(scalarSecret(n), true)))
  const secrets = keys.map(
    (key) =>
      [18, 23]
        .map(scalarSecret)
        .find((secret) => hex.encode(secp256k1.getPublicKey(secret, true)) === hex.encode(key))!,
  )
  const internal = keyAggregate(keys).aggPublicKey.toBytes(true).slice(1)
  const tweak = numberToBytesBE(tapTweak(internal, sweepRoot), 32)
  const [aggregate] = taprootTweakPubkey(internal, sweepRoot)
  const sharedScript = hex.decode(`5120${hex.encode(aggregate)}`)
  const commitment = new Transaction({ version: 2 })
  commitment.addInput({ txid: '01'.repeat(32), index: 0 })
  commitment.addOutput({ script: sharedScript, amount: 20000n })
  function child(parent: Transaction, index: number, outputs: { script: Uint8Array; amount: bigint }[]) {
    const tx = new Transaction({ version: 3 })
    tx.addInput({ txid: parent.id, index })
    tx.updateInput(0, { unknown: keys.map((key, index) => CosignerPublicKey.encode({ key, index })) })
    outputs.forEach((output) => tx.addOutput(output))
    tx.addOutput({ script: hex.decode('51024e73'), amount: 0n })
    const previous = parent.getOutput(index)
    const message = tx.preimageWitnessV1(0, [previous.script!], 0, [previous.amount!])
    const nonces = keys.map((key, i) =>
      nonceGen(key, secrets[i], aggregate, message, undefined, new Uint8Array(32).fill(i + 1)),
    )
    const session = new Session(nonceAggregate(nonces.map((n) => n.public)), keys, message, [tweak], [true])
    const shares = nonces.map((nonce, i) => session.sign(nonce.secret, secrets[i]))
    shares.forEach((share, i) => {
      if (
        !session.partialSigVerify(
          share,
          nonces.map((n) => n.public),
          i,
        )
      )
        throw new Error('Invalid fixture share')
    })
    const signature = session.partialSigAgg(shares)
    if (!schnorr.verify(signature, message, aggregate)) throw new Error('Invalid fixture signature')
    tx.updateInput(0, { tapKeySig: signature })
    return tx
  }
  const root = child(commitment, 0, [
    { script: sharedScript, amount: 10000n },
    { script: sharedScript, amount: 10000n },
  ])
  const leaf = child(root, 0, [{ script: hex.decode(status.spendingArkScript!), amount: 10000n }])
  const sibling = child(root, 1, [{ script: p2tr(schnorr.getPublicKey(scalarSecret(24))).script, amount: 10000n }])
  const nodes: TxTreeNode[] = [
    { txid: leaf.id, tx: base64.encode(leaf.toPSBT()), children: {} },
    { txid: root.id, tx: base64.encode(root.toPSBT()), children: { 0: leaf.id, 1: sibling.id } },
    ...(pruned ? [] : [{ txid: sibling.id, tx: base64.encode(sibling.toPSBT()), children: {} }]),
  ]
  const now = 1788708334
  const coin: VirtualCoin = {
    ...renewalFixture(status, now * 1000).coin,
    txid: leaf.id,
    vout: 0,
    commitmentTxIds: [commitment.id],
  }
  const result: SpendingRenewalStatus = {
    version: 1,
    program: status.spendingPolicy!.program,
    operationId: '12'.repeat(16),
    descriptorHash: guardianRenewalContextDigest(status),
    state: 'confirmed',
    validAt: now,
    expiresAt: now + 82800,
    txid: '11'.repeat(32),
    vout: 0,
    inputValueSats: 10000,
    receiverSats: 10000,
    commitmentTxid: commitment.id,
    receiverTxid: leaf.id,
    receiverVout: 0,
    receiverExpiresAt: Math.floor(coin.expiresAt!.getTime() / 1000),
    recovery: {
      batchId: 'native-renewal-test',
      batchExpiry,
      commitmentPsbt: base64.encode(commitment.toPSBT()),
      vtxoTree: nodes,
      connectors: [],
    },
  }
  const info = { ...renewalFixture(status).info, vtxoTreeExpiry: BigInt(batchExpiry) }
  return { status, result, info, coin, commitment, root, leaf, sibling }
}
