import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, requireLowerHex } from '../hex'
import { ROLLING_PROGRAM } from './allowance'

/** Companion device proof for the exact retained allowance transaction. */
export function rollingAuthorizationDigest(vaultId: string, contractScript: string, operationId: string): Uint8Array {
  const encoder = new TextEncoder()
  const vault = encoder.encode(vaultId)
  if (vault.length === 0 || vault.length > 1024 || new TextDecoder().decode(vault) !== vaultId)
    throw new Error('Invalid rolling vault identity')
  const script = hexToBytes(requireLowerHex(contractScript, 'contract script', 34))
  if (!contractScript.startsWith('5120')) throw new Error('Taproot rolling contract required')
  const id = hexToBytes(requireLowerHex(operationId, 'operation ID', 32)).reverse()
  const domain = encoder.encode(`${ROLLING_PROGRAM}\0authorize\0`)
  const message = new Uint8Array(domain.length + 4 + vault.length + script.length + id.length)
  message.set(domain)
  new DataView(message.buffer).setUint32(domain.length, vault.length, true)
  let offset = domain.length + 4
  for (const part of [vault, script, id]) {
    message.set(part, offset)
    offset += part.length
  }
  return sha256(message)
}
