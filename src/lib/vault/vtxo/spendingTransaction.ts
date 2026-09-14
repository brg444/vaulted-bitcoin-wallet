import {
  ArkAddress,
  buildOffchainTx,
  CSVMultisigTapscript,
  Intent,
  scriptFromTapLeafScript,
  SingleKey,
  Transaction,
  verifyTapscriptSignatures,
  type ArkProvider,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { SigHash } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { type VtxoReserveResponse } from '../cosignerClient'
import { networkPins } from '../networkPins'
import { LEDGER_NATIVE_TEMPLATE } from '../program/ledgerNativeKeys'
import { requireSpendingEnrollmentStatus, SPENDING_ONLY_TEMPLATE } from '../spendingEnrollment'
import type { VaultStatus } from '../types'
import { verifyVtxoReserveSignature, type VtxoReserveDigestInput } from './reserveAuth'
import { VAULT_POLICY_V1_EXIT_DELAY_UNIT, VaultPolicyV1Script, type VaultPolicyV1Params } from './script'
import { type VaultSdkOperationValidation } from './sdkOperationAdapter'
import { VtxoSpendInFlightError } from './spendingErrors'

export const VTXO_DUST_SATS = 330

const MAX_VTXO_INPUTS = 50

export type PersistedVtxoSpendStage =
  | 'pre-reserve'
  | 'reserved'
  | 'authorized'
  | 'operator-submitted'
  | 'checkpoints-authorized'
  | 'operator-finalized'

export interface PersistedVtxoSpend {
  vaultId: string
  operationId: string
  bundleDigest: string
  destAddress: string
  amountSats: number
  arkTxid: string
  reservationExpires?: string
  checkpointTapscript?: string
  stage: PersistedVtxoSpendStage
  unsignedArkPsbt?: string
  authorizedPsbt?: string
  authorizedPendingProof?: string
  operatorSubmitAttempted?: boolean
  /** Exact Guardian receipt observed; recovery bytes may still need retention. */
  receiptFinalized?: boolean
  unsignedCheckpointPsbts?: string[]
  operatorCheckpointPsbts?: string[]
  checkpointPsbts?: string[]
  reservePhoneSignature?: string
  feePolicyDigest?: string
  feeSats?: number
  changeSats?: number
  changeVout?: number
  sdkBundleVersion?: 1
  reservedInputs?: { txid: string; vout: number; valueSats: number; scriptHex: string }[]
  reservedOutputs?: { scriptHex: string; amountSats: number }[]
  operatorArkPsbt?: string
}

export function persistedReservationFactsAreValid(record: Partial<PersistedVtxoSpend>): boolean {
  if (record.stage === 'pre-reserve') return true
  const reviewFactsAreValid = Boolean(
    /^[0-9a-f]{64}$/.test(String(record.feePolicyDigest || '')) &&
      typeof record.feeSats === 'number' &&
      Number.isSafeInteger(record.feeSats) &&
      record.feeSats >= 0 &&
      typeof record.changeSats === 'number' &&
      Number.isSafeInteger(record.changeSats) &&
      record.changeSats >= 0 &&
      (record.changeSats === 0 ? record.changeVout === undefined : record.changeVout === 1),
  )
  if (!reviewFactsAreValid || record.sdkBundleVersion === undefined) return reviewFactsAreValid
  if (record.sdkBundleVersion !== 1) return false
  const inputs = record.reservedInputs
  const outputs = record.reservedOutputs
  if (!inputs || inputs.length < 1 || inputs.length > MAX_VTXO_INPUTS || !outputs) return false
  if (outputs.length !== (record.changeSats === 0 ? 1 : 2)) return false
  if (
    outputs[0]?.amountSats !== record.amountSats ||
    !/^[0-9a-f]{68}$/.test(String(outputs[0]?.scriptHex || '')) ||
    (record.changeSats !== 0 &&
      (outputs[1]?.amountSats !== record.changeSats || !/^[0-9a-f]{68}$/.test(String(outputs[1]?.scriptHex || ''))))
  ) {
    return false
  }
  let previousOutpoint = ''
  let inputTotal = 0
  for (const input of inputs) {
    if (
      !/^[0-9a-f]{64}$/.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > 0xffffffff ||
      !Number.isSafeInteger(input.valueSats) ||
      input.valueSats <= 0 ||
      !/^[0-9a-f]{68}$/.test(input.scriptHex)
    ) {
      return false
    }
    const outpoint = `${input.txid}:${input.vout.toString(16).padStart(8, '0')}`
    if (previousOutpoint && outpoint <= previousOutpoint) return false
    previousOutpoint = outpoint
    inputTotal += input.valueSats
    if (!Number.isSafeInteger(inputTotal)) return false
  }
  return inputTotal === record.amountSats! + record.feeSats! + record.changeSats!
}

export function requireHex(value: string | undefined, bytes: number, name: string): Uint8Array<ArrayBuffer> {
  let decoded: Uint8Array
  try {
    decoded = hex.decode(String(value || '').toLowerCase())
  } catch {
    throw new Error(`${name} is not hex`)
  }
  if (decoded.length !== bytes) throw new Error(`${name} must be ${bytes} bytes`)
  return decoded as Uint8Array<ArrayBuffer>
}

export function requireNonemptyHex(value: string | undefined, name: string): string {
  const normalized = String(value || '').toLowerCase()
  if (!normalized) throw new Error(`${name} is missing`)
  if (normalized.length % 2 !== 0) throw new Error(`${name} is not hex`)
  requireHex(normalized, normalized.length / 2, name)
  return normalized
}

export function xOnly(value: string | undefined, name: string): Uint8Array {
  const raw = String(value || '').toLowerCase()
  if (/^(02|03)[0-9a-f]{64}$/.test(raw)) return hex.decode(raw.slice(2))
  return requireHex(raw, 32, name)
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a?.length === b?.length && a?.every((value, index) => value === b?.[index]) === true
}

export function requireEnrolledSpendingStatus(status: VaultStatus) {
  const pins = networkPins(status.network)
  if (!status.enrolled) throw new Error('regular VTXO spending requires an enrolled vault')
  if (!status.vaultId) throw new Error('vault id required')
  if (status.vtxoExitDelay !== pins.policyExitDelay) throw new Error('VTXO exit delay does not match')
  if (status.vtxoExitDelayUnit !== VAULT_POLICY_V1_EXIT_DELAY_UNIT)
    throw new Error('VTXO exit delay unit does not match')
  return pins
}

export function vaultPolicyV1ScriptFromStatus(status: VaultStatus): VaultPolicyV1Script {
  if (status.templateVersion !== SPENDING_ONLY_TEMPLATE && status.templateVersion !== LEDGER_NATIVE_TEMPLATE)
    throw new Error('Unsupported Spending program')
  const pins = requireEnrolledSpendingStatus(status)
  const address = ArkAddress.decode(String(status.spendingArkAddress || ''))
  if (address.hrp !== pins.arkHrp) throw new Error('spending Ark address does not match this network')
  const spendingOnly = status.templateVersion === SPENDING_ONLY_TEMPLATE
  if (spendingOnly) requireSpendingEnrollmentStatus(status)
  const params: VaultPolicyV1Params = {
    userPub: xOnly(status.phoneBip340Pub, 'phone pubkey'),
    vtxoVaultCosignerPub: xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
    arkdServerPub: address.serverPubKey,
    delegatePub: xOnly(status.vtxoDelegatePub, 'delegate pubkey'),
    exitDelay: BigInt(pins.policyExitDelay),
    exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
    network: pins.network,
    exitDevicePub: xOnly(status.phoneBip340Pub, 'phone pubkey'),
    ...(spendingOnly
      ? { exitMode: 'device' as const }
      : { exitHardwarePub: xOnly(status.externalOwnerWalletPub, 'hardware pubkey') }),
    ...(status.recoveryKeyPub || status.recoveryPub
      ? { exitRecoveryPub: xOnly(status.recoveryKeyPub || status.recoveryPub, 'recovery pubkey') }
      : {}),
  }
  const script = new VaultPolicyV1Script(params)
  const advertised = requireHex(status.spendingArkScript, 34, 'spending Ark script')
  if (!sameBytes(script.pkScript, advertised) || !sameBytes(address.pkScript, advertised)) {
    throw new Error('spending Ark address does not match vault-policy-v1')
  }
  return script
}

export function vtxoDestinationScript(status: VaultStatus, destAddress: string): Uint8Array {
  const spendingAddress = ArkAddress.decode(String(status.spendingArkAddress || ''))
  let destination: ArkAddress
  try {
    destination = ArkAddress.decode(destAddress.trim())
  } catch {
    throw new Error('regular VTXO destination must be an Arkade address')
  }
  if (destination.hrp !== networkPins(status.network).arkHrp) {
    throw new Error('destination Arkade address does not match this network')
  }
  if (!sameBytes(destination.serverPubKey, spendingAddress.serverPubKey)) {
    throw new Error('destination belongs to another Arkade Operator')
  }
  return destination.pkScript
}

export function reserveDigestInput(pending: PersistedVtxoSpend, status: VaultStatus): VtxoReserveDigestInput {
  if (pending.vaultId !== status.vaultId) throw new Error('VTXO reservation vault does not match status')
  return {
    operationId: pending.operationId,
    vaultId: pending.vaultId,
    destScript: vtxoDestinationScript(status, pending.destAddress),
    amountSats: pending.amountSats,
  }
}

export function reserveSignatureMatches(pending: PersistedVtxoSpend, status: VaultStatus): boolean {
  if (!pending.reservePhoneSignature) return false
  return verifyVtxoReserveSignature(
    reserveDigestInput(pending, status),
    pending.reservePhoneSignature,
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
  )
}

export function buildReservedVtxoSpend(
  status: VaultStatus,
  reserve: VtxoReserveResponse,
  amountSats: number,
  destAddress: string,
  expectedFeePolicyDigest: string,
) {
  const script = vaultPolicyV1ScriptFromStatus(status)
  if (!Number.isSafeInteger(amountSats) || amountSats < VTXO_DUST_SATS) {
    throw new Error('VTXO amount is below dust')
  }
  if (amountSats > status.txCap) throw new Error('VTXO amount exceeds the transaction cap')
  if (!/^[0-9a-f]{64}$/.test(reserve.feePolicyDigest)) throw new Error('fee policy digest is malformed')
  if (reserve.feePolicyDigest !== expectedFeePolicyDigest) throw new Error('Operator fee policy changed')
  if (!Number.isSafeInteger(reserve.feeSats) || reserve.feeSats < 0) throw new Error('reserved fee is invalid')
  if (reserve.feeSats > status.absoluteFeeCap) throw new Error('reserved fee exceeds the vault cap')
  if (amountSats + reserve.feeSats > status.periodRemaining) throw new Error('reserved total exceeds the allowance')
  if (!Number.isSafeInteger(reserve.changeSats) || reserve.changeSats < 0) {
    throw new Error('reserved change is invalid')
  }
  if (reserve.inputs.length < 1 || reserve.inputs.length > MAX_VTXO_INPUTS) {
    throw new Error(`reservation must contain 1 to ${MAX_VTXO_INPUTS} inputs`)
  }

  const policyScriptHex = hex.encode(script.pkScript)
  let previousOutpoint = ''
  let inputTotal = 0n
  for (const input of reserve.inputs) {
    if (!/^[0-9a-f]{64}$/.test(input.txid)) throw new Error('reserved input txid is malformed')
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new Error('reserved input vout is malformed')
    }
    if (!Number.isSafeInteger(input.valueSats) || input.valueSats <= 0) {
      throw new Error('reserved input value is malformed')
    }
    if (input.scriptHex !== policyScriptHex) throw new Error('reserved input is not vault-policy-v1')
    const outpoint = `${input.txid}:${input.vout.toString(16).padStart(8, '0')}`
    if (previousOutpoint && outpoint <= previousOutpoint) {
      throw new Error(outpoint === previousOutpoint ? 'duplicate reserved input' : 'reserved inputs are not canonical')
    }
    previousOutpoint = outpoint
    inputTotal += BigInt(input.valueSats)
    if (inputTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('reserved input total overflows safe sats')
  }

  const requiredTotal = BigInt(amountSats) + BigInt(reserve.feeSats) + BigInt(reserve.changeSats)
  if (inputTotal !== requiredTotal) throw new Error('reserved input total does not conserve value')
  if (reserve.destScript.toLowerCase() !== hex.encode(vtxoDestinationScript(status, destAddress))) {
    throw new Error('reserved destination does not match the requested address')
  }
  const outputs = [
    {
      script: requireHex(reserve.destScript, reserve.destScript.length / 2, 'destination script'),
      amount: BigInt(amountSats),
    },
  ]
  if (reserve.changeSats === 0) {
    if (reserve.changeVout !== undefined || reserve.changeAddress !== '' || reserve.changeScript !== '') {
      throw new Error('zero change must omit all change output facts')
    }
  } else {
    if (reserve.changeSats < VTXO_DUST_SATS) throw new Error('VTXO change is below dust')
    if (reserve.changeVout !== 1) throw new Error('change output index is not canonical')
    if (reserve.changeScript !== policyScriptHex) throw new Error('change is not vault-policy-v1')
    if (reserve.changeAddress !== status.spendingArkAddress) throw new Error('change address is not vault-policy-v1')
    outputs.push({ script: requireHex(reserve.changeScript, 34, 'change script'), amount: BigInt(reserve.changeSats) })
  }
  const checkpointTapscript = requireNonemptyHex(reserve.checkpointTapscript, 'checkpoint tapscript')
  if (checkpointTapscript !== networkPins(status.network).checkpointTapscript) {
    throw new Error('reserved checkpoint tapscript does not match this release')
  }
  const unroll = CSVMultisigTapscript.decode(
    requireHex(checkpointTapscript, checkpointTapscript.length / 2, 'checkpoint tapscript'),
  )
  return buildOffchainTx(
    reserve.inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      value: input.valueSats,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    })),
    outputs,
    unroll,
  )
}

