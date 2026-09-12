import { describe, expect, it } from 'vitest'
import { extractRecoveryKitJson } from './fileImport'

function storedArchive(entries: { name: string; text: string; method?: number }[]) {
  const parts = entries.map(({ name, text, method = 0 }) => {
    const filename = new TextEncoder().encode(name)
    const body = new TextEncoder().encode(text)
    const bytes = new Uint8Array(30 + filename.length + body.length)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(8, method, true)
    view.setUint32(18, body.length, true)
    view.setUint32(22, body.length, true)
    view.setUint16(26, filename.length, true)
    bytes.set(filename, 30)
    bytes.set(body, 30 + filename.length)
    return bytes
  })
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

describe('recovery file import', () => {
  const json = '{"name":"arkade-recovery-kit","version":5}'

  it('reads JSON bytes without selecting or validating an account program', () => {
    expect(extractRecoveryKitJson(new TextEncoder().encode('\uFEFF  ' + json + '\n'))).toBe(json)
  })

  it('finds the saved JSON entry after the guide, including a nested archive path', () => {
    const archive = storedArchive([
      { name: 'How to recover.txt', text: 'Saved instructions' },
      { name: 'Vaulted/Recovery Kit.json', text: json },
    ])
    const padded = new Uint8Array(archive.length + 7)
    padded.set(archive, 7)
    expect(extractRecoveryKitJson(padded.subarray(7))).toBe(json)
  })

  it('rejects empty, unrelated, compressed and missing-kit files', () => {
    for (const bytes of [
      new Uint8Array(),
      new TextEncoder().encode('not a recovery file'),
      storedArchive([{ name: 'Recovery Kit.json', text: json, method: 8 }]),
      storedArchive([{ name: 'Recovery Kit.json', text: 'not JSON' }]),
      storedArchive([{ name: 'Read me.txt', text: 'No recovery data' }]),
    ])
      expect(() => extractRecoveryKitJson(bytes)).toThrow()
  })
})
