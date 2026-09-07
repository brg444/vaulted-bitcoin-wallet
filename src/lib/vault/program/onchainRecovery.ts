import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { bitcoinDustSats, scriptHexFromAddress } from '../bitcoin'
import { requireExactDefaultTapscriptSignatures, tapscriptSignatureRecords } from '../taprootSignatures'
import { isConnectorTemplate } from './connector'
import { type Claimant } from './constants'
import { familyFromDescriptor } from './descriptor'
import { parseRecoveryKit, type RecoveryKit } from './kit'
import { buildClaimPsbt, buildGuardianExitPsbt, tapLeafForScript } from './spend'
import { pendingGuardians } from './trees'

const options = { version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true } as const
export type SavingsRecoveryPath =
  | { program: 'savings-admin' }
  | { program: 'pending-claim' | 'pending-cancel' | 'quarantine'; claimant: Claimant }

export interface SavingsRecoveryFile {
  name: 'vaulted-savings-recovery'
  version: 1
  kit: RecoveryKit
  path: SavingsRecoveryPath
  parentHex: string
  vout: number
  destination: string
  feeSats: number
  psbt: string
}

function pathFacts(kit: RecoveryKit, path: SavingsRecoveryPath) {
  const d = kit.descriptor
  const family = familyFromDescriptor(d)
  if (path.program === 'savings-admin') {
    if (isConnectorTemplate(d.templateVersion))
      throw new Error('Connector Savings requires its saved payment and cosigner authorization')
    return {
      tree: family.savings,
      leaf: family.savings.admin,
      signers: ['phone', 'hardware'] as Claimant[],
      sequence: 0xfffffffd,
    }
  }
  if (!['phone', 'hardware', 'recovery'].includes(path.claimant)) throw new Error('Invalid recovery claimant')
  const key = `savings-${path.claimant}` as const
  if (!d.pending[key]) throw new Error('This vault has no recovery path for that key')
  if (path.program === 'quarantine') {
    const tree = family.quarantine[key]
    return { tree, leaf: tree.admin, signers: tree.guardians, sequence: 0xfffffffd }
  }
  const tree = family.pending[key]
  if (path.program === 'pending-claim')
    return { tree, leaf: tree.claim, signers: [path.claimant], sequence: tree.delay }
  if (path.program !== 'pending-cancel' || !tree.guardianExit)
    throw new Error('This vault has no service-independent cancellation path')
  return {
    tree,
    leaf: tree.guardianExit,
    signers: pendingGuardians(path.claimant, Boolean(d.keys.recovery)),
    sequence: 0xfffffffd,
  }
}

function build(input: Omit<SavingsRecoveryFile, 'name' | 'version' | 'psbt'>) {
  const kit = parseRecoveryKit(input.kit)
  const facts = pathFacts(kit, input.path)
  if (!/^(?:[0-9a-f]{2})+$/.test(input.parentHex) || input.parentHex.length > 8_000_000)
    throw new Error('Canonical parent transaction required')
  const parent = Transaction.fromRaw(hex.decode(input.parentHex), options)
  if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout >= parent.outputsLength)
    throw new Error('Recovery parent output missing')
  const output = parent.getOutput(input.vout)
  if (!output.script || hex.encode(output.script) !== hex.encode(facts.tree.script) || output.amount === undefined)
    throw new Error('Recovery parent does not pay the selected program')
  if (output.amount <= 0n || output.amount > 21_000_000n * 100_000_000n) throw new Error('Invalid recovery value')
  if (
    !Number.isSafeInteger(input.feeSats) ||
    input.feeSats < 0 ||
    input.feeSats > kit.descriptor.policy.absoluteFeeCapSats
  )
    throw new Error('Recovery fee exceeds the vault cap')
  const amount = output.amount - BigInt(input.feeSats)
  if (amount < BigInt(bitcoinDustSats(input.destination, kit.descriptor.network)))
    throw new Error('Recovery output is below dust')
  let tx: Transaction
  if (input.path.program === 'pending-claim' || input.path.program === 'pending-cancel') {
    const builder = input.path.program === 'pending-claim' ? buildClaimPsbt : buildGuardianExitPsbt
    const built = builder({
      family: familyFromDescriptor(kit.descriptor),
      claimant: input.path.claimant,
      coin: { txid: parent.id, vout: input.vout, value: Number(output.amount) },
      destAddress: input.destination,
      feeSats: input.feeSats,
      network: kit.descriptor.network,
    })
    tx = Transaction.fromPSBT(hex.decode(built.psbtHex), options)
    tx.updateInput(0, { nonWitnessUtxo: hex.decode(input.parentHex) })
  } else {
    // The live Savings builder requires localStorage pins and current status.
    // This offline sweep proves its single prevout directly from the saved parent.
    tx = new Transaction(options)
    tx.addInput({
      txid: parent.id,
      index: input.vout,
      sequence: facts.sequence,
      witnessUtxo: { script: output.script, amount: output.amount },
      nonWitnessUtxo: hex.decode(input.parentHex),
      tapInternalKey: facts.tree.tapInternalKey,
      tapLeafScript: [tapLeafForScript(facts.tree.tapLeafScript, facts.leaf)],
    })
    tx.addOutput({ script: hex.decode(scriptHexFromAddress(input.destination, kit.descriptor.network)), amount })
  }
  const pubs = facts.signers.map((role) => {
    const pub = role === 'phone' ? kit.descriptor.keys.phoneBip340 : kit.descriptor.keys[role]
    if (!pub) throw new Error('Missing required recovery key')
    return pub.slice(2)
  })
  return { tx, kit, ...facts, pubs, parentTxid: parent.id }
}