export function buildPersistedVtxoSdkBundle(status: VaultStatus, pending: PersistedVtxoSpend) {
  if (
    pending.sdkBundleVersion !== 1 ||
    !pending.reservedInputs ||
    !pending.reservedOutputs ||
    !pending.checkpointTapscript ||
    !persistedReservationFactsAreValid(pending)
  ) {
    throw new Error('fresh SDK spend is missing its validated reservation bundle')
  }
  const script = vaultPolicyV1ScriptFromStatus(status)
  const policyScriptHex = hex.encode(script.pkScript)
  for (const input of pending.reservedInputs) {
    if (input.scriptHex !== policyScriptHex) throw new Error('persisted SDK input is not current vault-policy-v1')
  }
  const destinationScript = hex.encode(vtxoDestinationScript(status, pending.destAddress))
  if (
    pending.reservedOutputs[0].scriptHex !== destinationScript ||
    pending.reservedOutputs[0].amountSats !== pending.amountSats
  ) {
    throw new Error('persisted SDK destination changed from the reviewed reservation')
  }
  if (pending.changeSats === 0) {
    if (pending.reservedOutputs.length !== 1) throw new Error('zero-change SDK bundle has another output')
  } else if (
    pending.reservedOutputs.length !== 2 ||
    pending.reservedOutputs[1].scriptHex !== policyScriptHex ||
    pending.reservedOutputs[1].amountSats !== pending.changeSats
  ) {
    throw new Error('persisted SDK change is not current vault-policy-v1')
  }
  const inputs = pending.reservedInputs.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    value: input.valueSats,
    tapLeafScript: script.forfeit(),
    tapTree: script.encode(),
  }))
  const outputs = pending.reservedOutputs.map((output) => ({
    script: requireHex(output.scriptHex, 34, 'persisted SDK output script'),
    amount: BigInt(output.amountSats),
  }))
  const serverUnrollScript = CSVMultisigTapscript.decode(
    requireHex(pending.checkpointTapscript, pending.checkpointTapscript.length / 2, 'persisted checkpoint tapscript'),
  )
  const rebuilt = buildOffchainTx(inputs, outputs, serverUnrollScript)
  if (rebuilt.arkTx.id !== pending.arkTxid) throw new Error('persisted SDK bundle changed the reserved Ark transaction')
  if (!pending.unsignedCheckpointPsbts?.length) throw new Error('persisted SDK bundle is missing checkpoints')
  checkpointPairsInCanonicalOrder(
    pending.unsignedCheckpointPsbts,
    rebuilt.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
    'SDK rebuild',
  )
  return { inputs, outputs, serverUnrollScript, rebuilt }
}

