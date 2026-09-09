import { Transaction, timelockToSequence } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { bitcoinDustSats, scriptHexFromAddress } from '../bitcoin'
import { ledgerAccountKey, ledgerBip32Versions } from '../program/ledgerNativeKeys'
import { validateLedgerRecoveryDescriptor, type LedgerRecoveryDescriptor } from '../program/ledgerRecoveryDescriptor'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'
import { VaultPolicyV1Script } from './script'

const MAX_MONEY_SATS = 2_100_000_000_000_000
const SPENDING_BRANCH = 12
const SPENDING_INDEX = 0
export type LedgerSpendingRecoveryRole = 'hardware' | 'recovery'

/** Offline emergency recovery only. The reviewed request is retained separately from the returned PSBT. */
export interface LedgerSpendingRecoveryRequest {
  descriptor: LedgerRecoveryDescriptor
  coin: { txid: string; vout: number; value: number; parentTxHex: string }
  destination: string
  feeSats: number
}

function canonicalHex(value: string, label: string, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > maxBytes * 2 || !/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error(`${label} must be canonical hex`)
  return hex.decode(value)
}

function canonicalRecovery(request: LedgerSpendingRecoveryRequest) {
  const descriptor = validateLedgerRecoveryDescriptor(request.descriptor)
  const a = descriptor.spendingAuthorities
  const context = descriptor.ledgerSavings.context
  const account = ledgerAccountKey(context.hardware, context.network)
  const branch = account.deriveChild(SPENDING_BRANCH)
  const child = branch.deriveChild(SPENDING_INDEX)
  if (
    branch.index !== SPENDING_BRANCH ||
    child.index !== SPENDING_INDEX ||
    hex.encode(child.publicKey!.slice(1)) !== a.externalOwnerWalletPub.slice(2)
  )
    throw new Error('Ledger Spending hardware must be the enrolled account /12/0 key')
  const xonly = (value: string) => hex.decode(value.slice(2))
  const source = new VaultPolicyV1Script({
    network: context.network,
    userPub: xonly(a.phoneBip340Pub),
    exitDevicePub: xonly(a.phoneBip340Pub),
    exitHardwarePub: xonly(a.externalOwnerWalletPub),
    ...(a.recoveryKeyPub ? { exitRecoveryPub: xonly(a.recoveryKeyPub) } : {}),
    vtxoVaultCosignerPub: xonly(a.vtxoVaultCosignerPub),
    arkdServerPub: xonly(a.operatorPub),
    delegatePub: xonly(a.vtxoDelegatePub),
    exitDelay: BigInt(a.vtxoExitDelay),
    exitDelayUnit: 'seconds',
  })
  const { coin, feeSats } = request
  if (
    !coin ||
    !/^[0-9a-f]{64}$/.test(coin.txid) ||
    !Number.isInteger(coin.vout) ||
    coin.vout < 0 ||
    coin.vout > 0xffffffff
  )
    throw new Error('Invalid Ledger Spending recovery outpoint')
  if (!Number.isSafeInteger(coin.value) || coin.value <= 0 || coin.value > MAX_MONEY_SATS)
    throw new Error('Invalid Ledger Spending recovery value')
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0 || feeSats > descriptor.policy.absoluteFeeCapSats)
    throw new Error('Ledger Spending recovery fee exceeds the absolute cap')
  const amountSats = coin.value - feeSats
  if (amountSats < bitcoinDustSats(request.destination, context.network))
    throw new Error('Ledger Spending recovery output is below dust')
  const parentBytes = canonicalHex(coin.parentTxHex, 'Ledger Spending recovery parent', 4_000_000)
  const parent = Transaction.fromRaw(parentBytes)
  if (
    parent.id !== coin.txid ||
    coin.vout >= parent.outputsLength ||
    hex.encode(parent.toBytes(true, true)) !== coin.parentTxHex
  )
    throw new Error('Ledger Spending recovery parent mismatch')
  const prevout = parent.getOutput(coin.vout)
  if (
    prevout.amount !== BigInt(coin.value) ||
    !prevout.script ||
    hex.encode(prevout.script) !== hex.encode(source.pkScript)
  )
    throw new Error('Ledger Spending recovery prevout differs from enrollment')
  const leaf = source.exit()
  const sequence = timelockToSequence({ type: 'seconds', value: source.params.exitDelay })
  // Match the existing SDK sweep metadata exactly. The complete parent is
  // verified above; adding it to this PSBT would change the current sweep format.
  const tx = new Transaction({ version: 2, lockTime: 0 })
  tx.addInput({
    txid: coin.txid,
    index: coin.vout,
    sequence,
    witnessUtxo: { amount: BigInt(coin.value), script: source.pkScript },
    tapLeafScript: [leaf],
    sighashType: 0,
  })
  tx.addOutput({
    amount: BigInt(amountSats),
    script: hex.decode(scriptHexFromAddress(request.destination, context.network)),
  })
  const measured = tx.clone()
  measured.updateInput(0, {
    finalScriptWitness: [
      new Uint8Array(64),
      new Uint8Array(64),
      hex.decode(source.exitScript),
      TaprootControlBlock.encode(leaf[0]),
    ],
  })
  const vsize = measured.vsize
  if (feeSats > descriptor.policy.feerateCapSatVb * vsize)
    throw new Error('Ledger Spending recovery fee exceeds the feerate cap')
  const requiredKeys = a.recoveryKeyPub
    ? [
        { role: 'hardware' as const, publicKey: a.externalOwnerWalletPub },
        { role: 'recovery' as const, publicKey: a.recoveryKeyPub },
      ]
    : [
        { role: 'phone' as const, publicKey: a.phoneBip340Pub },
        { role: 'hardware' as const, publicKey: a.externalOwnerWalletPub },
      ]
  return { descriptor, tx, amountSats, vsize, requiredKeys, sequence }
}

