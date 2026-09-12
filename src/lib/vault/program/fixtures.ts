import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'

export function compressedFromScalar(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error('scalar out of range')
  const secret = new Uint8Array(32)
  secret[31] = n
  return hex.encode(secp256k1.getPublicKey(secret, true))
}

export function scalarSecret(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error('scalar out of range')
  const secret = new Uint8Array(32)
  secret[31] = n
  return secret
}

/** NIST P-256 sample from the program conformance fixture. Not a secp256k1 key. */
export const FIXTURE_PHONE_DIRECT_P256 = '02c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721'

export const FIXTURE_IDENTITIES = {
  vaultId: 'aabbccddeeff00112233445566778899',
  phonePub: compressedFromScalar(3),
  hardwarePub: compressedFromScalar(4),
  recoveryPub: compressedFromScalar(5),
  phoneDirectP256: FIXTURE_PHONE_DIRECT_P256,
  vaultCosignerBase: compressedFromScalar(14),
  arkadeCosignerBase: compressedFromScalar(15),
  arkadeCosigner: {
    origin: 'https://operator.example',
    version: 'savings-v1-fixture',
  },
}