export const VTXO_GET_PENDING_MESSAGE: Intent.GetPendingTxMessage = {
  type: 'get-pending-tx',
  expire_at: 0,
}

type PsbtInput = ReturnType<Transaction['getInput']>

function sameOptionalBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && sameBytes(a, b)
}

function sameTapLeafScripts(a: PsbtInput['tapLeafScript'], b: PsbtInput['tapLeafScript']): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.length === b.length &&
    a.every(([leftControl, leftScript], index) => {
      const right = b[index]
      return Boolean(
        right &&
          leftControl.version === right[0].version &&
          sameBytes(leftControl.internalKey, right[0].internalKey) &&
          leftControl.merklePath.length === right[0].merklePath.length &&
          leftControl.merklePath.every((node, nodeIndex) => sameBytes(node, right[0].merklePath[nodeIndex])) &&
          sameBytes(leftScript, right[1]),
      )
    })
  )
}

function requireInputShapeMatches(expected: PsbtInput, candidate: PsbtInput, context: string) {
  if (
    !sameOptionalBytes(expected.txid, candidate.txid) ||
    expected.index !== candidate.index ||
    expected.sequence !== candidate.sequence ||
    expected.sighashType !== candidate.sighashType ||
    !sameOptionalBytes(expected.tapInternalKey, candidate.tapInternalKey) ||
    !sameOptionalBytes(expected.tapMerkleRoot, candidate.tapMerkleRoot)
  ) {
    throw new Error(`${context} changed an input`)
  }
  if (expected.witnessUtxo === undefined || candidate.witnessUtxo === undefined) {
    if (expected.witnessUtxo !== candidate.witnessUtxo) throw new Error(`${context} changed an input prevout`)
  } else if (
    expected.witnessUtxo.amount !== candidate.witnessUtxo.amount ||
    !sameBytes(expected.witnessUtxo.script, candidate.witnessUtxo.script)
  ) {
    throw new Error(`${context} changed an input prevout`)
  }
  if (!sameTapLeafScripts(expected.tapLeafScript, candidate.tapLeafScript)) {
    throw new Error(`${context} changed an input tapleaf`)
  }
}

