import { connectorApprovalWitness } from './connectorApproval'
import { hex, base64 } from '@scure/base'
import { OutScript, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bitcoinDustSats, scriptHexFromAddress } from '../bitcoin'
import {
  buildConnectorFamily,
  connectorEnrollmentDigest,
  DUAL_CONNECTOR_TEMPLATE,
  type ConnectorOrigin,
} from './connector'
import { emulatorPacketScript, encodeEmulatorPacket, encodeExtensionScript } from './packet'
import { xOnlyFromCompressed } from '../savingsTree'

// Parent transactions use the emulator's proprietary PSBT fields. Preserving
// unknown script types alone does not preserve those fields during updates.
const OPTIONS = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true } as const
type ContractInput = Parameters<typeof connectorEnrollmentDigest>[0]
export interface ConnectorCoin {
  parentHex: string
  txid: string
  vout: number
}

// Pure transaction boundary for the upcoming wallet coordinator. The digest
// must come from the local enrollment pin. Parent confirmation and unspentness
// must be established by the chain adapter before calling this constructor.
export function prepareConnectorPayment(input: {
  contract: ContractInput
  origin: ConnectorOrigin
  enrollmentDigest: string
  savings: ConnectorCoin
  reserve: ConnectorCoin
  secondReserve?: ConnectorCoin
  hardwareSignatures?: string[]
  recipient: string
  amountSats: number
  feeSats: number
}) {
  if (connectorEnrollmentDigest(input.contract, input.origin) !== input.enrollmentDigest)
    throw new Error('connector enrollment pin mismatch')
  const phonePub = input.contract.phonePub
  const connectorPublicKey = input.origin.publicKey.slice()
  const connectorType = input.contract.connectorType
  const f = buildConnectorFamily(input.contract)
  const dual = input.contract.templateVersion === DUAL_CONNECTOR_TEMPLATE
  if (dual !== !!input.secondReserve) throw new Error('connector reserve count mismatch')
  const savingsIndex = dual ? 2 : 0
  const reserveIndices = dual ? [0, 1] : [1]
  const reserveAmount = dual ? 500n : 1000n
  const scripts = dual
    ? [f.connector.script, f.connector.script, f.savings.script]
    : [f.savings.script, f.connector.script]
  const coins = dual ? [input.reserve, input.secondReserve!, input.savings] : [input.savings, input.reserve]
  if (new Set(coins.map((coin) => `${coin.txid}:${coin.vout}`)).size !== coins.length)
    throw new Error('duplicate connector input')
  const tx = new Transaction(OPTIONS)
  const values: bigint[] = []
  const signingLeaf = f.savings.tapLeafScript?.find(
    ([, script]) => hex.encode(script.slice(0, -1)) === hex.encode(f.savings.normal),
  )
  if (!signingLeaf) throw new Error('normal signing leaf missing')
  const derivation: [Uint8Array, { hashes: Uint8Array[]; der: { fingerprint: number; path: number[] } }][] = [
    [
      input.origin.publicKey.slice(1),
      { hashes: [], der: { fingerprint: input.origin.fingerprint, path: [...input.origin.path] } },
    ],
  ]
  const connectorMetadata =
    input.contract.connectorType === 'p2tr'
      ? { tapInternalKey: input.origin.publicKey.slice(1), tapBip32Derivation: derivation }
      : {
          bip32Derivation: [
            [input.origin.publicKey.slice(), { fingerprint: input.origin.fingerprint, path: [...input.origin.path] }],
          ] as [Uint8Array, { fingerprint: number; path: number[] }][],
        }
  for (const [index, coin] of coins.entries()) {
    if (
      !/^[0-9a-f]{64}$/.test(coin.txid) ||
      !Number.isInteger(coin.vout) ||
      coin.vout < 0 ||
      coin.vout > 0xffffffff ||
      coin.parentHex.length > 2_000_000
    )
      throw new Error('invalid connector parent')
    const raw = hex.decode(coin.parentHex)
    const parent = Transaction.fromRaw(raw, OPTIONS)
    if (parent.id !== coin.txid) throw new Error('connector parent hash mismatch')
    const out = parent.getOutput(coin.vout)
    if (
      out.amount === undefined ||
      out.amount <= 0n ||
      out.amount > 2_100_000_000_000_000n ||
      !out.script ||
      hex.encode(out.script) !== hex.encode(scripts[index])
    )
      throw new Error('connector prevout mismatch')
    values.push(out.amount)
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: 0xfffffffd,
      nonWitnessUtxo: raw,
      witnessUtxo: { amount: out.amount, script: out.script },
      ...(index === savingsIndex
        ? { tapLeafScript: [signingLeaf], tapInternalKey: f.savings.tapInternalKey }
        : {
            ...connectorMetadata,
            ...(dual ? { sighashType: 3 } : input.contract.connectorType === 'p2wpkh' ? { sighashType: 1 } : {}),
          }),
    })
    // btc-signer 2.0.1's addInput omits allowUnknown when normalizing fields;
    // updateInput preserves the emulator parent field with OPTIONS above.
    tx.updateInput(index, { unknown: [[{ type: 222, key: new TextEncoder().encode('prevouttx') }, raw]] })
  }
  if (
    reserveIndices.some((i) => values[i] !== reserveAmount) ||
    values.reduce((sum, v) => sum + v, 0n) > 2_100_000_000_000_000n
  )
    throw new Error('invalid reserve or total value')
  const recipientScript = hex.decode(scriptHexFromAddress(input.recipient, input.contract.network))
  if (!['pkh', 'sh', 'wpkh', 'wsh', 'tr'].includes(OutScript.decode(recipientScript).type))
    throw new Error('unsupported Bitcoin payment script')
  const dust = bitcoinDustSats(input.recipient, input.contract.network)
  if (
    !Number.isSafeInteger(input.amountSats) ||
    input.amountSats < dust ||
    !Number.isSafeInteger(input.feeSats) ||
    input.feeSats < 0 ||
    input.feeSats > f.rules.absoluteFeeCapSats
  )
    throw new Error('invalid connector amount or fee')
  const change = values[savingsIndex] - BigInt(input.amountSats) - BigInt(input.feeSats) - 240n
  if (change < 0n || (change > 0n && change < 330n)) throw new Error('Savings change must be absent or non-dust')
  tx.addOutput({
    script: recipientScript,
    amount: BigInt(input.amountSats),
  })
  if (dual && change > 0n) tx.addOutput({ script: f.savings.script, amount: change })
  for (let i = 0; i < reserveIndices.length; i++)
    tx.addOutput({ script: f.connector.script, amount: reserveAmount, ...connectorMetadata })
  tx.addOutput({ script: hex.decode('51024e73'), amount: 240n })
  tx.addOutput({
    script: dual
      ? encodeExtensionScript([
          {
            type: 1,
            data: encodeEmulatorPacket({
              vin: savingsIndex,
              script: f.program,
              witness: connectorApprovalWitness(
                f.program,
                input.hardwareSignatures?.map((sig) => hex.decode(sig)),
                recipientScript,
                connectorType === 'p2wpkh' ? connectorPublicKey : undefined,
              ),
            }),
          },
        ])
      : emulatorPacketScript(f.program, false),
    amount: 0n,
  })
  if (!dual && change > 0n) tx.addOutput({ script: f.savings.script, amount: change })
  if (input.hardwareSignatures) {
    if (!dual || input.hardwareSignatures.length !== 2) throw new Error('unexpected hardware approval')
    input.hardwareSignatures.forEach((sig, i) =>
      tx.updateInput(i, {
        finalScriptWitness: connectorType === 'p2tr' ? [hex.decode(sig)] : [hex.decode(sig), connectorPublicKey],
      }),
    )
  }
  const unsigned = tx.unsignedTx
  const vbytes = Math.ceil((unsigned.length * 4 + f.rules.witnessBytes) / 4)
  if (input.feeSats > vbytes * f.rules.feerateCapSatPerV) throw new Error('connector feerate cap exceeded')
  const prepared = tx.toPSBT()
  function mergeResponse(
    responseText: string,
    completePSBT: Uint8Array,
    approvalUnsigned: Uint8Array,
    hardwareApprovalStage = false,
  ) {
    if (responseText.length > 4_000_000) throw new Error('signer response too large')
    const text = responseText.replace(/\s+/g, '')
    const raw = /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 ? hex.decode(text) : base64.decode(text)
    const isPSBT = hex.encode(raw.slice(0, 5)) === '70736274ff'
    const response = isPSBT ? Transaction.fromPSBT(raw, OPTIONS) : Transaction.fromRaw(raw, OPTIONS)
    const returnedUnsigned = hex.encode(response.unsignedTx)
    if (returnedUnsigned !== hex.encode(approvalUnsigned) && (!dual || returnedUnsigned !== hex.encode(unsigned)))
      throw new Error('hardware changed transaction')
    for (let i = 0; i < coins.length; i++) {
      const returned = response.getInput(i)
      // Core annotates even foreign unsigned inputs with its requested mode.
      // At the hardware-only stage, discard that hint with the rest of the
      // returned Savings map. The retained candidate still owns Savings signing.
      const unsignedSavingsHint =
        hardwareApprovalStage &&
        dual &&
        i === savingsIndex &&
        returned.sighashType === 3 &&
        !returned.tapKeySig &&
        !returned.tapScriptSig?.length &&
        !returned.partialSig?.length &&
        !returned.finalScriptWitness?.length
      if (
        !unsignedSavingsHint &&
        returned.sighashType !== undefined &&
        (i === savingsIndex
          ? returned.sighashType !== 0
          : dual
            ? returned.sighashType !== 3
            : returned.sighashType !== 0 && returned.sighashType !== 1)
      )
        throw new Error('connector signature sighash mismatch')
      if (returned.finalScriptSig?.length) throw new Error('unexpected scriptSig')
      if (
        returned.witnessUtxo &&
        (returned.witnessUtxo.amount !== values[i] ||
          hex.encode(returned.witnessUtxo.script) !== hex.encode(scripts[i]))
      )
        throw new Error('hardware changed prevout')
    }
    const result = Transaction.fromPSBT(completePSBT, OPTIONS)
    for (const reserveIndex of reserveIndices) {
      const approval = response.getInput(reserveIndex)
      if (approval.tapScriptSig?.length || approval.finalScriptSig?.length)
        throw new Error('unexpected connector signing path')
      let finalWitness = approval.finalScriptWitness
      if (connectorType === 'p2tr') {
        if (approval.partialSig?.length || (finalWitness && finalWitness.length !== 1))
          throw new Error('invalid Taproot witness')
        const sig = finalWitness?.[0] ?? approval.tapKeySig
        if (
          !sig ||
          (dual ? sig.length !== 65 || sig[64] !== 3 : sig.length !== 64 && (sig.length !== 65 || sig[64] !== 1)) ||
          (finalWitness && approval.tapKeySig && hex.encode(sig) !== hex.encode(approval.tapKeySig))
        )
          throw new Error('invalid Taproot signature encoding')
        const sighash = sig.length === 64 ? 0 : sig[64]
        if (approval.sighashType === 1 && sighash !== 1) throw new Error('signature sighash mismatch')
        if (
          !schnorr.verify(
            sig.slice(0, 64),
            tx.preimageWitnessV1(reserveIndex, scripts, sighash, values),
            f.connector.script.slice(2),
          )
        )
          throw new Error('invalid connector signature')
        finalWitness = [sig.slice()]
      } else {
        if (approval.tapKeySig || (approval.partialSig?.length ?? 0) > 1)
          throw new Error('unexpected connector signature')
        const partial = approval.partialSig?.[0]
        if (partial) {
          if (
            finalWitness &&
            (finalWitness.length !== 2 ||
              hex.encode(finalWitness[0]) !== hex.encode(partial[1]) ||
              hex.encode(finalWitness[1]) !== hex.encode(partial[0]))
          )
            throw new Error('conflicting connector signatures')
          finalWitness = [partial[1], partial[0]]
        }
        if (!finalWitness || finalWitness.length !== 2) throw new Error('native SegWit witness required')
        const [sig, pub] = finalWitness
        if (
          sig.length < 9 ||
          sig.length > 73 ||
          sig[sig.length - 1] !== (dual ? 3 : 1) ||
          hex.encode(pub) !== hex.encode(connectorPublicKey)
        )
          throw new Error('native SegWit ALL signature required')
        const scriptCode = new Uint8Array([0x76, 0xa9, 0x14, ...f.connector.script.slice(2), 0x88, 0xac])
        const message = tx.preimageWitnessV0(reserveIndex, scriptCode, dual ? 3 : 1, values[reserveIndex])
        if (!secp256k1.verify(sig.slice(0, -1), message, pub, { format: 'der', prehash: false, lowS: true }))
          throw new Error('invalid connector signature')
        finalWitness = finalWitness.map((item) => item.slice())
      }
      result.updateInput(reserveIndex, { finalScriptWitness: finalWitness })
    }
    return result
  }
  if (input.hardwareSignatures) mergeResponse(hex.encode(prepared), prepared, unsigned)
  function requireHardwareApproval() {
    if (dual && !input.hardwareSignatures) throw new Error('hardware approval required before Savings signatures')
  }
  function approvalPsbt() {
    if (!dual) throw new Error('hardware-first approval requires connector v2')
    const wire = RawPSBTV0.decode(prepared)
    wire.global.unsignedTx!.outputs.pop()
    wire.outputs.pop()
    delete wire.inputs[savingsIndex].finalScriptWitness
    delete wire.inputs[savingsIndex].finalScriptSig
    delete wire.inputs[savingsIndex].tapLeafScript
    delete wire.inputs[savingsIndex].tapInternalKey
    return RawPSBTV0.encode(wire)
  }
  // Only the expected phone signature may differ from the retained pristine
  // candidate. Comparing full PSBT maps also binds parent/origin metadata that
  // the unsigned transaction id alone does not commit.
  const verifyPhoneStage = (response: string): string => {
    requireHardwareApproval()
    if (response.length > 4_000_000) throw new Error('phone signing response too large')
    const wire = RawPSBTV0.decode(hex.decode(response))
    const signatures = wire.inputs[savingsIndex]?.tapScriptSig
    if (signatures?.length !== 1) throw new Error('exactly one phone signature required')
    const [[key, signature]] = signatures
    if (
      signature.length !== 64 ||
      hex.encode(key.pubKey) !== hex.encode(xOnlyFromCompressed(phonePub)) ||
      hex.encode(key.leafHash) !== hex.encode(tapLeafHash(f.savings.normal)) ||
      !schnorr.verify(
        signature,
        tx.preimageWitnessV1(savingsIndex, scripts, 0, values, -1, f.savings.normal),
        xOnlyFromCompressed(phonePub),
      )
    )
      throw new Error('invalid phone signature')
    delete wire.inputs[savingsIndex].tapScriptSig
    if (hex.encode(RawPSBTV0.encode(wire)) !== hex.encode(RawPSBTV0.encode(RawPSBTV0.decode(prepared))))
      throw new Error('phone changed connector candidate')
    wire.inputs[savingsIndex].tapScriptSig = signatures
    return hex.encode(RawPSBTV0.encode(wire))
  }
  return {
    psbt: () => hex.encode(prepared.slice()),
    hardwareApproval: () => hex.encode(approvalPsbt()),
    acceptHardwareApproval(response: string) {
      const approvalUnsigned = Transaction.fromPSBT(approvalPsbt(), OPTIONS).unsignedTx
      const accepted = mergeResponse(response, prepared, approvalUnsigned, true)
      return [0, 1].map((i) => hex.encode(accepted.getInput(i).finalScriptWitness![0]))
    },
    // The policy uses a lower witness bound for its ceiling. Fee estimation
    // instead allows a maximum-size ECDSA signature or Taproot ALL signature.
    estimatedVbytes: Math.ceil(
      (unsigned.length * 4 +
        f.rules.witnessBytes +
        (connectorType === 'p2wpkh' ? 64 * reserveIndices.length : dual ? 0 : 1)) /
        4,
    ),
    verifyPhoneStage,
    signPhone(privateKey: Uint8Array) {
      requireHardwareApproval()
      const phone = Transaction.fromPSBT(prepared, OPTIONS)
      phone.signIdx(privateKey, savingsIndex, [0])
      return verifyPhoneStage(hex.encode(phone.toPSBT()))
    },
    forHardware(witness: Uint8Array[]) {
      requireHardwareApproval()
      if (
        witness.length !== 5 ||
        witness.slice(0, 3).some((sig) => sig.length !== 64) ||
        hex.encode(witness[3]) !== hex.encode(f.savings.normal) ||
        hex.encode(witness[4]) !== hex.encode(f.savings.control)
      )
        throw new Error('invalid Savings witness')
      const message = tx.preimageWitnessV1(savingsIndex, scripts, 0, values, -1, f.savings.normal)
      const pubs = [f.normalTweaks.arkade, f.normalTweaks.vault, phonePub].map(xOnlyFromCompressed)
      if (pubs.some((pub, i) => !schnorr.verify(witness[i], message, pub))) throw new Error('invalid Savings signature')
      const savedWitness = witness.map((item) => item.slice())
      const hardware = Transaction.fromPSBT(prepared, OPTIONS)
      if (!dual)
        hardware.updateInput(savingsIndex, {
          finalScriptWitness: savedWitness,
          finalScriptSig: new Uint8Array(),
          tapLeafScript: undefined,
          tapInternalKey: undefined,
        })
      // Electrum requires both final fields for a foreign witness input.
      // Transaction.toPSBT strips empty scriptSig, so retain it in the wire map.
      const finalized = RawPSBTV0.decode(hardware.toPSBT())
      if (dual) {
        finalized.inputs[savingsIndex].finalScriptWitness = savedWitness
        delete finalized.inputs[savingsIndex].tapLeafScript
        delete finalized.inputs[savingsIndex].tapInternalKey
      }
      finalized.inputs[savingsIndex].finalScriptSig = new Uint8Array()
      const completePSBT = RawPSBTV0.encode(finalized)
      if (dual) {
        // SINGLE commits to output 0/1. Omit the last, zero-value program
        // output from the device view; no monetary output moves or changes.
        finalized.global.unsignedTx!.outputs.pop()
        finalized.outputs.pop()
        delete finalized.inputs[savingsIndex].finalScriptWitness
        delete finalized.inputs[savingsIndex].finalScriptSig
      }
      const hardwarePSBT = RawPSBTV0.encode(finalized)
      const approvalUnsigned = Transaction.fromPSBT(hardwarePSBT, OPTIONS).unsignedTx
      return {
        psbt: () => hex.encode(hardwarePSBT.slice()),
        accept(responseText: string) {
          const result = mergeResponse(responseText, completePSBT, approvalUnsigned)
          return { txHex: hex.encode(result.extract()), txid: result.id }
        },
      }
    },
  }
}
