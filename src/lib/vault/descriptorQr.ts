import './descriptorQrRuntime'
import { Buffer } from 'buffer'
import { URDecoder } from '@ngraveio/bc-ur'
import { decode } from 'cborg'
import { HDKey } from '@scure/bip32'
import { importDescriptorText, MAX_DESCRIPTOR_FILE_BYTES } from './descriptorImport'
import type { ConnectorOriginNetwork } from './program/connectorOrigin'

type Tagged = { tag: number; value: unknown }
const invalid = () => new Error('Scan a public wallet descriptor QR code, or upload its descriptor file.')
const uint = (value: unknown, max = 0xffffffff): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid()
  return value
}
function tagged(value: unknown, tag: number): unknown {
  if (!value || typeof value !== 'object' || !('tag' in value) || value.tag !== tag) throw invalid()
  return (value as Tagged).value
}
function map(value: unknown): Map<number, unknown> {
  if (!(value instanceof Map)) throw invalid()
  return value
}
function bytes(value: unknown, size: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== size) throw invalid()
  return value
}
function cbor(raw: Uint8Array): unknown {
  if (raw.length > MAX_DESCRIPTOR_FILE_BYTES) throw invalid()
  const tags = Object.fromEntries(
    [303, 304, 305, 404, 409].map((tag) => [tag, (content: () => unknown) => ({ tag, value: content() })]),
  )
  return decode(Uint8Array.from(raw), {
    useMaps: true,
    rejectDuplicateMapKeys: true,
    allowIndefinite: false,
    allowBigInt: false,
    tags,
  })
}
function path(value: unknown, wildcard = false): string[] {
  const components = map(tagged(value, 304)).get(1)
  if (!Array.isArray(components) || components.length % 2 || components.length > 20) throw invalid()
  const result: string[] = []
  for (let i = 0; i < components.length; i += 2) {
    const step = components[i]
    const hardened = components[i + 1]
    if (typeof hardened !== 'boolean') throw invalid()
    if (Array.isArray(step) && !step.length && wildcard && !hardened) result.push('*')
    else result.push(`${uint(step, 0x7fffffff)}${hardened ? "'" : ''}`)
  }
  return result
}
function outputDescriptor(raw: Uint8Array, network: ConnectorOriginNetwork): string {
  const output = cbor(raw) as Tagged
  if (!output || ![404, 409].includes(output.tag)) throw invalid()
  const key = map(tagged(output.value, 303))
  if (key.get(1) || key.get(2)) throw new Error('Only public descriptors are accepted. Never scan private keys.')
  const origin = map(tagged(key.get(6), 304))
  const steps = path(key.get(6))
  if (!steps.length) throw invalid()
  const info = key.has(5) ? map(tagged(key.get(5), 305)) : new Map()
  if ((info.get(1) ?? 0) !== 0 || (info.get(2) ?? 0) !== (network === 'mainnet' ? 0 : 1)) throw invalid()
  if (origin.has(3) && origin.get(3) !== steps.length) throw invalid()
  const last = steps.at(-1)!
  const node = new HDKey({
    publicKey: bytes(key.get(3), 33),
    chainCode: bytes(key.get(4), 32),
    depth: steps.length,
    index: Number.parseInt(last) + (last.endsWith("'") ? 0x80000000 : 0),
    parentFingerprint: uint(key.get(8) ?? 0),
    versions:
      network === 'mainnet' ? { public: 0x0488b21e, private: 0x0488ade4 } : { public: 0x043587cf, private: 0x04358394 },
  })
  // Account QR exports commonly omit children; use the standard receive branch.
  // The existing descriptor validator still requires a supported complete path.
  const children = key.has(7) ? path(key.get(7), true) : ['0', '*']
  const fingerprint = uint(origin.get(2)).toString(16).padStart(8, '0')
  return `${output.tag === 404 ? 'wpkh' : 'tr'}([${fingerprint}/${steps.join('/')}]${node.publicExtendedKey}/${children.join('/')})`
}

export class DescriptorQrDecoder {
  private decoder = new URDecoder()
  private frames = new Set<string>()
  constructor(private network: ConnectorOriginNetwork) {}
  receive(raw: string): { descriptor?: string; progress: number } {
    const text = raw.trim()
    if (text.length > 8192) throw invalid()
    if (!/^ur:/i.test(text)) return { descriptor: importDescriptorText(text, this.network), progress: 1 }
    const parts = text.toLowerCase().split('/')
    if (!['ur:crypto-output', 'ur:bytes'].includes(parts[0]) || ![2, 3].includes(parts.length)) throw invalid()
    // Decode Bytewords first, then bound and validate CBOR before the fountain codec.
    const body = URDecoder.decode(`${parts[0]}/${parts.at(-1)}`).cbor
    const decoded = cbor(body)
    if (parts.length === 3) {
      if (!Array.isArray(decoded) || decoded.length !== 5) throw invalid()
      const [seq, count, length, checksum, fragment] = decoded
      uint(seq, 10000)
      uint(count, 128)
      uint(length, MAX_DESCRIPTOR_FILE_BYTES)
      uint(checksum)
      if (
        !seq ||
        !count ||
        !length ||
        parts[1] !== `${seq}-${count}` ||
        !(fragment instanceof Uint8Array) ||
        !fragment.length ||
        fragment.length > 2048 ||
        fragment.length * count > 32768 ||
        length > fragment.length * count
      )
        throw invalid()
    }
    if (!this.frames.has(text.toLowerCase())) {
      if (this.frames.size >= 1024) throw invalid()
      this.frames.add(text.toLowerCase())
      this.decoder.receivePart(text)
    }
    if (this.decoder.isError()) throw invalid()
    if (!this.decoder.isComplete()) return { progress: this.decoder.estimatedPercentComplete() }
    const result = this.decoder.resultUR()
    const descriptor =
      result.type === 'crypto-output'
        ? outputDescriptor(result.cbor, this.network)
        : Buffer.from(cbor(result.cbor) as Uint8Array).toString('utf8')
    return { descriptor: importDescriptorText(descriptor, this.network), progress: 1 }
  }
}