function pendingProofFromCheckpoints(unsignedCheckpointPsbts: string[]): Transaction {
  if (unsignedCheckpointPsbts.length < 1 || unsignedCheckpointPsbts.length > MAX_VTXO_INPUTS) {
    throw new Error('pending proof requires the exact reserved checkpoints')
  }
  const inputs = unsignedCheckpointPsbts.map((raw) => {
    const checkpoint = Transaction.fromPSBT(base64.decode(raw))
    if (checkpoint.inputsLength !== 1) throw new Error('pending proof checkpoint must have one input')
    return checkpoint.getInput(0)
  })
  return Intent.create(VTXO_GET_PENDING_MESSAGE, inputs, [])
}

function transactionWithoutTapscriptSignatures(tx: Transaction): Uint8Array {
  const unsigned = tx.clone()
  const inputs = (
    unsigned as unknown as {
      inputs: (PsbtInput & { unknown?: [{ type: number; key: Uint8Array }, Uint8Array][] })[]
    }
  ).inputs
  for (const input of inputs) {
    Reflect.deleteProperty(input, 'tapScriptSig')
    if (input.unknown) {
      input.unknown = input.unknown.filter(([key]) => !(key.type === 222 && hex.encode(key.key) === '74617074726565'))
    }
  }
  return unsigned.toPSBT()
}

