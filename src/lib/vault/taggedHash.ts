import { sha256 } from '@noble/hashes/sha2.js'
import { encodeUtf8 } from './hex'

export function taggedHash(tag: string, ...messages: Uint8Array[]): Uint8Array {
  const tagH = sha256(encodeUtf8(tag))
  const prefix = new Uint8Array(64)
  prefix.set(tagH, 0)
  prefix.set(tagH, 32)
  const total = messages.reduce((n, m) => n + m.length, 64)
  const out = new Uint8Array(total)
  out.set(prefix)
  let offset = 64
  for (const msg of messages) {
    out.set(msg, offset)
    offset += msg.length
  }
  return sha256(out)
}
