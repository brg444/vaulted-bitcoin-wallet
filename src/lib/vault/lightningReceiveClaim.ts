import {
  ArkAddress,
  ConditionWitness,
  CSVMultisigTapscript,
  EmulatorPacket,
  Extension,
  Transaction,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  PrevArkTxField,
  buildOffchainTx,
  canSpendOffchain,
  setArkPsbtField,
  type IContractManager,
} from '@arkade-os/sdk'
import type { AssetSwapRepository } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { RawWitness } from '@scure/btc-signer'
import { receiveProfile, validateReceiveRecord } from './lightningReceive'
import { networkPins } from './networkPins'
import type { VaultStatus } from './types'

/** No phone key: only the Emulator leaf that commits the full value to Spending. */
export async function reconcileVaultLightningReceives(input: {
  status: VaultStatus
  repository: AssetSwapRepository
  contracts: IContractManager
  operator?: RestArkProvider
  indexer?: RestIndexerProvider
  emulator?: RestEmulatorProvider
}) {
  const { status, repository, contracts } = input
  const pins = networkPins(status.network)
  const records = (await repository.getAllRfqSwaps()).filter(
    (r) => r.kind === 'lightning_receive' && r.state !== 'settled' && r.state !== 'refunded',
  )
  if (!records.length) return
  const operator = input.operator ?? new RestArkProvider(pins.operatorOrigin)
  const indexer = input.indexer ?? new RestIndexerProvider(pins.operatorOrigin)
  if (!status.arkadeCosignerOrigin) throw new Error('Lightning receive requires the enrolled Emulator endpoint.')
  const emulator = input.emulator ?? new RestEmulatorProvider(status.arkadeCosignerOrigin)
  const [info, emulatorInfo] = await Promise.all([operator.getInfo(), emulator.getInfo()])
  if (
    info.network !== pins.sdkNetwork ||
    info.signerPubkey !== pins.operatorSignerPub ||
    emulatorInfo.signerPubkey !== pins.emulatorSignerPub ||
    info.checkpointTapscript !== pins.checkpointTapscript
  )
    throw new Error('Lightning claim service pins do not match this wallet.')
  for (const record of records) {
    const p = receiveProfile(record)
    const registered = (
      await contracts.getContracts({ script: hex.encode(ArkAddress.decode(record.lockupAddress).pkScript) })
    )[0]
    if (!registered) throw new Error('Lightning receive contract is missing.')
    const script = validateReceiveRecord(record, registered, {
      vaultId: status.vaultId,
      network: status.network,
      phonePub: status.phoneBip340Pub!,
      spendingScript: status.spendingArkScript!,
    })
    const { vtxos } = await indexer.getVtxos({ scripts: [registered.script] })
    if (p.claim) {
      // Only positive evidence from our exact payout can complete a receive.
      const paid = await indexer.getVtxos({ scripts: [status.spendingArkScript!] })
      if (paid.vtxos.some((v) => v.txid === p.claim!.txid && v.vout === 0 && v.value >= record.amount!)) {
        record.state = 'settled'
        record.profile.claimArkTxid = p.claim.txid
        record.updatedAt = Math.floor(Date.now() / 1000)
        await repository.saveRfqSwap(record)
        continue
      }
    }
    // The preimage buys one outpoint. Several small outputs cannot satisfy it.
    const live = vtxos.filter((v) => canSpendOffchain(v, { timestamp: new Date() }) && v.value >= record.amount!)
    if (live.length !== 1 || Math.floor(Date.now() / 1000) >= p.quote.refund_locktime!) continue
    const coin = live[0]
    const [leaf, arkadeScript] = script.nonInteractiveClaim()
    const packet = EmulatorPacket.create([{ vin: 0, script: arkadeScript, witness: RawWitness.encode([]) }])
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: leaf, tapTree: script.encode() }],
      [
        { script: ArkAddress.decode(p.payoutAddress).pkScript, amount: BigInt(coin.value) },
        Extension.create([packet]).txOut(),
      ],
      CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
    )
    const { txs } = await indexer.getVirtualTxs([coin.txid])
    if (txs.length !== 1) throw new Error('Lightning funding transaction is unavailable.')
    const parent = Transaction.fromPSBT(base64.decode(txs[0]))
    const prevout = parent.getOutput(coin.vout)
    if (
      parent.id !== coin.txid ||
      prevout.amount !== BigInt(coin.value) ||
      hex.encode(prevout.script!) !== registered.script
    ) {
      throw new Error('Lightning funding outpoint does not match the indexed value and contract.')
    }
    setArkPsbtField(arkTx, 0, PrevArkTxField, parent.toBytes(true, false))
    const preimage = hex.decode((record.profile.hashlock as { preimageHex: string }).preimageHex)
    setArkPsbtField(arkTx, 0, ConditionWitness, [preimage])
    setArkPsbtField(checkpoints[0], 0, ConditionWitness, [preimage])
    const claim = {
      txid: arkTx.id,
      arkTx: base64.encode(arkTx.toPSBT()),
      checkpoints: checkpoints.map((c) => base64.encode(c.toPSBT())),
    }
    if (p.claim && p.claim.txid !== claim.txid)
      throw new Error('A pending Lightning claim must be reconciled before another claim is built.')
    p.claim = claim
    record.updatedAt = Math.floor(Date.now() / 1000)
    await repository.saveRfqSwap(record)
    const saved = await repository.getRfqSwap(record.rfqId)
    if (!saved || JSON.stringify(receiveProfile(saved).claim) !== JSON.stringify(claim))
      throw new Error('Lightning claim could not be durably stored.')
    // P first leaves this browser here. A rejected/lost response retains the exact
    // transaction. The next pass checks its payout before retrying that same txid.
    const result = await emulator.submitTx(claim.arkTx, claim.checkpoints)
    if (Transaction.fromPSBT(base64.decode(result.signedArkTx)).id !== claim.txid) {
      throw new Error('Emulator returned a different Lightning claim transaction.')
    }
    // Submission is not settlement. Keep pending until the payout is indexed.
  }
}