function pendingProofWithoutTapscriptSignatures(proof: Transaction): Uint8Array {
  return transactionWithoutTapscriptSignatures(proof)
}

function requireExactTapscriptSigners(
  proof: Transaction,
  inputIndex: number,
  expectedPubkeys: Uint8Array[],
  allowedSighashTypes?: number[],
  expectedLeafHash?: Uint8Array,
) {
  const signatures = proof.getInput(inputIndex).tapScriptSig || []
  const actual = signatures.map(([data]) => hex.encode(data.pubKey)).sort()
  const expected = expectedPubkeys.map(hex.encode).sort()
  if (actual.length !== expected.length || actual.some((pubkey, index) => pubkey !== expected[index])) {
    throw new Error('pending proof has the wrong signer set')
  }
  verifyTapscriptSignatures(proof, inputIndex, expected, undefined, allowedSighashTypes, expectedLeafHash)
}

function inputSpendLeafHash(tx: Transaction, inputIndex: number): Uint8Array {
  const leaves = tx.getInput(inputIndex).tapLeafScript
  if (leaves?.length !== 1) throw new Error(`input ${inputIndex} must carry exactly one spend leaf`)
  const scriptWithVersion = leaves[0][1]
  const version = scriptWithVersion[scriptWithVersion.length - 1]
  return tapLeafHash(scriptFromTapLeafScript(leaves[0]), version)
}

