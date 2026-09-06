import {
  ArkAddress,
  DelegateManagerImpl,
  SingleKey,
  Transaction,
  Intent,
  Estimator,
  verifyTapscriptSignatures,
  type ArkInfo,
  type ContractVtxo,
  type DelegateInfo,
  type SignedIntent,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { SigHash } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { networkPins } from '../networkPins'
import { scriptHexFromAddress } from '../bitcoin'
import { requireExitArchiveInfo } from '../recovery/exitArchive'
import type { VaultStatus } from '../types'
import { spendingScriptFromStatus } from './spend'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'

export interface SpendingDelegateInfo extends DelegateInfo {
  version: 1
  enabled: true
  maxInputs: 1
  maxPlans: 50
  program: string
  descriptorHash: string
  maxScheduleSeconds: number
}
export interface SpendingScheduleRequest {
  program: string
  descriptorHash: string
  vaultId: string
  operationId: string
  intent: { proof: string; message: string }
  forfeitTxs: string[]
  deleteIntent: { proof: string; message: string }
  expiresAt: number
  ownerSignature: string
}
export interface SpendingDelegationPlan {
  request: SpendingScheduleRequest
  txid: string
  vout: number
  valueSats: number
  receiverSats: number
  validAt: number
  inputExpiresAt: number
}
export const canonicalHex = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)
export function spendingDelegationDigest(purpose: 'schedule' | 'status' | 'cancel' | 'list', value: unknown) {
  return sha256(new TextEncoder().encode(`vaulted-vtxo/delegate-${purpose}/v1:${JSON.stringify(value)}`))
}
export function spendingDelegationAddress(status: VaultStatus) {
  const d = guardianRenewalContext(status)
  return new ArkAddress(
    hex.decode(d.operatorPub),
    spendingScriptFromStatus(status).tweakedPublicKey,
    networkPins(d.network).arkHrp,
  ).encode()
}
export function validateSpendingDelegateInfo(value: unknown, descriptor: VaultStatus): SpendingDelegateInfo {
  const d = guardianRenewalContext(descriptor),
    v = value as SpendingDelegateInfo
  if (
    !v ||
    v.enabled !== true ||
    v.version !== 1 ||
    v.maxInputs !== 1 ||
    v.maxPlans !== 50 ||
    v.program !== d.program ||
    v.descriptorHash !== guardianRenewalContextDigest(descriptor) ||
    !canonicalHex(v.pubkey, 33) ||
    !['02', '03'].includes(v.pubkey.slice(0, 2)) ||
    v.pubkey.slice(2) !== d.cosignerPub ||
    v.fee !== '0' ||
    v.delegateAddress !== spendingDelegationAddress(descriptor) ||
    !Number.isSafeInteger(v.maxScheduleSeconds) ||
    v.maxScheduleSeconds < 120 ||
    v.maxScheduleSeconds > 30 * 86400
  )
    throw new Error('Guardian delegation capability does not match this wallet')
  return {
    enabled: true,
    version: 1,
    pubkey: v.pubkey,
    fee: '0',
    delegateAddress: v.delegateAddress,
    maxInputs: 1,
    maxPlans: 50,
    program: d.program,
    descriptorHash: guardianRenewalContextDigest(descriptor),
    maxScheduleSeconds: v.maxScheduleSeconds,
  }
}
export function spendingScheduleBody(r: SpendingScheduleRequest) {
  return {
    program: r.program,
    descriptorHash: r.descriptorHash,
    vaultId: r.vaultId,
    operationId: r.operationId,
    intent: { proof: r.intent.proof, message: r.intent.message },
    forfeitTxs: r.forfeitTxs,
    deleteIntent: { proof: r.deleteIntent.proof, message: r.deleteIntent.message },
    expiresAt: r.expiresAt,
  }
}
export function validateSpendingSchedule(r: SpendingScheduleRequest, descriptor: VaultStatus) {
  const d = guardianRenewalContext(descriptor)
  if (
    !r ||
    r.program !== d.program ||
    r.descriptorHash !== guardianRenewalContextDigest(descriptor) ||
    r.vaultId !== d.vaultId ||
    !canonicalHex(r.operationId, 16) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= 0 ||
    typeof r.intent?.message !== 'string' ||
    r.intent.message.length > 4096 ||
    typeof r.intent.proof !== 'string' ||
    r.intent.proof.length > 128000 ||
    !Array.isArray(r.forfeitTxs) ||
    r.forfeitTxs.length !== 1 ||
    typeof r.forfeitTxs[0] !== 'string' ||
    r.forfeitTxs[0].length > 128000 ||
    typeof r.deleteIntent?.proof !== 'string' ||
    r.deleteIntent.proof.length > 128000 ||
    typeof r.deleteIntent.message !== 'string' ||
    r.deleteIntent.message.length > 4096 ||
    !canonicalHex(r.ownerSignature, 64) ||
    !schnorr.verify(
      hex.decode(r.ownerSignature),
      spendingDelegationDigest('schedule', spendingScheduleBody(r)),
      hex.decode(d.ownerPub),
    )
  )
    throw new Error('Saved Guardian authorization changed')
  const message = JSON.parse(r.intent.message) as Intent.RegisterMessage
  const script = spendingScriptFromStatus(descriptor)
  if (
    message.type !== 'register' ||
    !Number.isSafeInteger(message.valid_at) ||
    message.valid_at <= 0 ||
    message.expire_at !== r.expiresAt ||
    message.onchain_output_indexes?.length !== 0 ||
    message.cosigners_public_keys?.length !== 1 ||
    !canonicalHex(message.cosigners_public_keys[0], 33) ||
    message.cosigners_public_keys[0].slice(2) !== d.cosignerPub ||
    r.expiresAt <= message.valid_at ||
    r.expiresAt > message.valid_at + 86400
  )
    throw new Error('Delegation schedule bounds changed')
  const proof = Transaction.fromPSBT(base64.decode(r.intent.proof)),
    forfeit = Transaction.fromPSBT(base64.decode(r.forfeitTxs[0]))
  if (
    proof.inputsLength !== 2 ||
    proof.outputsLength !== 1 ||
    forfeit.inputsLength !== 1 ||
    forfeit.outputsLength !== 2
  )
    throw new Error('Delegation must cover one output')
  const input = proof.getInput(1),
    fi = forfeit.getInput(0),
    output = proof.getOutput(0)
  if (
    !input.txid ||
    !Number.isSafeInteger(input.index) ||
    !input.witnessUtxo ||
    hex.encode(input.witnessUtxo.script) !== d.scriptPubKey ||
    hex.encode(output.script!) !== d.scriptPubKey ||
    !output.amount ||
    output.amount > input.witnessUtxo.amount ||
    input.witnessUtxo.amount - output.amount > BigInt(d.spendingPolicy.absoluteFeeCapSats) ||
    !fi.txid ||
    hex.encode(fi.txid) !== hex.encode(input.txid) ||
    fi.index !== input.index ||
    !fi.witnessUtxo ||
    fi.witnessUtxo.amount !== input.witnessUtxo.amount ||
    hex.encode(fi.witnessUtxo.script) !== d.scriptPubKey ||
    fi.sighashType !== SigHash.ALL_ANYONECANPAY ||
    forfeit.getOutput(1).amount !== 0n ||
    hex.encode(forfeit.getOutput(1).script!) !== '51024e73'
  )
    throw new Error('Delegation output or fee changed')
  const leafHash = tapLeafHash(script.forfeit()[1].slice(0, -1))
  const requireOriginalLeaf = (candidate: ReturnType<Transaction['getInput']>) => {
    const expected = script.forfeit()
    const leaves = candidate.tapLeafScript
    if (
      leaves?.length !== 1 ||
      hex.encode(leaves[0][1]) !== hex.encode(expected[1]) ||
      hex.encode(TaprootControlBlock.encode(leaves[0][0])) !== hex.encode(TaprootControlBlock.encode(expected[0]))
    )
      throw new Error('Renewal must retain the original cooperative script and recovery tree')
  }
  requireOriginalLeaf(input)
  requireOriginalLeaf(fi)
  verifyTapscriptSignatures(proof, 0, [d.ownerPub], [], [SigHash.ALL], leafHash)
  verifyTapscriptSignatures(proof, 1, [d.ownerPub], [], [SigHash.ALL], leafHash)
  verifyTapscriptSignatures(forfeit, 0, [d.ownerPub], [], [SigHash.ALL_ANYONECANPAY], leafHash)
  const deleteMessage = JSON.parse(r.deleteIntent.message) as Intent.DeleteMessage
  const deletion = Transaction.fromPSBT(base64.decode(r.deleteIntent.proof))
  if (
    deleteMessage.type !== 'delete' ||
    deleteMessage.expire_at !== 0 ||
    r.deleteIntent.message !== JSON.stringify({ type: 'delete', expire_at: 0 }) ||
    deletion.inputsLength !== 2 ||
    deletion.outputsLength !== 1 ||
    deletion.getOutput(0).amount !== 0n ||
    hex.encode(deletion.getOutput(0).script!) !== '6a'
  )
    throw new Error('Delegation cleanup authorization changed')
  const deleteInput = deletion.getInput(1)
  requireOriginalLeaf(deleteInput)
  if (
    !deleteInput.txid ||
    hex.encode(deleteInput.txid) !== hex.encode(input.txid) ||
    deleteInput.index !== input.index ||
    !deleteInput.witnessUtxo ||
    deleteInput.witnessUtxo.amount !== input.witnessUtxo.amount ||
    hex.encode(deleteInput.witnessUtxo.script) !== d.scriptPubKey
  )
    throw new Error('Delegation cleanup input changed')
  if (
    hex.encode(Intent.create(message, [unsignedIntentInput(input)], [output]).unsignedTx) !==
      hex.encode(proof.unsignedTx) ||
    hex.encode(Intent.create(deleteMessage, [unsignedIntentInput(deleteInput)], []).unsignedTx) !==
      hex.encode(deletion.unsignedTx)
  )
    throw new Error('Delegation proof message binding changed')
  verifyTapscriptSignatures(deletion, 0, [d.ownerPub], [], [SigHash.ALL], leafHash)
  verifyTapscriptSignatures(deletion, 1, [d.ownerPub], [], [SigHash.ALL], leafHash)
  return {
    message,
    proof,
    forfeit,
    deletion,
    txid: hex.encode(input.txid),
    vout: input.index!,
    valueSats: Number(input.witnessUtxo.amount),
    receiverSats: Number(output.amount),
  }
}

