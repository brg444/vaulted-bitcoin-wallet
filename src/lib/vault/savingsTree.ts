import { hex } from '@scure/base'
import type { TransactionInput } from '@scure/btc-signer/psbt.js'
import { hexToBytes } from './hex'

// BIP341 NUMS, same internal key ark-lib UnspendableKey uses.
export const TAPROOT_NUMS_XONLY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const OP_CHECKSIG = 0xac
const OP_CHECKSIGVERIFY = 0xad
const OP_CSV = 0xb2
const OP_DROP = 0x75
const OP_0 = 0x00
const OP_1 = 0x51

export function xOnlyFromCompressed(pub: string): Uint8Array {
  const raw = hexToBytes(pub)
  if (raw.length === 32) return raw
  if (raw.length === 33 && (raw[0] === 0x02 || raw[0] === 0x03)) return raw.slice(1)
  throw new Error('expected a compressed or x-only secp256k1 key')
}

export function encodeScriptInt(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error('script integer out of range')
  }
  if (value === 0) return new Uint8Array([OP_0])
  if (value <= 16) return new Uint8Array([OP_1 + value - 1])
  const bytes: number[] = []
  let n = value
  while (n > 0) {
    bytes.push(n & 0xff)
    n >>= 8
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0)
  return new Uint8Array([bytes.length, ...bytes])
}

export function checksigScript(pubs: Uint8Array[]): Uint8Array {
  if (pubs.length === 0) throw new Error('at least one key')
  const parts: number[] = []
  pubs.forEach((pub, i) => {
    if (pub.length !== 32) throw new Error('x-only key required')
    parts.push(0x20, ...pub)
    parts.push(i === pubs.length - 1 ? OP_CHECKSIG : OP_CHECKSIGVERIFY)
  })
  return new Uint8Array(parts)
}

export function csvChecksigScript(blocks: number, pub: Uint8Array): Uint8Array {
  const lock = encodeScriptInt(blocks)
  const key = checksigScript([pub])
  return new Uint8Array([...lock, OP_CSV, OP_DROP, ...key])
}

type ScriptLeaf = { script: Uint8Array }

/** Pairing matches btcd AssembleTaprootScriptTree. */
export function tapTreeFromScripts(scripts: Uint8Array[]): ScriptLeaf | ScriptLeaf[] {
  if (scripts.length === 0) throw new Error('no leaves')
  if (scripts.length === 1) return { script: scripts[0] }
  const leaves: ScriptLeaf[] = scripts.map((script) => ({ script }))
  const branches: unknown[] = []
  for (let i = 0; i < leaves.length; i += 2) {
    if (i === leaves.length - 1) {
      branches[branches.length - 1] = [branches[branches.length - 1], leaves[i]]
      continue
    }
    branches.push([leaves[i], leaves[i + 1]])
  }
  while (branches.length > 1) {
    const left = branches.shift()
    const right = branches.shift()
    branches.push([left, right])
  }
  return branches[0] as ScriptLeaf[]
}

export function tapLeafForScript(
  tapLeafScript: TransactionInput['tapLeafScript'],
  script: Uint8Array,
): NonNullable<TransactionInput['tapLeafScript']>[number] {
  const leaf = tapLeafScript?.find((entry) => hex.encode(entry[1].slice(0, -1)) === hex.encode(script))
  if (!leaf) throw new Error('tap leaf missing from tree')
  return leaf
}