export async function createPhoneSignedPendingProof(
  unsignedCheckpointPsbts: string[],
  identity: Pick<SingleKey, 'sign'>,
  phonePub: Uint8Array,
): Promise<string> {
  const proof = await identity.sign(pendingProofFromCheckpoints(unsignedCheckpointPsbts))
  for (let index = 0; index < proof.inputsLength; index++) {
    requireExactTapscriptSigners(proof, index, [phonePub], [SigHash.ALL], inputSpendLeafHash(proof, index))
  }
  return base64.encode(proof.toPSBT())
}

/** Rebuild the canonical proof and require exactly the phone and VaultCosigner signatures. */
export function requireAuthorizedPendingProof(
  unsignedCheckpointPsbts: string[],
  authorizedPendingProof: string,
  status: VaultStatus,
): string {
  const expected = pendingProofFromCheckpoints(unsignedCheckpointPsbts)
  const candidate = Transaction.fromPSBT(base64.decode(authorizedPendingProof))
  if (
    candidate.id !== expected.id ||
    candidate.inputsLength !== expected.inputsLength ||
    candidate.outputsLength !== expected.outputsLength
  ) {
    throw new Error('Vault authorization changed the pending proof')
  }
  for (let index = 0; index < expected.inputsLength; index++) {
    requireInputShapeMatches(expected.getInput(index), candidate.getInput(index), 'Vault authorization')
  }
  if (!sameBytes(pendingProofWithoutTapscriptSignatures(expected), pendingProofWithoutTapscriptSignatures(candidate))) {
    throw new Error('Vault authorization changed the pending proof PSBT')
  }
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  for (let index = 0; index < candidate.inputsLength; index++) {
    requireExactTapscriptSigners(
      candidate,
      index,
      [phonePub, vaultPub],
      [SigHash.ALL],
      inputSpendLeafHash(expected, index),
    )
  }
  return base64.encode(candidate.toPSBT())
}

function requireCheckpointShapeMatches(original: Transaction, candidate: Transaction, context = 'Operator') {
  if (original.id !== candidate.id || original.inputsLength !== 1 || candidate.inputsLength !== 1) {
    throw new Error(`${context} changed the checkpoint transaction`)
  }
  const expected = original.getInput(0)
  const submitted = candidate.getInput(0)
  if (
    !expected.witnessUtxo ||
    !submitted.witnessUtxo ||
    expected.witnessUtxo.amount !== submitted.witnessUtxo.amount ||
    !sameBytes(expected.witnessUtxo.script, submitted.witnessUtxo.script)
  ) {
    throw new Error(`${context} changed the checkpoint prevout`)
  }
  if (
    expected.tapLeafScript?.length !== 1 ||
    submitted.tapLeafScript?.length !== 1 ||
    !sameBytes(expected.tapLeafScript[0][1], submitted.tapLeafScript[0][1])
  ) {
    throw new Error(`${context} changed the checkpoint tapleaf`)
  }
  if (!sameBytes(transactionWithoutTapscriptSignatures(original), transactionWithoutTapscriptSignatures(candidate))) {
    throw new Error(`${context} changed the checkpoint PSBT`)
  }
}

export function requireOperatorSignedCheckpoint(
  original: Transaction,
  candidate: Transaction,
  operatorPub: Uint8Array,
) {
  requireCheckpointShapeMatches(original, candidate)
  const submitted = candidate.getInput(0)
  const signatures = submitted.tapScriptSig
  if (signatures?.length !== 1 || !sameBytes(signatures[0][0].pubKey, operatorPub)) {
    throw new Error('checkpoint requires exactly the Operator signature')
  }
  verifyTapscriptSignatures(
    candidate,
    0,
    [hex.encode(operatorPub)],
    undefined,
    undefined,
    inputSpendLeafHash(original, 0),
  )
}

