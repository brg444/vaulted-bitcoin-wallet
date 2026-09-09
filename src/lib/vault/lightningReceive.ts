import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  ArkAddress,
  VHTLC,
  VHTLCV2ContractHandler,
  toXOnly,
  Transaction,
  ConditionWitness,
  getArkPsbtFields,
  type Contract,
} from '@arkade-os/sdk'
import {
  AddressMismatch,
  assertReceivable,
  createRfqSwapRecord,
  lightningReceiveRequest,
  newRfqId,
  paymentHashOf,
  receiveVtxoScript,
  registerLockupContract,
  sealClaimPacket,
  unilateralClaimDelay,
  verifyReceiveInvoice,
  type AssetSwapRepository,
  type RfqQuote,
  type RfqSwapRecord,
  type RfqTransport,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import { lightningSdkNetwork, vaultLightningReceivePlan, type VaultLightningSolverProfile } from './lightningConfig'
import { networkPins } from './networkPins'
import type { VaultStatus } from './types'

export interface VaultLightningReceiveProfile {
  version: 1
  network: 'bitcoin' | 'mutinynet'
  vaultId: string
  invoice: string
  invoiceExpiresAt: number
  quote: RfqQuote
  payoutAddress: string
  estimatedPaySats: number
  phonePub: string
  /** Kept before submission, so a lost response resumes the same claim. */
  claim?: { txid: string; arkTx: string; checkpoints: string[] }
}

const hex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0

export function receiveProfile(record: RfqSwapRecord): VaultLightningReceiveProfile {
  const p = record.profile.vaultLightningReceive as VaultLightningReceiveProfile | undefined
  if (
    record.kind !== 'lightning_receive' ||
    !p ||
    p.version !== 1 ||
    !hex32(record.rfqId) ||
    !['bitcoin', 'mutinynet'].includes(p.network) ||
    typeof p.vaultId !== 'string' ||
    !p.vaultId ||
    typeof p.invoice !== 'string' ||
    !p.invoice ||
    p.invoice.length > 12000 ||
    !whole(p.estimatedPaySats) ||
    !/^0[23][0-9a-f]{64}$/.test(p.phonePub) ||
    !whole(record.amount) ||
    !whole(p.invoiceExpiresAt) ||
    !p.quote ||
    !whole(p.quote.from_amount) ||
    !whole(p.quote.to_amount) ||
    p.quote.from_amount < p.quote.to_amount ||
    p.quote.to_amount !== record.amount ||
    !whole(p.quote.refund_locktime) ||
    typeof p.payoutAddress !== 'string' ||
    !p.payoutAddress
  ) {
    throw new Error('Invalid Lightning receive record.')
  }
  return p
}

/** Only locally reconstructed eight/nine-leaf contracts can be accepted. */
export function deriveVaultLightningReceive(input: {
  quote: RfqQuote
  paymentHash: string
  payoutAddress: string
  phonePub: string
  network: string
  claimDelay: number
}) {
  const { quote } = input
  const pins = networkPins(input.network === 'bitcoin' ? 'mainnet' : input.network)
  if (
    !/^(?:0[23])?[0-9a-f]{64}$/.test(quote.solver_pubkey) ||
    !whole(quote.refund_locktime) ||
    !hex32(input.paymentHash)
  ) {
    throw new Error('Lightning receive quote has invalid binding fields.')
  }
  const refund = quote.profile?.solver_refund_pk_script
  if (typeof refund !== 'string' || !/^[0-9a-f]{2,20000}$/.test(refund) || refund.length % 2) {
    throw new Error('Lightning receive quote has no valid solver refund script.')
  }
  const payout = ArkAddress.decode(input.payoutAddress)
  if (payout.hrp !== pins.arkHrp || hex.encode(payout.serverPubKey) !== pins.operatorSignerPub.slice(2)) {
    throw new Error('Lightning receive destination belongs to another network or Operator.')
  }
  const eight = receiveVtxoScript({
    solverPubkey: toXOnly(hex.decode(quote.solver_pubkey)),
    refundLocktime: quote.refund_locktime!,
    serverPubkey: hex.decode(pins.operatorSignerPub).slice(1),
    paymentHash: input.paymentHash,
    claimDelay: input.claimDelay,
    emulatorPubkey: hex.decode(pins.emulatorSignerPub).slice(1),
    solverRefundPkScript: hex.decode(refund),
    payoutPubkey: toXOnly(hex.decode(input.phonePub)),
    payoutPkScript: payout.pkScript,
  })
  const nine = new VHTLC.ScriptV2({
    ...eight.options,
    nonInteractiveRefund: { ...eight.options.nonInteractiveRefund!, withoutReceiver: true },
  })
  const server = hex.decode(pins.operatorSignerPub).slice(1)
  const script = [eight, nine].find(
    (candidate) => candidate.address(pins.arkHrp, server).encode() === quote.profile?.lockup_address,
  )
  if (!script)
    throw new AddressMismatch(eight.address(pins.arkHrp, server).encode(), String(quote.profile?.lockup_address))
  return script
}

export function validateReceiveRecord(
  record: RfqSwapRecord,
  contract: Contract,
  binding: {
    vaultId: string
    network: string
    phonePub: string
    spendingScript: string
  },
) {
  const p = receiveProfile(record)
  const hashlock = record.profile.hashlock as { paymentHash: string; preimageHex?: string }
  if (
    !hashlock ||
    !hex32(hashlock.preimageHex) ||
    paymentHashOf(hex.decode(hashlock.preimageHex)) !== hashlock.paymentHash ||
    p.vaultId !== binding.vaultId ||
    p.network !== lightningSdkNetwork(binding.network) ||
    p.phonePub !== binding.phonePub ||
    hex.encode(ArkAddress.decode(p.payoutAddress).pkScript) !== binding.spendingScript ||
    record.profile.payoutAddress !== p.payoutAddress ||
    record.profile.expectedAmount !== record.amount ||
    (record.profile.signer as { signingDescriptor?: string })?.signingDescriptor !== `tr(${binding.phonePub.slice(2)})`
  ) {
    throw new Error('Lightning receive recovery material does not match this wallet.')
  }
  const actualScript = VHTLCV2ContractHandler.createScript(contract.params)
  const options = actualScript.options
  const script = deriveVaultLightningReceive({
    quote: p.quote,
    paymentHash: hashlock.paymentHash,
    payoutAddress: p.payoutAddress,
    phonePub: p.phonePub,
    network: p.network,
    claimDelay: Number(options.unilateralClaimDelay.value),
  })
  const invoice = decodeVaultLightningInvoice(p.invoice, p.network, 0)
  const { payDeadline } = verifyReceiveInvoice({
    invoice: p.invoice,
    decode: () => invoice,
    paymentHash: hashlock.paymentHash,
    quote: p.quote,
  })
  if (
    !whole(p.estimatedPaySats) ||
    p.quote.rfq_id !== record.rfqId ||
    p.quote.pair !== 'lightning:BTC->arkade:BTC' ||
    hex.encode(actualScript.pkScript) !== contract.script ||
    contract.type !== 'vhtlc-v2' ||
    contract.metadata?.genericallySpendable !== false ||
    contract.script !== hex.encode(script.pkScript) ||
    record.lockupAddress !== contract.address ||
    record.lockupAddress !== p.quote.profile?.lockup_address ||
    p.quote.to_amount !== record.amount ||
    p.invoiceExpiresAt !== payDeadline ||
    hex.encode(script.pkScript) !== hex.encode(ArkAddress.decode(record.lockupAddress).pkScript)
  ) {
    throw new Error('Lightning receive contract or invoice changed.')
  }
  if (p.claim) {
    if (
      !hex32(p.claim.txid) ||
      typeof p.claim.arkTx !== 'string' ||
      !Array.isArray(p.claim.checkpoints) ||
      p.claim.checkpoints.length !== 1
    )
      throw new Error('Invalid saved Lightning claim.')
    const tx = Transaction.fromPSBT(base64.decode(p.claim.arkTx))
    const checkpoint = Transaction.fromPSBT(base64.decode(p.claim.checkpoints[0]))
    const coin = checkpoint.getInput(0).witnessUtxo
    const payout = tx.getOutput(0)
    const witness = getArkPsbtFields(tx, 0, ConditionWitness)
    if (
      tx.id !== p.claim.txid ||
      tx.inputsLength !== 1 ||
      tx.outputsLength !== 3 ||
      checkpoint.inputsLength !== 1 ||
      checkpoint.outputsLength !== 2 ||
      hex.encode(tx.getInput(0).txid!) !== checkpoint.id ||
      tx.getInput(0).index !== 0 ||
      !coin ||
      coin.amount < BigInt(record.amount!) ||
      hex.encode(coin.script) !== contract.script ||
      payout.amount !== coin.amount ||
      hex.encode(payout.script!) !== binding.spendingScript ||
      witness.length !== 1 ||
      witness[0].length !== 1 ||
      hex.encode(witness[0][0]) !== hashlock.preimageHex
    )
      throw new Error('Saved Lightning claim does not match its contract and payout.')
  }
  return script
}

/** All public invoice fields are returned only after contract and secret readback. */
export async function requestVaultLightningReceive(input: {
  status: VaultStatus
  amountSats: number
  profile: VaultLightningSolverProfile
  transport: RfqTransport
  repository: AssetSwapRepository
  contracts: SwapContractRegistry
  operatorInfo: { network: string; signerPubkey: string; unilateralExitDelay: bigint | number }
  now?: number
}): Promise<RfqSwapRecord> {
  const { status, profile, operatorInfo: info } = input
  const network = lightningSdkNetwork(status.network)
  const pins = networkPins(status.network)
  if (
    !status.enrolled ||
    !status.vaultId ||
    !status.phoneBip340Pub ||
    !status.spendingArkAddress ||
    profile.network !== network ||
    info.network !== network ||
    info.signerPubkey !== pins.operatorSignerPub ||
    hex.encode(ArkAddress.decode(status.spendingArkAddress).pkScript) !== status.spendingArkScript
  ) {
    throw new Error('Enrolled Spending address and Operator pins are required for Lightning receive.')
  }
  const plan = vaultLightningReceivePlan(input.amountSats, profile)
  const preimage = crypto.getRandomValues(new Uint8Array(32))
  const paymentHash = paymentHashOf(preimage)
  const rfqId = newRfqId()
  // Older solver deployments require a sealed packet even for foreground
  // claims. Its recipient key is discarded, so only this wallet retains P.
  const sealingSecret = secp256k1.utils.randomSecretKey()
  const sealingPub = secp256k1.getPublicKey(sealingSecret)
  sealingSecret.fill(0)
  const packet = await sealClaimPacket({ preimage, covclaimdPubkey: sealingPub })
  const request = lightningReceiveRequest({
    rfqId,
    paymentHash,
    payoutAddress: status.spendingArkAddress,
    payoutPubkey: toXOnly(hex.decode(status.phoneBip340Pub)),
    amount: input.amountSats,
    amountSide: 'to',
    claimPacket: packet.ciphertext,
  })
  const quote = await input.transport.requestQuote(request)
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (
    quote.rfq_id !== rfqId ||
    quote.pair !== 'lightning:BTC->arkade:BTC' ||
    !whole(quote.from_amount) ||
    quote.to_amount !== input.amountSats ||
    quote.from_amount < quote.to_amount
  )
    throw new Error('Lightning receive quote changed the requested amount.')
  const script = deriveVaultLightningReceive({
    quote,
    paymentHash,
    payoutAddress: status.spendingArkAddress,
    phonePub: status.phoneBip340Pub,
    network: status.network!,
    claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
  })
  const invoice = String(quote.profile?.invoice ?? '')
  const { payDeadline } = verifyReceiveInvoice({
    invoice,
    decode: (raw) => decodeVaultLightningInvoice(raw, network!, now),
    paymentHash,
    quote,
  })
  assertReceivable({ quote, payDeadline, now })
  const address = script.address(pins.arkHrp, hex.decode(pins.operatorSignerPub).slice(1)).encode()
  await registerLockupContract(input.contracts, script, address)
  const record = createRfqSwapRecord(
    {
      kind: 'lightning_receive',
      lockupAddress: address,
      amount: quote.to_amount,
      profile: {
        signer: { signingDescriptor: `tr(${status.phoneBip340Pub.slice(2)})` },
        hashlock: { paymentHash, preimageHex: hex.encode(preimage) },
        expectedAmount: quote.to_amount,
        payoutAddress: status.spendingArkAddress,
        vaultLightningReceive: {
          version: 1,
          network: pins.sdkNetwork,
          vaultId: status.vaultId,
          invoice,
          invoiceExpiresAt: payDeadline,
          quote,
          payoutAddress: status.spendingArkAddress,
          estimatedPaySats: plan.maxPaySats,
          phonePub: status.phoneBip340Pub,
        } satisfies VaultLightningReceiveProfile,
      },
    },
    {
      kind: 'lightning_receive',
      rfqId,
      state: 'pending',
      lockupPkScript: script.pkScript,
      lockup: { script, address },
      paymentHash,
      refundLocktime: quote.refund_locktime!,
      expectedAmount: quote.to_amount,
      createdAt: now,
      updatedAt: now,
    },
  )
  await input.repository.saveRfqSwap(record)
  const persisted = await input.repository.getRfqSwap(rfqId)
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(record))
    throw new Error('Lightning invoice recovery data was not durably stored.')
  return persisted
}