function unsignedIntentInput(input: ReturnType<Transaction['getInput']>) {
  return {
    txid: input.txid,
    index: input.index,
    witnessUtxo: input.witnessUtxo,
    sequence: input.sequence,
    tapLeafScript: input.tapLeafScript,
    sighashType: input.sighashType,
  }
}

/** Uses the real pinned SDK; only signed requests survive this function. */
export async function prepareSpendingDelegation(
  descriptor: VaultStatus,
  coin: VirtualCoin,
  operatorInfo: ArkInfo,
  capability: SpendingDelegateInfo,
  owner: Uint8Array,
  now = Date.now(),
  operationId = hex.encode(crypto.getRandomValues(new Uint8Array(16))),
): Promise<SpendingDelegationPlan> {
  owner = Uint8Array.from(owner)
  coin = structuredClone(coin)
  operatorInfo = structuredClone(operatorInfo)
  try {
    const d = guardianRenewalContext(descriptor),
      info = validateSpendingDelegateInfo(capability, descriptor)
    if (hex.encode(schnorr.getPublicKey(owner)) !== d.ownerPub)
      throw new Error('Delegation owner does not match wallet')
    requireExitArchiveInfo(operatorInfo, {
      network: d.network,
      scriptPubKey: d.scriptPubKey,
      descriptorHash: guardianRenewalContextDigest(descriptor),
    })
    const expiry = coin.expiresAt?.getTime()
    if (
      !canonicalHex(coin.txid, 32) ||
      !Number.isSafeInteger(coin.vout) ||
      coin.vout < 0 ||
      coin.vout > 0xffffffff ||
      !Number.isSafeInteger(coin.value) ||
      coin.value <= 0 ||
      coin.value > 21e14 ||
      coin.script !== d.scriptPubKey ||
      coin.isSpent ||
      coin.isSwept ||
      coin.isUnrolled ||
      !coin.commitmentTxIds?.length ||
      coin.commitmentTxIds.some((id) => !canonicalHex(id, 32)) ||
      !expiry ||
      !Number.isFinite(expiry) ||
      (coin.assets && coin.assets.length) ||
      expiry < now + 300000
    )
      throw new Error('This output cannot yet be delegated')
    const rateText = operatorInfo.fees?.txFeeRate
    const rate = typeof rateText === 'string' && rateText.trim() !== '' ? Number(rateText) : NaN
    if (
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > d.spendingPolicy.feerateCapSatPerV ||
      operatorInfo.dust <= 0n ||
      operatorInfo.dust > 10000n
    )
      throw new Error('Delegation fees exceed wallet limits')
    const validAt = Math.floor(
      Math.min(expiry - (expiry - now) * 0.1, now + (info.maxScheduleSeconds - 60) * 1000) / 1000,
    )
    const expiresAt = Math.floor(Math.min(expiry / 1000 - 60, validAt + 86400))
    if (validAt <= Math.floor(now / 1000) || expiresAt <= validAt)
      throw new Error('Insufficient renewal scheduling window')
    const script = spendingScriptFromStatus(descriptor)
    const annotated = {
      ...coin,
      contractScript: d.scriptPubKey,
      tapTree: script.encode(),
      forfeitTapLeafScript: script.forfeit(),
      intentTapLeafScript: script.forfeit(),
    } satisfies ContractVtxo
    let captured: { intent: SignedIntent<Intent.RegisterMessage>; forfeits: string[] } | undefined
    const manager = new DelegateManagerImpl(
      {
        getDelegateInfo: async () => info,
        delegate: async (intent, forfeits) => {
          captured = { intent, forfeits }
        },
      },
      { getInfo: async () => operatorInfo },
      SingleKey.fromPrivateKey(owner),
    )
    const result = await manager.delegate([annotated], info.delegateAddress, new Date(validAt * 1000))
    if (result.failed.length) throw result.failed[0].error
    if (!captured || result.delegated.length !== 1) throw new Error('SDK did not authorize the requested output')
    const stockProof = Transaction.fromPSBT(base64.decode(captured.intent.proof))
    if (stockProof.inputsLength !== 2 || stockProof.outputsLength !== 1)
      throw new Error('SDK delegation output shape changed')
    // Native Guardian registrations expire at the owner's dispatch deadline.
    // Rebuild and sign with public SDK primitives during this same ceremony,
    // before journaling or HTTP. The SDK's original partial forfeit is unchanged.
    const message = { ...captured.intent.message, expire_at: expiresAt }
    const bounded = await SingleKey.fromPrivateKey(owner).sign(
      Intent.create(message, [annotated], [stockProof.getOutput(0)]),
    )
    const deleteMessage: Intent.DeleteMessage = { type: 'delete', expire_at: 0 }
    const deletion = await SingleKey.fromPrivateKey(owner).sign(Intent.create(deleteMessage, [annotated], []))
    const body = {
      program: d.program,
      descriptorHash: guardianRenewalContextDigest(descriptor),
      vaultId: d.vaultId,
      operationId,
      intent: { proof: base64.encode(bounded.toPSBT()), message: JSON.stringify(message) },
      forfeitTxs: captured.forfeits,
      deleteIntent: { proof: base64.encode(deletion.toPSBT()), message: JSON.stringify(deleteMessage) },
      expiresAt,
    }
    const request = {
      ...body,
      ownerSignature: hex.encode(schnorr.sign(spendingDelegationDigest('schedule', body), owner)),
    }
    const facts = validateSpendingSchedule(request, descriptor)
    // The pinned DelegateManager omits the receiver output fee. Check its actual
    // signed result; never repair or replace owner-signed bytes after submission.
    const estimator = new Estimator(
      Object.fromEntries(
        Object.entries(operatorInfo.fees.intentFee).map(([key, expression]) => [
          key,
          expression?.replaceAll('now()', `double(${validAt})`),
        ]),
      ),
    )
    const requiredFee = estimator.evaluate(
      [{ amount: BigInt(coin.value), type: 'vtxo', weight: 0, birth: coin.createdAt, expiry: coin.expiresAt }],
      [],
      [{ amount: BigInt(facts.receiverSats), script: d.scriptPubKey }],
      [],
    ).satoshis
    if (!Number.isSafeInteger(requiredFee) || requiredFee < 0 || facts.valueSats - facts.receiverSats !== requiredFee)
      throw new Error('The SDK renewal amount does not cover the Operator fee')
    const expectedForfeit = scriptHexFromAddress(operatorInfo.forfeitAddress, d.network)
    if (
      hex.encode(facts.forfeit.getOutput(0).script!) !== expectedForfeit ||
      facts.forfeit.getOutput(0).amount !== BigInt(coin.value) + operatorInfo.dust
    )
      throw new Error('SDK forfeit destination changed')
    return {
      request,
      txid: facts.txid,
      vout: facts.vout,
      valueSats: facts.valueSats,
      receiverSats: facts.receiverSats,
      validAt,
      inputExpiresAt: Math.floor(expiry / 1000),
    }
  } finally {
    owner.fill(0)
  }
}