function requireArkShapeMatches(original: Transaction, candidate: Transaction, context: string) {
  if (
    original.id !== candidate.id ||
    original.inputsLength !== candidate.inputsLength ||
    original.outputsLength !== candidate.outputsLength
  ) {
    throw new Error(`${context} changed the Ark transaction`)
  }
  for (let index = 0; index < original.inputsLength; index++) {
    requireInputShapeMatches(original.getInput(index), candidate.getInput(index), context)
  }
  if (!sameBytes(transactionWithoutTapscriptSignatures(original), transactionWithoutTapscriptSignatures(candidate))) {
    throw new Error(`${context} changed the Ark PSBT`)
  }
}

function requireNoTapscriptSignatures(tx: Transaction, context: string) {
  for (let index = 0; index < tx.inputsLength; index++) {
    if (tx.getInput(index).tapScriptSig?.length) throw new Error(`${context} is already signed`)
  }
}

export function createVaultSdkOperationValidation(
  status: VaultStatus,
  unsignedArk: Transaction,
  operatorPub: Uint8Array,
): VaultSdkOperationValidation {
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  return {
    assertArkTransaction(candidate, stage) {
      requireArkShapeMatches(unsignedArk, candidate, `${stage} SDK validation`)
      if (stage === 'unsigned') requireNoTapscriptSignatures(candidate, 'unsigned Ark transaction')
      else {
        const signers = stage === 'vault-authorized' ? [phonePub, vaultPub] : [phonePub, vaultPub, operatorPub]
        for (let index = 0; index < candidate.inputsLength; index++) {
          requireExactTapscriptSigners(candidate, index, signers, undefined, inputSpendLeafHash(unsignedArk, index))
        }
      }
    },
    assertCheckpointTransaction(candidate, expectedUnsigned, stage) {
      requireCheckpointShapeMatches(expectedUnsigned, candidate, stage)
      if (stage === 'unsigned') requireNoTapscriptSignatures(candidate, 'unsigned checkpoint')
      else if (stage === 'operator-signed') requireOperatorSignedCheckpoint(expectedUnsigned, candidate, operatorPub)
      else {
        requireExactTapscriptSigners(
          candidate,
          0,
          [operatorPub, phonePub, vaultPub],
          undefined,
          inputSpendLeafHash(expectedUnsigned, 0),
        )
      }
    },
  }
}

export function checkpointPairsInCanonicalOrder(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
  context: string,
): { original: Transaction; candidate: Transaction }[] {
  if (candidateCheckpointPsbts.length !== expectedCheckpointPsbts.length) {
    throw new Error(`${context} returned the wrong checkpoint count`)
  }
  const candidates = new Map<string, Transaction>()
  for (const raw of candidateCheckpointPsbts) {
    const candidate = Transaction.fromPSBT(base64.decode(raw))
    if (candidates.has(candidate.id)) throw new Error(`${context} returned a duplicate checkpoint`)
    candidates.set(candidate.id, candidate)
  }
  const expectedIds = new Set<string>()
  const ordered = expectedCheckpointPsbts.map((raw) => {
    const original = Transaction.fromPSBT(base64.decode(raw))
    if (expectedIds.has(original.id)) throw new Error('local checkpoint identity is duplicated')
    expectedIds.add(original.id)
    const candidate = candidates.get(original.id)
    if (!candidate) throw new Error(`${context} returned an unknown or missing checkpoint`)
    requireCheckpointShapeMatches(original, candidate, context)
    candidates.delete(original.id)
    return { original, candidate }
  })
  if (candidates.size !== 0) throw new Error(`${context} returned an unknown checkpoint`)
  return ordered
}

/** Match by witness-independent checkpoint txid and restore reserved input order. */
export function matchOperatorSignedCheckpoints(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
  operatorPub: Uint8Array,
): string[] {
  return checkpointPairsInCanonicalOrder(expectedCheckpointPsbts, candidateCheckpointPsbts, 'Operator').map(
    ({ original, candidate }) => {
      requireOperatorSignedCheckpoint(original, candidate, operatorPub)
      return base64.encode(candidate.toPSBT())
    },
  )
}

