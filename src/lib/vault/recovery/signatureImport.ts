import { Transaction } from '@arkade-os/sdk'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { requireExactDefaultTapscriptSignatures, tapscriptSignatureRecords } from '../taprootSignatures'

export function recoveryPsbtBytes(raw: string) {
  const value = raw.trim()
  if (value.length > 10_000_000) throw new Error('Signing response is too large')
  return /^[0-9a-f]+$/i.test(value) ? hex.decode(value) : base64.decode(value)
}
/** A signing device may add signatures only; all requested inputs, outputs and metadata stay exact. */
export function acceptRecoveryPsbtSignatures(request: string, response: string, allowedKeys: string[]): string {
  const before = Transaction.fromPSBT(recoveryPsbtBytes(request), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  })
  const after = Transaction.fromPSBT(recoveryPsbtBytes(response), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  })
  if (before.inputsLength !== after.inputsLength) throw new Error('Signing response changed the input count')
  const scripts = Array.from({ length: before.inputsLength }, (_, i) => {
    const coin = before.getInput(i).witnessUtxo
    if (!coin) throw new Error('Signing request is missing a prevout')
    return coin.script
  })
  const amounts = Array.from({ length: before.inputsLength }, (_, i) => before.getInput(i).witnessUtxo!.amount)
  const allowed = allowedKeys.map((pub) => (pub.length === 66 ? pub.slice(2) : pub))
  let added = false
  for (let i = 0; i < before.inputsLength; i++) {
    const old = before.getInput(i),
      next = after.getInput(i)
    if (next.sighashType !== undefined && next.sighashType !== 0)
      throw new Error('Recovery signing requires SIGHASH_DEFAULT')
    if (next.tapScriptSig?.length) {
      const pubs = next.tapScriptSig.map(([key]) => hex.encode(key.pubKey))
      if (pubs.some((pub) => !allowed.includes(pub))) throw new Error('An unexpected key signed recovery')
      requireExactDefaultTapscriptSignatures(after, i, pubs)
      if (tapscriptSignatureRecords(before, i).some((record) => !tapscriptSignatureRecords(after, i).includes(record)))
        throw new Error('A prior signature was removed')
      added ||= next.tapScriptSig.length > (old.tapScriptSig?.length || 0)
      before.updateInput(i, { tapScriptSig: next.tapScriptSig })
    }
    if (next.tapKeySig) {
      if (
        old.tapLeafScript?.length ||
        scripts[i].length !== 34 ||
        scripts[i][0] !== 0x51 ||
        next.tapKeySig.length !== 64 ||
        !schnorr.verify(next.tapKeySig, after.preimageWitnessV1(i, scripts, 0, amounts), scripts[i].slice(2))
      )
        throw new Error('Invalid fee funding signature')
      if (old.tapKeySig && hex.encode(old.tapKeySig) !== hex.encode(next.tapKeySig))
        throw new Error('A prior signature changed')
      added ||= !old.tapKeySig
      before.updateInput(i, { tapKeySig: next.tapKeySig })
    }
  }
  if (!added) throw new Error('The signing response added no signature')
  if (hex.encode(before.toPSBT()) !== hex.encode(after.toPSBT()))
    throw new Error('Signing response changed the recovery request')
  return hex.encode(after.toPSBT())
}

export function recoveryPsbtHasAllSignatures(psbt: string, requiredKeys: string[]) {
  const tx = Transaction.fromPSBT(recoveryPsbtBytes(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const keys = requiredKeys.map((pub) => (pub.length === 66 ? pub.slice(2) : pub))
  let signed = false
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (input.tapLeafScript?.length) {
      const pubs = (input.tapScriptSig || []).map(([key]) => hex.encode(key.pubKey))
      if (!keys.every((key) => pubs.includes(key))) return false
      requireExactDefaultTapscriptSignatures(tx, i, keys)
      signed = true
    } else if (input.witnessUtxo?.script.length === 34 && input.witnessUtxo.script[0] === 0x51) {
      if (!input.tapKeySig) return false
      signed = true
    }
  }
  return signed
}
