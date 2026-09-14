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
  hasTerminalSpend,
  setArkPsbtField,
  type IContractManager,
} from '@arkade-os/sdk'
import { readLockupFate, type AssetSwapRepository, type LockupFate } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { RawWitness } from '@scure/btc-signer'
import {
  receiveProfile,
  validateReceiveRecord,
  validateReceiveSecretBinding,
  validateSavedReceiveClaim,
  type VaultLightningReceiveProfile,
} from './lightningReceive'
import { networkPins, vaultOperatorOrigin } from './networkPins'
import { withVaultLightningLifecycleLock } from './lightningLock'
import { listVaultLightningActivityRecords } from './lightningLifecycle'
import { writeRetiredLightningReceive } from './lightningEvidence'
import type { VaultHistoryItem } from './history'
import { readCommittedRecoveryEvidence, type CommittedRecoveryCoverage } from './recovery/committedCoverage'
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
  // Settled and refunded receive records stay in the repository for the
  // account lifetime. They still carry claim/lockup recovery value, so this
  // owner does not delete them until a receive-retirement contract exists.
  const records = (await repository.getAllRfqSwaps()).filter(
    (r) => r.kind === 'lightning_receive' && r.state !== 'settled' && r.state !== 'refunded',
  )
  if (!records.length) return
  const operator = input.operator ?? new RestArkProvider(pins.operatorOrigin)
  const indexer = input.indexer ?? new RestIndexerProvider(pins.operatorOrigin)
  const emulator = input.emulator ?? new RestEmulatorProvider(pins.emulatorOrigin)
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

/** Owner-side retirement predicate for a settled Lightning receive.
 *
 * Retires only when the terminal package record, the activity receipt, the
 * wallet history, the committed operation journal and every original
 * checkpoint lockup outpoint agree on the exact immutable claim. Anything
 * short of that keeps the record for resume, reload and independent recovery.
 * The receipt preserves the history facts; the archive keeps the recovery
 * bytes, including the preimage this predicate never copies. */