/** No network calls, signing, or broadcasts occur during preparation. */
export function prepareSavingsRecovery(
  input: Omit<SavingsRecoveryFile, 'name' | 'version' | 'psbt'>,
): SavingsRecoveryFile {
  const { tx, kit } = build(input)
  return { ...input, kit, name: 'vaulted-savings-recovery', version: 1, psbt: hex.encode(tx.toPSBT()) }
}

export function validateSavingsRecovery(raw: SavingsRecoveryFile) {
  if (
    !raw ||
    raw.name !== 'vaulted-savings-recovery' ||
    raw.version !== 1 ||
    typeof raw.psbt !== 'string' ||
    raw.psbt.length > 10_000_000
  )
    throw new Error('Invalid Savings recovery file')
  const rebuilt = build(raw)
  const tx = Transaction.fromPSBT(hex.decode(raw.psbt), options)
  const signatures = tx.getInput(0).tapScriptSig || []
  const signedPubs = signatures.map(([key]) => hex.encode(key.pubKey))
  if (signedPubs.some((pub) => !rebuilt.pubs.includes(pub))) throw new Error('Unexpected recovery signer')
  if (signatures.length) rebuilt.tx.updateInput(0, { tapScriptSig: signatures })
  if (hex.encode(tx.toPSBT()) !== hex.encode(rebuilt.tx.toPSBT()))
    throw new Error('Recovery transaction or signing metadata changed')
  if (signatures.length) requireExactDefaultTapscriptSignatures(tx, 0, signedPubs)
  return { ...rebuilt, tx, signedPubs, complete: signedPubs.length === rebuilt.pubs.length }
}

/** Hardware returns a partial PSBT; only the requested signature may be added. */
export function acceptSavingsRecoverySignature(
  file: SavingsRecoveryFile,
  psbt: string,
  role: Claimant,
): SavingsRecoveryFile {
  const before = validateSavingsRecovery(file)
  const index = before.signers.indexOf(role)
  if (index < 0 || before.signedPubs.includes(before.pubs[index])) throw new Error('That recovery key is not required')
  const next = { ...file, psbt }
  const after = validateSavingsRecovery(next)
  if (
    after.signedPubs.length !== before.signedPubs.length + 1 ||
    !after.signedPubs.includes(before.pubs[index]) ||
    tapscriptSignatureRecords(before.tx, 0).some(
      (signature) => !tapscriptSignatureRecords(after.tx, 0).includes(signature),
    )
  )
    throw new Error('Recovery must retain prior signatures and add the requested key')
  return next
}

export function finalizeSavingsRecovery(file: SavingsRecoveryFile) {
  const view = validateSavingsRecovery(file)
  if (!view.complete) throw new Error('Every required recovery key must sign')
  view.tx.finalize()
  if (file.feeSats > Math.ceil(view.tx.vsize * view.kit.descriptor.policy.feerateCapSatVb))
    throw new Error('Recovery fee rate exceeds the vault cap')
  return { txid: view.tx.id, txHex: hex.encode(view.tx.extract()) }
}

export interface SavingsRecoveryChain {
  status(txid: string): Promise<{ confirmed: boolean; blockHeight?: number }>
  tipHeight(): Promise<number>
  outspend(txid: string, vout: number): Promise<{ spent: boolean; txid?: string }>
  broadcast(txHex: string): Promise<string>
}

/** Persist the signed artifact before calling this. Retry broadcasts the same bytes. */
export async function executeSavingsRecovery(value: SavingsRecoveryFile, chain: SavingsRecoveryChain) {
  const file = JSON.parse(JSON.stringify(value)) as SavingsRecoveryFile
  const view = validateSavingsRecovery(file)
  const signed = finalizeSavingsRecovery(file)
  const spend = await chain.outspend(view.parentTxid, file.vout)
  if (spend.spent) {
    if (spend.txid !== signed.txid) throw new Error('Recovery input is spent by another transaction; retain this file')
    return { ...signed, confirmed: (await chain.status(signed.txid)).confirmed }
  }
  if (file.path.program === 'pending-claim') {
    const parent = await chain.status(view.parentTxid)
    const tip = await chain.tipHeight()
    if (
      !parent.confirmed ||
      !Number.isSafeInteger(parent.blockHeight) ||
      parent.blockHeight! <= 0 ||
      !Number.isSafeInteger(tip) ||
      tip + 1 < parent.blockHeight! + view.sequence
    )
      throw new Error('Pending recovery delay has not elapsed')
  }
  const txid = await chain.broadcast(signed.txHex)
  if (txid !== signed.txid) throw new Error('Recovery broadcast outcome is uncertain; retain this file')
  return { ...signed, confirmed: false }
}
