import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { parseIncomingPsbt } from './savingsSpend'

// File decoding only. The retained connector candidate and signatures are
// checked by completeConnectorWithdrawal before any broadcast.
export async function readConnectorSignerFile(file: Blob): Promise<string> {
  if (file.size < 1 || file.size > 1_000_000) throw new Error('Signer file must be smaller than 1 MB')
  const buffer =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('Could not read signer file'))
          reader.onload = () =>
            reader.result instanceof ArrayBuffer
              ? resolve(reader.result)
              : reject(new Error('Could not read signer file'))
          reader.readAsArrayBuffer(file)
        })
  const bytes = new Uint8Array(buffer)
  const binary = hex.encode(bytes)
  const options = { allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }
  if (binary.startsWith('70736274ff')) {
    Transaction.fromPSBT(bytes, options)
    return binary
  }
  const decoded = parseIncomingPsbt(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (decoded.startsWith('70736274ff')) Transaction.fromPSBT(hex.decode(decoded), options)
  else Transaction.fromRaw(hex.decode(decoded), options)
  return decoded
}