export function buildLedgerSpendingRecoveryPsbt(request: LedgerSpendingRecoveryRequest): string {
  return hex.encode(canonicalRecovery(request).tx.toPSBT())
}

export function inspectLedgerSpendingRecovery(request: LedgerSpendingRecoveryRequest) {
  const plan = canonicalRecovery(request)
  return {
    destination: request.destination,
    amountSats: plan.amountSats,
    feeSats: request.feeSats,
    vsize: plan.vsize,
    sequence: plan.sequence,
    requiredKeys: plan.requiredKeys,
  }
}

function importApproval(plan: ReturnType<typeof canonicalRecovery>, psbt: string, role: LedgerSpendingRecoveryRole) {
  const supplied = Transaction.fromPSBT(canonicalHex(psbt, 'Ledger Spending recovery PSBT', 4_100_000))
  if (hex.encode(supplied.unsignedTx) !== hex.encode(plan.tx.unsignedTx))
    throw new Error('Ledger Spending recovery transaction changed')
  const signatures = supplied.getInput(0).tapScriptSig ?? []
  if (!plan.requiredKeys.some((key) => key.role === role))
    throw new Error('Ledger Spending recovery role is not enrolled')
  const counterpart = plan.requiredKeys.find((key) => key.role !== role)!.publicKey.slice(2)
  if (signatures.some(([key, sig]) => hex.encode(key.pubKey) !== counterpart || sig.length !== 64))
    throw new Error('Ledger Spending recovery has an unexpected or non-DEFAULT signature')
  if (signatures.length) {
    requireExactDefaultTapscriptSignatures(supplied, 0, [counterpart])
    plan.tx.updateInput(0, { tapScriptSig: signatures })
  }
  if (hex.encode(supplied.toPSBT()) !== hex.encode(plan.tx.toPSBT()))
    throw new Error('Ledger Spending recovery signing metadata changed')
  return plan.tx
}

/**
 * Emergency software signing exposes the Ledger seed to this offline process.
 * The caller must obtain explicit acceptance and clear mnemonic/passphrase/seed
 * buffers after use. No seed, private key, or arbitrary signing path is returned.
 * All private derivations and the owned seed copy are wiped on success and error.
 */
export function signLedgerSpendingRecoveryWithSeed(
  request: LedgerSpendingRecoveryRequest,
  seed: Uint8Array,
  psbt: string,
  role: LedgerSpendingRecoveryRole = 'hardware',
): string {
  if (role !== 'hardware' && role !== 'recovery') throw new Error('Unknown Ledger Spending recovery role')
  const plan = canonicalRecovery(request)
  const tx = importApproval(plan, psbt, role)
  const expectedPubs = [
    ...(tx.getInput(0).tapScriptSig ?? []).map(([key]) => hex.encode(key.pubKey)),
    plan.descriptor.keys[role]!.slice(2),
  ]
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Ledger emergency recovery requires the 64-byte BIP39 seed')
  const copy = Uint8Array.from(seed)
  const nodes: HDKey[] = []
  try {
    const context = plan.descriptor.ledgerSavings.context
    const origin = context[role]!
    let key = HDKey.fromMasterSeed(copy, ledgerBip32Versions(context.network))
    nodes.push(key)
    if (key.fingerprint.toString(16).padStart(8, '0') !== origin.fingerprint)
      throw new Error('Ledger seed or passphrase does not match the enrolled recovery authority')
    for (const index of origin.path) {
      key = key.deriveChild(index)
      nodes.push(key)
      if (key.index !== index) throw new Error('Invalid Ledger recovery account derivation')
    }
    if (key.publicExtendedKey !== origin.xpub)
      throw new Error('Ledger seed or passphrase does not match the enrolled recovery authority')
    for (const index of [SPENDING_BRANCH, SPENDING_INDEX]) {
      key = key.deriveChild(index)
      nodes.push(key)
      if (key.index !== index) throw new Error('Invalid Ledger Spending recovery derivation')
    }
    if (hex.encode(key.publicKey!.slice(1)) !== plan.descriptor.keys[role]!.slice(2))
      throw new Error('Ledger Spending recovery key differs from enrollment')
    tx.signIdx(key.privateKey!, 0)
    requireExactDefaultTapscriptSignatures(tx, 0, expectedPubs)
    return hex.encode(tx.toPSBT())
  } finally {
    copy.fill(0)
    for (const key of nodes) key.wipePrivateData()
  }
}
