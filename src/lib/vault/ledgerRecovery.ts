import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { RawOutput } from '@scure/btc-signer/script.js'
import { bitcoinDustSats } from './bitcoin'
import { verifyDirectP256 } from './ceremony/directauth'
import type { LedgerSavingsContract } from './ledgerSavings'
import { familyClaimants, type Claimant } from './program/constants'
import { taggedHash } from './program/context'
import { buildLedgerNativeFamily } from './program/ledgerNativeFamily'
import {
  ledgerAccountKey,
  ledgerGuardianClawbackBranch,
  ledgerGuardianClawbackChild,
  ledgerGuardianInitiateBranch,
  ledgerGuardianInitiateChild,
  ledgerRecoveryChild,
  ledgerSavingsChild,
  ledgerSavingsContextDigest,
  ledgerSavingsGuardianParent,
  LEDGER_RECOVERY_BRANCH,
} from './program/ledgerNativeKeys'
import { tapLeafForScript } from './program/spend'
import { requireExactDefaultTapscriptSignatures } from './taprootSignatures'

const TX_OPTS = { version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true } as const
const SEQUENCE = 0xfffffffd
const MAX_MONEY_SATS = 2_100_000_000_000_000
const PHONE_AUTHORIZATION_TAG = 'vaulted/ledger-guardian-savings-v1/phone-authorization'

export type LedgerRecoveryAction =
  | { kind: 'initiate'; claimant: Claimant; change: 0 | 1; remainingUser?: never }
  | { kind: 'clawback'; claimant: Claimant; change: 0; remainingUser: Claimant }

/** Candidate-only recovery input. The action determines the destination and keys. */
export interface LedgerRecoveryTransition {
  contract: LedgerSavingsContract
  action: LedgerRecoveryAction
  coin: { txid: string; vout: number; value: number; parentTxHex: string }
  feeSats: number
}

export interface LedgerRecoveryPhoneProof {
  digest: string
  signature: string
}

function canonicalHex(value: string, name: string, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > maxBytes * 2 || !/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error(`${name} must be canonical hex`)
  return hex.decode(value)
}

function recoveryPlan(input: LedgerRecoveryTransition) {
  const { context, spendingPolicy } = input.contract
  const family = buildLedgerNativeFamily(context, spendingPolicy)
  const { action } = input
  if (!action || !familyClaimants(Boolean(context.recovery)).includes(action.claimant))
    throw new Error('unenrolled Ledger recovery claimant')
  const recovery = family.recovery[action.claimant]!
  const guardianParent = ledgerSavingsGuardianParent(context)
  if (action.kind === 'initiate') {
    if (action.remainingUser !== undefined || (action.change !== 0 && action.change !== 1))
      throw new Error('invalid Ledger recovery initiation action')
    const source = action.change === 0 ? family.receive : family.change
    const user = action.claimant
    const userBranch = user === 'recovery' ? action.change : action.change + 2
    return {
      source,
      destination: recovery.pending,
      walletPolicy: family.walletPolicy,
      leaf: source.initiate[familyClaimants(Boolean(context.recovery)).indexOf(action.claimant)],
      user,
      userBranch,
      userKey: ledgerSavingsChild(ledgerAccountKey(context[user]!, context.network), userBranch),
      guardianParent,
      guardianBranch: ledgerGuardianInitiateBranch(context, action.claimant, action.change),
      guardianKey: ledgerGuardianInitiateChild(context, guardianParent, action.claimant, action.change),
    }
  }
  if (action.kind !== 'clawback' || action.change !== 0 || !recovery.guardians.includes(action.remainingUser))
    throw new Error('invalid Ledger recovery cancellation authority')
  return {
    source: recovery.pending,
    destination: recovery.quarantine,
    walletPolicy: recovery.pending.walletPolicy,
    leaf: recovery.pending.clawbacks[recovery.guardians.indexOf(action.remainingUser)],
    user: action.remainingUser,
    userBranch: LEDGER_RECOVERY_BRANCH.clawback,
    userKey: ledgerRecoveryChild(ledgerAccountKey(context[action.remainingUser]!, context.network), 'clawback'),
    guardianParent,
    guardianBranch: ledgerGuardianClawbackBranch(context, action.claimant, action.remainingUser),
    guardianKey: ledgerGuardianClawbackChild(context, guardianParent, action.claimant, action.remainingUser),
  }
}

