import { Transaction, TxWeightEstimator, getNetwork } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { p2tr } from '@scure/btc-signer'
import { canonicalLedgerValue } from '../program/ledgerEnrollment'
import { ledgerAccountKey, ledgerBip32Versions } from '../program/ledgerNativeKeys'
import { validateLedgerRecoveryDescriptor, type LedgerRecoveryDescriptor } from '../program/ledgerRecoveryDescriptor'
import { networkPins } from '../networkPins'
import { validateSpendingRecoveryPackage, type SpendingRecoveryPackage } from './spendingRecovery'

const ANCHOR_SCRIPT = '51024e73'
const MAX_MONEY = 2_100_000_000_000_000
const MAX_FUNDING_INPUTS = 50

/** Public graph and funding prevouts. No derivation path or private material is caller selected. */
export type LedgerRecoveryFeeRole = 'hardware' | 'recovery'

export interface LedgerRecoveryFeeRequest {
  role: LedgerRecoveryFeeRole
  file: SpendingRecoveryPackage
  parentTxid: string
  feeAddress: string
  feeRate: number
  fundingCoins: { txid: string; vout: number; value: number; parentTxHex: string }[]
}

function exactHex(raw: string, label: string, maxBytes = 4_100_000): Uint8Array {
  if (typeof raw !== 'string' || !raw.length || raw.length > maxBytes * 2 || !/^(?:[0-9a-f]{2})+$/.test(raw))
    throw new Error(`${label} must be canonical hex`)
  return hex.decode(raw)
}

function feeWallet(raw: LedgerRecoveryDescriptor, role: LedgerRecoveryFeeRole) {
  const descriptor = validateLedgerRecoveryDescriptor(raw)
  const context = descriptor.ledgerSavings.context
  if ((role !== 'hardware' && role !== 'recovery') || !context[role])
    throw new Error('Ledger recovery fee role is not enrolled')
  const account = ledgerAccountKey(context[role]!, context.network)
  const branch = account.deriveChild(0)
  const child = branch.deriveChild(0)
  if (branch.index !== 0 || child.index !== 0 || !child.publicKey) throw new Error('Invalid Ledger fee derivation')
  const publicKey = hex.encode(child.publicKey)
  const network = getNetwork(networkPins(context.network).sdkNetwork)
  const payment = p2tr(child.publicKey.slice(1), undefined, network)
  return { descriptor, publicKey, feeAddress: payment.address!, payment, network }
}

/** The ordinary receive key of the enrolled recovery account funds emergency fees. */
export function ledgerRecoveryFeeWallet(
  descriptor: LedgerRecoveryDescriptor,
  role: LedgerRecoveryFeeRole = 'hardware',
) {
  const { publicKey, feeAddress } = feeWallet(descriptor, role)
  return { publicKey, feeAddress }
}

function canonicalFee(raw: LedgerRecoveryFeeRequest) {
  const request = structuredClone(raw)
  if (!request?.file) throw new Error('Complete Spending recovery package required')
  validateSpendingRecoveryPackage(request.file)
  const wallet = feeWallet(request.file.archive.kit.descriptor as LedgerRecoveryDescriptor, request.role)
  const { descriptor, feeAddress, payment, network } = wallet
  if (
    request.feeAddress !== feeAddress ||
    request.feeRate !== request.file.exitPackage.feeRate ||
    !Number.isFinite(request.feeRate) ||
    request.feeRate < 1 ||
    request.feeRate > descriptor.policy.feerateCapSatVb
  )
    throw new Error('Ledger recovery fee address or rate changed')
  if (!/^[0-9a-f]{64}$/.test(request.parentTxid)) throw new Error('Ledger recovery parent required')
  const matches = request.file.exitPackage.steps.filter(
    (step) => step.kind === 'bump' && step.parentTxid === request.parentTxid,
  )
  if (matches.length !== 1 || matches[0].kind !== 'bump')
    throw new Error('Fee parent is not a unique recovery graph step')
  const parent = Transaction.fromRaw(exactHex(matches[0].parentHex, 'Recovery parent'))
  if (parent.id !== request.parentTxid || hex.encode(parent.toBytes(true, true)) !== matches[0].parentHex)
    throw new Error('Recovery graph parent changed')
  const anchors = Array.from({ length: parent.outputsLength }, (_, index) => ({
    index,
    output: parent.getOutput(index),
  })).filter(({ output }) => output.script && hex.encode(output.script) === ANCHOR_SCRIPT)
  if (anchors.length !== 1 || anchors[0].output.amount !== 0n)
    throw new Error('Recovery parent must have one zero-value anchor')
  if (
    !Array.isArray(request.fundingCoins) ||
    !request.fundingCoins.length ||
    request.fundingCoins.length > MAX_FUNDING_INPUTS
  )
    throw new Error('Bounded Ledger recovery fee funding required')
  const child = new Transaction({ version: 3, allowLegacyWitnessUtxo: true })
  child.addInput({
    txid: parent.id,
    index: anchors[0].index,
    witnessUtxo: { amount: 0n, script: hex.decode(ANCHOR_SCRIPT) },
  })
  const estimator = TxWeightEstimator.create().addP2AInput()
  const seen = new Set<string>([`${parent.id}:${anchors[0].index}`])
  let fundingSats = 0
  for (const coin of request.fundingCoins) {
    if (
      !coin ||
      !/^[0-9a-f]{64}$/.test(coin.txid) ||
      !Number.isInteger(coin.vout) ||
      coin.vout < 0 ||
      coin.vout > 0xffffffff ||
      !Number.isSafeInteger(coin.value) ||
      coin.value <= 0 ||
      coin.value > MAX_MONEY
    )
      throw new Error('Invalid Ledger fee funding outpoint or amount')
    const id = `${coin.txid}:${coin.vout}`
    if (seen.has(id)) throw new Error('Duplicate Ledger recovery fee input')
    seen.add(id)
    const tx = Transaction.fromRaw(exactHex(coin.parentTxHex, 'Fee funding parent'))
    if (tx.id !== coin.txid || hex.encode(tx.toBytes(true, true)) !== coin.parentTxHex || coin.vout >= tx.outputsLength)
      throw new Error('Fee funding parent changed')
    const output = tx.getOutput(coin.vout)
    if (
      output.amount !== BigInt(coin.value) ||
      !output.script ||
      hex.encode(output.script) !== hex.encode(payment.script)
    )
      throw new Error('Fee funding prevout differs from the enrolled Ledger fee wallet')
    fundingSats += coin.value
    if (!Number.isSafeInteger(fundingSats) || fundingSats > MAX_MONEY)
      throw new Error('Fee funding total exceeds supported amount')
    child.addInput({
      txid: coin.txid,
      index: coin.vout,
      witnessUtxo: { amount: BigInt(coin.value), script: payment.script },
      tapInternalKey: payment.tapInternalKey,
    })
    estimator.addKeySpendInput(true)
  }
  estimator.addOutputAddress(feeAddress, network)
  const packageVsize = parent.vsize + Number(estimator.vsize().value)
  const feeSats = Math.ceil(request.feeRate * packageVsize)
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0 || feeSats > descriptor.policy.absoluteFeeCapSats)
    throw new Error('Ledger recovery package fee exceeds the absolute cap')
  const changeSats = fundingSats - feeSats
  // Match the pinned SDK's anchor-child dust floor, including its conservative 546-sat change rule.
  if (changeSats < 546) throw new Error('Ledger recovery fee change is below the SDK dust floor')
  child.addOutputAddress(feeAddress, BigInt(changeSats), network)
  const canonicalRequest: LedgerRecoveryFeeRequest = {
    role: request.role,
    file: request.file,
    parentTxid: request.parentTxid,
    feeAddress,
    feeRate: request.feeRate,
    fundingCoins: request.fundingCoins.map((coin) => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      parentTxHex: coin.parentTxHex,
    })),
  }
  if (canonicalLedgerValue(request) !== canonicalLedgerValue(canonicalRequest))
    throw new Error('Unsupported Ledger recovery fee fields')
  return { ...wallet, role: request.role, child, feeSats, packageVsize, fundingSats, changeSats }
}

