import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import {
  buildNativeSavingsPsbt,
  requireSavingsAdminLeaf,
  requireSameNativeSavingsIntent,
  type SavingsCoin,
} from './savingsSpend'
import { buildLedgerNativeSavings } from './program/ledgerNativePolicy'
import { ledgerAccountKey, ledgerSavingsChild, type LedgerSavingsKeyContext } from './program/ledgerNativeKeys'
import type { Claimant } from './program/constants'
import { requireExactDefaultTapscriptSignatures } from './taprootSignatures'

const TX_OPTS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const

// Supplied by canonical recovery-family reconstruction, never directly from a quote.
// This candidate is deliberately not accepted by live enrollment or the Recovery Kit parser.
export interface LedgerSavingsContract {
  context: LedgerSavingsKeyContext
  programs: Partial<Record<Claimant, string>>
}
export interface LedgerSavingsCoin extends SavingsCoin {
  branch: 0 | 1
  index: 0
  parentTxHex: string
}
export interface LedgerSavingsPayment {
  contract: LedgerSavingsContract
  coins: LedgerSavingsCoin[]
  destAddress: string
  amountSats: number
  feeSats: number
}

function treeAt(contract: ReturnType<typeof buildLedgerNativeSavings>, branch: number, index: number) {
  if ((branch !== 0 && branch !== 1) || index !== 0) throw new Error('unenrolled Ledger Savings coordinate')
  return branch === 0 ? contract.receive : contract.change
}

function normalKey(contract: LedgerSavingsContract, role: 'phone' | 'hardware', branch: 0 | 1) {
  return ledgerSavingsChild(ledgerAccountKey(contract.context[role], contract.context.network), branch)
}

function originFor(
  contract: LedgerSavingsContract,
  role: 'phone' | 'hardware',
  branch: 0 | 1,
  leaf: Uint8Array,
): NonNullable<Parameters<Transaction['addInput']>[0]['tapBip32Derivation']>[number] {
  const origin = contract.context[role]
  return [
    normalKey(contract, role, branch).publicKey!.slice(1),
    {
      hashes: [tapLeafHash(leaf)],
      der: { fingerprint: Number.parseInt(origin.fingerprint, 16), path: [...origin.path, branch, 0] },
    },
  ]
}

/** Verifies the actual parent and enrolled receive/change coordinate before
 * building the same native transaction used by pre-connector Savings. */
export function buildLedgerSavingsPsbt(input: LedgerSavingsPayment): string {
  const { context, programs } = input.contract
  const family = buildLedgerNativeSavings(context, programs)
  return buildNativeSavingsPsbt({
    ...input,
    network: context.network,
    changeScript: family.change.script,
    inputForCoin: (coin) => {
      const tree = treeAt(family, coin.branch, coin.index)
      const parent = Transaction.fromRaw(hex.decode(coin.parentTxHex), TX_OPTS)
      if (parent.id !== coin.txid || coin.vout >= parent.outputsLength) throw new Error('Savings parent mismatch')
      const prevout = parent.getOutput(coin.vout)
      if (
        prevout.amount !== BigInt(coin.value) ||
        !prevout.script ||
        hex.encode(prevout.script) !== hex.encode(tree.script)
      )
        throw new Error('Savings prevout does not match the enrolled address and value')
      return {
        nonWitnessUtxo: parent.toBytes(true, true),
        witnessScript: tree.script,
        tapInternalKey: tree.tapInternalKey,
        tapLeafScript: [requireSavingsAdminLeaf(tree)],
        tapBip32Derivation: [originFor(input.contract, 'hardware', coin.branch, tree.admin)],
      }
    },
    changeMetadata: {
      tapInternalKey: family.change.tapInternalKey,
      tapTree: [family.change.admin, ...family.change.initiate].map((script, i) => ({
        depth: !context.recovery && i === 2 ? 1 : 2,
        version: 0xc0,
        script,
      })),
      tapBip32Derivation: [originFor(input.contract, 'hardware', 1, family.change.admin)],
    },
  })
}

function inputCoins(input: LedgerSavingsPayment) {
  return [...input.coins].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
}

/** The phone account is a new HD account, not a legacy scalar reinterpreted as a seed. */
export function signLedgerSavingsWithPhone(input: LedgerSavingsPayment, phoneAccount: HDKey): string {
  const enrolled = ledgerAccountKey(input.contract.context.phone, input.contract.context.network)
  if (!phoneAccount.privateKey || phoneAccount.publicExtendedKey !== enrolled.publicExtendedKey)
    throw new Error('phone HD account does not match enrollment')
  const tx = Transaction.fromPSBT(hex.decode(buildLedgerSavingsPsbt(input)), TX_OPTS)
  inputCoins(input).forEach((coin, index) => {
    const child = ledgerSavingsChild(phoneAccount, coin.branch)
    try {
      tx.signIdx(child.privateKey!, index)
      requireExactDefaultTapscriptSignatures(tx, index, [hex.encode(child.publicKey!)])
    } finally {
      child.wipePrivateData()
    }
  })
  return hex.encode(tx.toPSBT())
}

/** Rebuild from the retained payment, not metadata supplied by the signing wallet.
 * The imported PSBT contributes signatures only. */
export function requireLedgerSavingsPhoneApproval(input: LedgerSavingsPayment, phonePsbt: string) {
  const canonical = Transaction.fromPSBT(hex.decode(buildLedgerSavingsPsbt(input)), TX_OPTS)
  const supplied = Transaction.fromPSBT(hex.decode(phonePsbt), TX_OPTS)
  if (hex.encode(canonical.unsignedTx) !== hex.encode(supplied.unsignedTx))
    throw new Error('phone approval changed the Savings transaction')
  inputCoins(input).forEach((coin, index) => {
    canonical.updateInput(index, { tapScriptSig: supplied.getInput(index).tapScriptSig })
    requireExactDefaultTapscriptSignatures(supplied, index, [
      hex.encode(normalKey(input.contract, 'phone', coin.branch).publicKey!),
    ])
    requireExactDefaultTapscriptSignatures(canonical, index, [
      hex.encode(normalKey(input.contract, 'phone', coin.branch).publicKey!),
    ])
  })
  if (hex.encode(canonical.toPSBT()) !== hex.encode(supplied.toPSBT()))
    throw new Error('Savings signing metadata changed')
  return canonical
}

export function acceptLedgerSavingsSignatures(
  input: LedgerSavingsPayment,
  phonePsbt: string,
  signedPsbt: string,
): string {
  const phone = requireLedgerSavingsPhoneApproval(input, phonePsbt)
  const signed = Transaction.fromPSBT(hex.decode(signedPsbt), TX_OPTS)
  const coins = inputCoins(input)
  requireSameNativeSavingsIntent(
    hex.encode(phone.toPSBT()),
    signedPsbt,
    input.destAddress,
    input.amountSats,
    input.contract.context.network,
    (index) => ({
      phonePub: hex.encode(normalKey(input.contract, 'phone', coins[index].branch).publicKey!),
      hardwarePub: hex.encode(normalKey(input.contract, 'hardware', coins[index].branch).publicKey!),
    }),
  )
  // Preserve locally reconstructed scripts and origins after signature verification.
  coins.forEach((_, i) => phone.updateInput(i, { tapScriptSig: signed.getInput(i).tapScriptSig }))
  return hex.encode(phone.toPSBT())
}