function canonicalRecovery(input: LedgerRecoveryTransition) {
  const plan = recoveryPlan(input)
  const { coin, feeSats, contract } = input
  if (!/^[0-9a-f]{64}$/.test(coin.txid) || !Number.isInteger(coin.vout) || coin.vout < 0 || coin.vout > 0xffffffff)
    throw new Error('invalid Ledger recovery outpoint')
  if (!Number.isSafeInteger(coin.value) || coin.value <= 0 || coin.value > MAX_MONEY_SATS)
    throw new Error('invalid Ledger recovery coin value')
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0 || feeSats > contract.spendingPolicy.absoluteFeeCapSats)
    throw new Error('Ledger recovery fee exceeds the absolute cap')
  const amountSats = coin.value - feeSats
  if (!plan.destination.address || amountSats < bitcoinDustSats(plan.destination.address, contract.context.network))
    throw new Error('Ledger recovery destination is below dust')
  const parentBytes = canonicalHex(coin.parentTxHex, 'Ledger recovery parent', 4_000_000)
  const parent = Transaction.fromRaw(parentBytes, TX_OPTS)
  if (
    parent.id !== coin.txid ||
    coin.vout >= parent.outputsLength ||
    hex.encode(parent.toBytes(true, true)) !== coin.parentTxHex
  )
    throw new Error('Ledger recovery parent mismatch')
  const prevout = parent.getOutput(coin.vout)
  if (
    prevout.amount !== BigInt(coin.value) ||
    !prevout.script ||
    hex.encode(prevout.script) !== hex.encode(plan.source.script)
  )
    throw new Error('Ledger recovery prevout does not match enrollment and value')
  const leaf = tapLeafForScript(plan.source.tapLeafScript, plan.leaf)
  const hashes = [tapLeafHash(plan.leaf)]
  const origin = contract.context[plan.user]!
  const tx = new Transaction(TX_OPTS)
  tx.addInput({
    txid: coin.txid,
    index: coin.vout,
    sequence: SEQUENCE,
    nonWitnessUtxo: parentBytes,
    witnessUtxo: { script: plan.source.script, amount: BigInt(coin.value) },
    tapInternalKey: plan.source.tapInternalKey,
    tapLeafScript: [leaf],
    tapBip32Derivation: [
      [
        plan.userKey.publicKey!.slice(1),
        {
          hashes,
          der: { fingerprint: Number.parseInt(origin.fingerprint, 16), path: [...origin.path, plan.userBranch, 0] },
        },
      ],
      [
        plan.guardianKey.publicKey!.slice(1),
        { hashes, der: { fingerprint: plan.guardianParent.fingerprint, path: [plan.guardianBranch, 0] } },
      ],
    ],
  })
  tx.addOutput({ script: plan.destination.script, amount: BigInt(amountSats) })
  // Both signatures are exactly 64 bytes under DEFAULT. Use the committed leaf
  // and control block, so caller metadata cannot inflate the permitted fee.
  const measured = tx.clone()
  measured.updateInput(0, {
    finalScriptWitness: [new Uint8Array(64), new Uint8Array(64), plan.leaf, TaprootControlBlock.encode(leaf[0])],
  })
  const vsize = measured.vsize
  if (BigInt(feeSats) > BigInt(contract.spendingPolicy.feerateCapSatPerV) * BigInt(vsize))
    throw new Error('Ledger recovery fee exceeds the feerate cap')
  return { ...plan, tx, vsize, amountSats }
}

export function buildLedgerRecoveryPsbt(input: LedgerRecoveryTransition): string {
  return hex.encode(canonicalRecovery(input).tx.toPSBT())
}

/** Supplies the exact policy to register on a Ledger for the selected user path. */
export function inspectLedgerRecoveryTransition(input: LedgerRecoveryTransition) {
  const plan = canonicalRecovery(input)
  return {
    walletPolicy: plan.walletPolicy,
    sourceAddress: plan.source.address,
    destinationAddress: plan.destination.address!,
    amountSats: plan.amountSats,
    feeSats: input.feeSats,
    vsize: plan.vsize,
    user: plan.user,
    userBranch: plan.userBranch,
    guardianBranch: plan.guardianBranch,
  }
}

function requireSignatureSet(tx: Transaction, pubs: Uint8Array[]) {
  const input = tx.getInput(0)
  if (input.finalScriptWitness?.length || input.finalScriptSig?.length || input.partialSig?.length)
    throw new Error('Ledger recovery requires unfinalized tapscript signatures')
  for (const [key, signature] of input.tapScriptSig || []) {
    if (key.pubKey.length !== 32 || key.leafHash.length !== 32 || signature.length !== 64)
      throw new Error('Ledger recovery signatures must use DEFAULT')
  }
  requireExactDefaultTapscriptSignatures(
    tx,
    0,
    pubs.map((pub) => hex.encode(pub)),
  )
}