export function inspectLedgerRecoveryFee(request: LedgerRecoveryFeeRequest) {
  const { child, publicKey, feeAddress, feeSats, packageVsize, fundingSats, changeSats } = canonicalFee(request)
  return {
    unsignedPsbt: hex.encode(child.toPSBT()),
    publicKey,
    feeAddress,
    feeSats,
    packageVsize,
    fundingSats,
    changeSats,
  }
}

/** Signs only validated enrolled account /0/0 fee inputs. The supplied seed remains caller-owned. */
export function signLedgerRecoveryFeeWithSeed(
  request: LedgerRecoveryFeeRequest,
  seed: Uint8Array,
  psbt: string,
): string {
  const plan = canonicalFee(request)
  const supplied = Transaction.fromPSBT(exactHex(psbt, 'Ledger recovery fee PSBT'), { allowLegacyWitnessUtxo: true })
  if (hex.encode(supplied.toPSBT()) !== hex.encode(plan.child.toPSBT()))
    throw new Error('Ledger recovery fee transaction or signing metadata changed')
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Ledger fee recovery requires the 64-byte BIP39 seed')
  const copy = Uint8Array.from(seed)
  const nodes: HDKey[] = []
  try {
    const context = plan.descriptor.ledgerSavings.context,
      origin = context[plan.role]!
    let key = HDKey.fromMasterSeed(copy, ledgerBip32Versions(context.network))
    nodes.push(key)
    if (key.fingerprint.toString(16).padStart(8, '0') !== origin.fingerprint)
      throw new Error('Ledger seed or passphrase differs from the enrolled recovery account')
    for (const index of origin.path) {
      key = key.deriveChild(index)
      nodes.push(key)
      if (key.index !== index) throw new Error('Invalid Ledger fee account derivation')
    }
    if (key.publicExtendedKey !== origin.xpub)
      throw new Error('Ledger seed or passphrase differs from the enrolled recovery account')
    for (const index of [0, 0]) {
      key = key.deriveChild(index)
      nodes.push(key)
      if (key.index !== index) throw new Error('Invalid Ledger fee receive derivation')
    }
    if (!key.privateKey || !key.publicKey || hex.encode(key.publicKey) !== plan.publicKey)
      throw new Error('Ledger recovery fee key differs from enrollment')
    const scripts = Array.from(
      { length: plan.child.inputsLength },
      (_, i) => plan.child.getInput(i).witnessUtxo!.script,
    )
    const amounts = Array.from(
      { length: plan.child.inputsLength },
      (_, i) => plan.child.getInput(i).witnessUtxo!.amount,
    )
    for (let index = 1; index < plan.child.inputsLength; index++) {
      plan.child.signIdx(key.privateKey, index)
      const signature = plan.child.getInput(index).tapKeySig
      if (
        !signature ||
        signature.length !== 64 ||
        !schnorr.verify(
          signature,
          plan.child.preimageWitnessV1(index, scripts, 0, amounts),
          plan.payment.script.slice(2),
        )
      )
        throw new Error('Ledger recovery fee signature failed verification')
    }
    return hex.encode(plan.child.toPSBT())
  } finally {
    copy.fill(0)
    for (const node of nodes) node.wipePrivateData()
  }
}
