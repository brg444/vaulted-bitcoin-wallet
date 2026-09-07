import { describe, expect, it } from 'vitest'
import { HDKey } from '@scure/bip32'
import { UR, UREncoder } from '@ngraveio/bc-ur'
import { encode } from 'cborg'
import { Buffer } from 'buffer'
import { DescriptorQrDecoder } from './descriptorQr'
import { importDescriptorText, readDescriptorFile } from './descriptorImport'
import { importConnectorOrigin } from './program/connectorOrigin'

const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(73))
const account = root.derive("m/84'/0'/0'")
const fp = root.fingerprint.toString(16).padStart(8, '0')
const descriptor = `wpkh([${fp}/84'/0'/0']${account.publicExtendedKey}/0/*)`
const change = descriptor.replace('/0/*)', '/1/*)')
const multi = descriptor.replace('/0/*)', '/<0;1>/*)')
function outputCbor(privateKey = false, purpose = 84) {
  const node = root.derive(`m/${purpose}'/0'/0'`)
  const origin = encode(
    new Map([
      [1, [purpose, true, 0, true, 0, true]],
      [2, root.fingerprint],
      [3, 3],
    ] as [number, unknown][]),
  )
  // Tags 404/409 (script), 303 (public HD key), and 304 (origin keypath).
  const keyPrefix = encode(
    new Map<number, unknown>([
      [2, privateKey],
      [3, node.publicKey],
      [4, node.chainCode],
      [8, node.parentFingerprint],
    ]),
  )
  return Buffer.from([
    0xd9,
    0x01,
    purpose === 84 ? 0x94 : 0x99,
    0xd9,
    0x01,
    0x2f,
    0xa5,
    ...keyPrefix.slice(1),
    6,
    0xd9,
    0x01,
    0x30,
    ...origin,
  ])
}
function frames(cbor = outputCbor()) {
  const encoder = new UREncoder(new UR(cbor, 'crypto-output'), 30)
  return Array.from({ length: encoder.fragmentsLength }, () => encoder.nextPart())
}

describe('public descriptor imports', () => {
  it('reads a wallet export containing comments, receive, change, and multipath descriptors', () => {
    expect(
      importDescriptorText(
        `# Receive and change descriptor:\n${multi}\n\n# Receive descriptor:\n${descriptor}\n# Change descriptor:\n${change}`,
        'mainnet',
      ),
    ).toBe(multi)
  })
  it('reads plain and JSON descriptors', () => {
    expect(importDescriptorText(descriptor, 'mainnet')).toBe(descriptor)
    expect(importDescriptorText(JSON.stringify({ descriptor }), 'mainnet')).toBe(descriptor)
  })
  it('rejects private keys, wrong networks, ambiguous wallets, and oversized files', async () => {
    expect(() =>
      importDescriptorText(descriptor.replace(account.publicExtendedKey, account.privateExtendedKey), 'mainnet'),
    ).toThrow()
    expect(() => importDescriptorText(descriptor, 'mutinynet')).toThrow()
    expect(() => importDescriptorText(`${descriptor}\n${descriptor.replace('/0/*)', '/0/2)')}`, 'mainnet')).toThrow(
      /multiple wallets/,
    )
    await expect(readDescriptorFile(new File(['x'.repeat(16385)], 'descriptor.txt'), 'mainnet')).rejects.toThrow(
      /too large/,
    )
  })
  it('decodes plain-text and byte-wrapped QR descriptors', () => {
    expect(new DescriptorQrDecoder('mainnet').receive(descriptor).descriptor).toBe(descriptor)
    const ur = new UREncoder(UR.fromBuffer(globalThis.Buffer.from(descriptor)), 1000).nextPart()
    expect(new DescriptorQrDecoder('mainnet').receive(ur).descriptor).toBe(descriptor)
  })
  it.each([84, 86])('decodes an animated public account QR with purpose %s', (purpose) => {
    const decoder = new DescriptorQrDecoder('mainnet')
    const parts = frames(outputCbor(false, purpose))
    const initial = decoder.receive(parts.at(-1)!.toUpperCase())
    expect(initial.descriptor).toBeUndefined()
    expect(decoder.receive(parts.at(-1)!)).toEqual(initial)
    let result = initial
    for (const part of parts.slice(0, -1).reverse()) result = decoder.receive(part)
    expect(result.descriptor).toBeTruthy()
    const expected = `${purpose === 84 ? 'wpkh' : 'tr'}([${fp}/${purpose}'/0'/0']${root.derive(`m/${purpose}'/0'/0'`).publicExtendedKey}/0/*)`
    expect(importConnectorOrigin(result.descriptor!, 'mainnet')).toEqual(importConnectorOrigin(expected, 'mainnet'))
  })
  it('rejects private account QR, unsupported types and excessive fountain sizes', () => {
    const privateQr = new UREncoder(new UR(outputCbor(true), 'crypto-output'), 1000).nextPart()
    expect(() => new DescriptorQrDecoder('mainnet').receive(privateQr)).toThrow(/public/)
    expect(() => new DescriptorQrDecoder('mainnet').receive('ur:crypto-psbt/aaaa')).toThrow()
    const oversized = new UREncoder(
      new UR(Buffer.from(encode([1, 9999999, 100, 1, new Uint8Array(10)])), 'bytes'),
      1000,
    )
      .nextPart()
      .split('/')
      .at(-1)
    expect(() => new DescriptorQrDecoder('mainnet').receive(`ur:crypto-output/1-9999999/${oversized}`)).toThrow()
  })
})