export async function acknowledgeVaultLightningReceiveRecovery(
  status: VaultStatus,
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'getAllRfqSwaps' | 'removeRfqSwap'>,
  rfqId: string,
  history: readonly VaultHistoryItem[],
  coverage?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<boolean> {
  return withVaultLightningLifecycleLock(status.vaultId, () =>
    acknowledgeVaultLightningReceiveRecoveryLocked(status, repository, rfqId, history, coverage, signal),
  )
}

async function acknowledgeVaultLightningReceiveRecoveryLocked(
  status: VaultStatus,
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'getAllRfqSwaps' | 'removeRfqSwap'>,
  rfqId: string,
  history: readonly VaultHistoryItem[],
  coverage: CommittedRecoveryCoverage | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  const record = await repository.getRfqSwap(rfqId)
  if (!record || record.kind !== 'lightning_receive' || record.state !== 'settled') return false
  const bound = (() => {
    try {
      const profile = validateReceiveSecretBinding(record, {
        vaultId: status.vaultId,
        network: status.network,
        phonePub: status.phoneBip340Pub!,
        spendingScript: status.spendingArkScript!,
      })
      if (!profile.claim) return null
      validateSavedReceiveClaim(
        record,
        hex.encode(ArkAddress.decode(record.lockupAddress).pkScript),
        status.spendingArkScript!,
      )
      return { profile, claim: profile.claim }
    } catch {
      return null
    }
  })()
  if (!bound) return false
  const { profile, claim } = bound
  const lockupScript = hex.encode(ArkAddress.decode(record.lockupAddress).pkScript)
  signal?.throwIfAborted()
  // The activity receipt must already be terminal on this exact claim.
  const activities = await listVaultLightningActivityRecords(repository)
  if (
    !activities.some((activity) => activity.rfqId === rfqId && activity.terminal && activity.fundingTxid === claim.txid)
  )
    return false
  // The wallet history must carry the payout as a received row.
  if (!history.some((row) => row.account === 'spend' && row.type === 'received' && row.txid === claim.txid))
    return false
  signal?.throwIfAborted()
  // Every original checkpoint lockup outpoint must be positively consumed. A
  // script-level fate query can return a subset, so the exact outpoints are
  // enumerated and checked on their own.
  const expectedOutpoints: { txid: string; vout: number }[] = []
  try {
    for (const raw of claim.checkpoints) {
      const checkpoint = Transaction.fromPSBT(base64.decode(raw))
      const input = checkpoint.getInput(0)
      const txid = input.txid?.length ? hex.encode(input.txid) : ''
      if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(input.index))
        throw new Error('Lightning receive checkpoint input is incomplete.')
      expectedOutpoints.push({ txid, vout: input.index as number })
    }
  } catch {
    return false
  }
  if (!expectedOutpoints.length) return false
  if (new Set(expectedOutpoints.map((out) => `${out.txid}:${out.vout}`)).size !== expectedOutpoints.length) return false
  // The indexer must also show the lockup claimed by our saved checkpoints,
  // with each reported spend bound to those checkpoints and to this ark tx.
  let fate: LockupFate
  try {
    const indexer = new RestIndexerProvider(vaultOperatorOrigin(status.network))
    const { vtxos } = await indexer.getVtxos({ outpoints: expectedOutpoints })
    const observed = vtxos ?? []
    if (
      !expectedOutpoints.every((out) =>
        observed.some((vtxo) => vtxo.txid === out.txid && vtxo.vout === out.vout && hasTerminalSpend(vtxo)),
      )
    )
      return false
    fate = await readLockupFate(indexer, {
      swapPkScript: ArkAddress.decode(record.lockupAddress).pkScript,
      paymentHash: (record.profile.hashlock as { paymentHash: string }).paymentHash,
    })
  } catch {
    return false
  }
  if (fate.fate !== 'claimed') return false
  let expectedCheckpoints: string[]
  try {
    expectedCheckpoints = claim.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)
  } catch {
    return false
  }
  if (!receiveClaimSpendsCoverCheckpoints(fate.spends, expectedCheckpoints, claim.txid)) return false
  signal?.throwIfAborted()
  // Re-read the committed file after the indexer work, immediately before
  // mutation. A caller-supplied snapshot cannot retire a stale archive.
  let evidence
  try {
    evidence = await readCommittedRecoveryEvidence(status)
  } catch {
    return false
  }
  const committed = evidence?.coverage
  const committedJournal = evidence?.lightningJournal ?? null
  if (!committed || !committedJournal) return false
  if (
    committed.vaultId !== status.vaultId ||
    committed.network !== status.network ||
    !committed.fileDigest ||
    committed.descriptorHash !== committedJournal.binding.descriptorHash
  )
    return false
  // A caller-supplied snapshot must match the fresh committed file exactly.
  if (
    coverage &&
    (coverage.vaultId !== committed.vaultId ||
      coverage.network !== committed.network ||
      coverage.descriptorHash !== committed.descriptorHash ||
      coverage.fileDigest !== committed.fileDigest)
  )
    return false
  // The committed file must retain the exact enrolled record, contract and claim.
  const filed = committedJournal.entries.find((entry) => entry.record.rfqId === rfqId)
  if (!filed) return false
  try {
    validateReceiveSecretBinding(filed.record, {
      vaultId: status.vaultId,
      network: status.network,
      phonePub: status.phoneBip340Pub!,
      spendingScript: status.spendingArkScript!,
    })
  } catch {
    return false
  }
  const filedProfile = filed.record.profile.vaultLightningReceive as VaultLightningReceiveProfile | undefined
  if (!filedProfile?.claim || JSON.stringify(filedProfile.claim) !== JSON.stringify(claim)) return false
  if (
    filed.record.lockupAddress !== record.lockupAddress ||
    filed.record.amount !== record.amount ||
    filed.contract.script !== lockupScript ||
    filed.contract.address !== record.lockupAddress
  )
    return false
  // The committed Spending snapshot must retain the exact claim payout.
  if (
    !committed.outputs.some(
      (coin) =>
        coin.txid === claim.txid &&
        coin.vout === 0 &&
        coin.script === status.spendingArkScript &&
        coin.value >= record.amount!,
    )
  )
    return false
  // A stale observation cannot retire a replacement or rewritten record.
  const current = await repository.getRfqSwap(rfqId)
  if (!current || JSON.stringify(current) !== JSON.stringify(record)) return false
  signal?.throwIfAborted()
  writeRetiredLightningReceive({
    rfqId,
    claimArkTxid: claim.txid,
    lockupAddress: record.lockupAddress,
    lockupPkScriptHex: lockupScript,
    amountSats: record.amount!,
    displayAmount: record.amount!,
    fee: profile.quote.from_amount - record.amount!,
    payoutAddress: profile.payoutAddress,
    payoutPkScriptHex: hex.encode(ArkAddress.decode(profile.payoutAddress).pkScript),
    state: record.state,
    createdAt: record.createdAt,
    network: status.network,
    vaultId: status.vaultId,
    descriptorHash: committed.descriptorHash,
    fileDigest: committed.fileDigest,
    retiredAt: Math.floor(Date.now() / 1000),
  })
  await repository.removeRfqSwap(rfqId)
  if (await repository.getRfqSwap(rfqId)) {
    throw new Error(`Lightning receive record ${rfqId} was not durably retired.`)
  }
  return true
}

/** Exact indexer linkage for a receive claim. Every reported lockup spend must
 * name one of our saved checkpoints, and any reported ark transaction must be
 * our claim. Mirrors the send-side checkpoint-linkage check. */
function receiveClaimSpendsCoverCheckpoints(
  spends: readonly { checkpointTxid: string; arkTxid?: string }[],
  expectedCheckpointTxids: readonly string[],
  claimArkTxid: string,
): boolean {
  if (!spends.length || !expectedCheckpointTxids.length) return false
  for (const spend of spends) {
    if (!/^[0-9a-f]{64}$/.test(spend.checkpointTxid)) return false
    if (spend.arkTxid !== undefined && !/^[0-9a-f]{64}$/.test(spend.arkTxid)) return false
  }
  const seen = new Set(spends.map((spend) => spend.checkpointTxid))
  if (seen.size !== spends.length) return false
  if (expectedCheckpointTxids.length !== spends.length) return false
  if (!expectedCheckpointTxids.every((id) => seen.has(id))) return false
  for (const spend of spends) {
    if (spend.arkTxid !== undefined && spend.arkTxid !== claimArkTxid) return false
  }
  return true
}