type OperatorPendingTx = Awaited<ReturnType<ArkProvider['getPendingTxs']>>[number]

/** Validate the exact retained Operator result before advancing a persisted operation. */
export function matchPendingOperatorSubmission(
  pending: PersistedVtxoSpend,
  candidates: OperatorPendingTx[],
  status: VaultStatus,
  operatorPub: Uint8Array,
): { arkTxid: string; operatorArkPsbt: string; operatorCheckpointPsbts: string[] } {
  if (!pending.unsignedArkPsbt || !pending.unsignedCheckpointPsbts?.length) {
    throw new Error('persisted VTXO spend is missing its original transaction bundle')
  }
  if (candidates.length !== 1) throw new Error('Operator pending lookup did not return exactly one transaction')
  const candidate = candidates[0]
  if (candidate.arkTxid !== pending.arkTxid) throw new Error('Operator pending lookup returned another transaction')
  const originalArk = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const finalArk = Transaction.fromPSBT(base64.decode(candidate.finalArkTx))
  if (
    originalArk.id !== pending.arkTxid ||
    finalArk.id !== pending.arkTxid ||
    finalArk.inputsLength !== originalArk.inputsLength ||
    finalArk.outputsLength !== originalArk.outputsLength
  ) {
    throw new Error('Operator pending lookup changed the Ark transaction')
  }
  const expectedArkSigners = [
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
    xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
    operatorPub,
  ]
  for (let index = 0; index < originalArk.inputsLength; index++) {
    requireInputShapeMatches(originalArk.getInput(index), finalArk.getInput(index), 'Operator pending lookup')
    requireExactTapscriptSigners(finalArk, index, expectedArkSigners, undefined, inputSpendLeafHash(originalArk, index))
  }
  return {
    arkTxid: candidate.arkTxid,
    operatorArkPsbt: base64.encode(finalArk.toPSBT()),
    operatorCheckpointPsbts: matchOperatorSignedCheckpoints(
      pending.unsignedCheckpointPsbts,
      candidate.signedCheckpointTxs,
      operatorPub,
    ),
  }
}

/** Restore canonical checkpoint order after the VaultCosigner adds signatures. */
export function orderAuthorizedCheckpoints(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
): string[] {
  return checkpointPairsInCanonicalOrder(expectedCheckpointPsbts, candidateCheckpointPsbts, 'Vault service').map(
    ({ candidate }) => base64.encode(candidate.toPSBT()),
  )
}

export function requireFullyAuthorizedCheckpoints(
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  operatorPub: Uint8Array,
  checkpointPsbts = pending.checkpointPsbts,
): string[] {
  if (!pending.unsignedCheckpointPsbts?.length || !checkpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  return checkpointPairsInCanonicalOrder(pending.unsignedCheckpointPsbts, checkpointPsbts, 'Vault authorization').map(
    ({ original, candidate }) => {
      requireExactTapscriptSigners(
        candidate,
        0,
        [operatorPub, phonePub, vaultPub],
        undefined,
        inputSpendLeafHash(original, 0),
      )
      return base64.encode(candidate.toPSBT())
    },
  )
}

export function requireVaultAuthorizedArk(pending: PersistedVtxoSpend, status: VaultStatus): string {
  if (!pending.unsignedArkPsbt || !pending.authorizedPsbt) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const original = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const candidate = Transaction.fromPSBT(base64.decode(pending.authorizedPsbt))
  requireArkShapeMatches(original, candidate, 'Vault authorization')
  const signers = [
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
    xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
  ]
  for (let index = 0; index < candidate.inputsLength; index++) {
    requireExactTapscriptSigners(candidate, index, signers, undefined, inputSpendLeafHash(original, index))
  }
  return base64.encode(candidate.toPSBT())
}

export function requireUserSignedArkInputs(arkTx: Transaction, userPub: Uint8Array) {
  for (let index = 0; index < arkTx.inputsLength; index++) {
    verifyTapscriptSignatures(
      arkTx,
      index,
      [hex.encode(userPub)],
      undefined,
      undefined,
      inputSpendLeafHash(arkTx, index),
    )
  }
}