function importSignatures(canonical: Transaction, suppliedHex: string, pubs: Uint8Array[]) {
  const supplied = Transaction.fromPSBT(canonicalHex(suppliedHex, 'Ledger recovery approval', 4_100_000), TX_OPTS)
  if (hex.encode(canonical.unsignedTx) !== hex.encode(supplied.unsignedTx))
    throw new Error('Ledger recovery approval changed the transaction')
  requireSignatureSet(supplied, pubs)
  canonical.updateInput(0, { tapScriptSig: supplied.getInput(0).tapScriptSig })
  requireSignatureSet(canonical, pubs)
  if (hex.encode(canonical.toPSBT()) !== hex.encode(supplied.toPSBT()))
    throw new Error('Ledger recovery signing metadata changed')
  return canonical
}

/** Only the phone account may sign locally, and only for an enrolled phone action. */
export function signLedgerRecoveryWithPhone(input: LedgerRecoveryTransition, phoneAccount: HDKey): string {
  const plan = canonicalRecovery(input)
  const enrolled = ledgerAccountKey(input.contract.context.phone, input.contract.context.network)
  if (
    plan.user !== 'phone' ||
    !phoneAccount.privateKey ||
    phoneAccount.publicExtendedKey !== enrolled.publicExtendedKey
  )
    throw new Error('Ledger recovery requires the enrolled phone HD account and phone action')
  const child =
    input.action.kind === 'initiate'
      ? ledgerSavingsChild(phoneAccount, plan.userBranch)
      : ledgerRecoveryChild(phoneAccount, 'clawback')
  try {
    plan.tx.signIdx(child.privateKey!, 0)
    requireSignatureSet(plan.tx, [plan.userKey.publicKey!])
    return hex.encode(plan.tx.toPSBT())
  } finally {
    child.wipePrivateData()
  }
}

export function requireLedgerRecoveryUserApproval(input: LedgerRecoveryTransition, userPsbt: string): Transaction {
  const plan = canonicalRecovery(input)
  return importSignatures(plan.tx, userPsbt, [plan.userKey.publicKey!])
}

/** The service contributes only its signature to the retained, verified approval. */
export function acceptLedgerRecoveryGuardianSignatures(
  input: LedgerRecoveryTransition,
  userPsbt: string,
  signedPsbt: string,
): string {
  const plan = canonicalRecovery(input)
  const approved = importSignatures(plan.tx.clone(), userPsbt, [plan.userKey.publicKey!])
  const retained = approved.getInput(0).tapScriptSig![0]
  const result = importSignatures(plan.tx, signedPsbt, [plan.userKey.publicKey!, plan.guardianKey.publicKey!])
  const returned = result
    .getInput(0)
    .tapScriptSig!.find(([key]) => hex.encode(key.pubKey) === hex.encode(retained[0].pubKey))
  if (!returned || hex.encode(returned[1]) !== hex.encode(retained[1]))
    throw new Error('Guardian changed the retained Ledger recovery user signature')
  return hex.encode(result.toPSBT())
}

function u32be(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

/** Detached phone authentication commits to the original transaction and prevout. */
export function ledgerRecoveryPhoneAuthorizationDigest(input: LedgerRecoveryTransition): Uint8Array {
  return phoneAuthorizationDigest(input, canonicalRecovery(input))
}

function phoneAuthorizationDigest(
  input: LedgerRecoveryTransition,
  plan: ReturnType<typeof canonicalRecovery>,
): Uint8Array {
  if (plan.user !== 'phone') throw new Error('Phone authentication is not permitted for this recovery action')
  const utf8 = new TextEncoder()
  const fields = [
    ledgerSavingsContextDigest(input.contract.context),
    utf8.encode(input.action.kind),
    utf8.encode(input.action.claimant),
    utf8.encode(input.action.kind === 'clawback' ? input.action.remainingUser : ''),
    u32be(input.action.change),
    plan.tx.unsignedTx,
    RawOutput.encode(plan.tx.getInput(0).witnessUtxo!),
  ]
  return taggedHash(PHONE_AUTHORIZATION_TAG, ...fields.flatMap((field) => [u32be(field.length), field]))
}

export function attachLedgerRecoveryPhoneProof(
  input: LedgerRecoveryTransition,
  userPsbt: string,
  signature: string,
): { psbtHex: string; phoneAuthorization: LedgerRecoveryPhoneProof } {
  const plan = canonicalRecovery(input)
  const digest = phoneAuthorizationDigest(input, plan)
  const approved = importSignatures(plan.tx, userPsbt, [plan.userKey.publicKey!])
  const proof = canonicalHex(signature, 'Ledger recovery phone proof', 64)
  if (proof.length !== 64 || !verifyDirectP256(hex.decode(input.contract.context.phoneDirectP256), digest, proof))
    throw new Error('Ledger recovery phone authentication failed')
  return { psbtHex: hex.encode(approved.toPSBT()), phoneAuthorization: { digest: hex.encode(digest), signature } }
}
