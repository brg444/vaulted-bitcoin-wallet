export function extractRecoveryKitJson(bytes: Uint8Array): string {
  if (!bytes.length) throw new Error('That file is empty')
  const asJson = jsonIfLooksLikeKit(bytes)
  if (asJson) return asJson
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Choose Recovery Kit.json or the zip you saved from Vaulted')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 30 <= bytes.length) {
    const signature = view.getUint32(offset, true)
    if (signature !== 0x04034b50) break
    const method = view.getUint16(offset + 8, true)
    const compressed = view.getUint32(offset + 18, true)
    const uncompressed = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const dataStart = nameStart + nameLength + extraLength
    const size = method === 0 ? uncompressed : compressed
    const data = bytes.subarray(dataStart, dataStart + size)
    if (isKitJsonName(name)) {
      if (method !== 0) throw new Error('Open the zip, then choose Recovery Kit.json')
      const json = jsonIfLooksLikeKit(data)
      if (!json) throw new Error('That zip does not contain a Recovery Kit')
      return json
    }
    offset = dataStart + size
  }
  throw new Error('That zip does not contain Recovery Kit.json')
}

function jsonIfLooksLikeKit(bytes: Uint8Array): string | null {
  const text = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trim()
  return text.startsWith('{') ? text : null
}

function isKitJsonName(name: string): boolean {
  const base = name.split('/').pop() || name
  return base === 'Recovery Kit.json' || base.toLowerCase() === 'recovery kit.json'
}
