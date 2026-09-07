import { importConnectorOrigin, type ConnectorOriginNetwork } from './program/connectorOrigin'

export const MAX_DESCRIPTOR_FILE_BYTES = 16_384

export function importDescriptorText(raw: string, network: ConnectorOriginNetwork): string {
  if (raw.length > MAX_DESCRIPTOR_FILE_BYTES) throw new Error('Descriptor file is too large.')
  const text = raw.replace(/^\uFEFF/, '').trim()
  let candidates: unknown[]
  if (text.startsWith('{')) {
    const json = JSON.parse(text)
    candidates = Array.isArray(json.descriptors)
      ? json.descriptors.map((item: { desc?: string }) => item.desc)
      : [json.descriptor ?? json.desc]
  } else
    candidates = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  if (!candidates.length || candidates.length > 32) throw new Error('Upload a public output descriptor file.')
  const imported = candidates.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error('Upload a public output descriptor file.')
    return { descriptor: candidate, origin: importConnectorOrigin(candidate, network) }
  })
  // Export files may contain multipath, receive, and change versions of one wallet.
  // Prefer the receive branch, but never silently pick between different wallets.
  const receiving = imported.filter(({ origin }) => origin.path.at(-2) === 0)
  const choices = receiving.length ? receiving : imported
  if (new Set(choices.map(({ origin }) => origin.publicKey)).size !== 1) {
    throw new Error('This file contains multiple wallets. Export one wallet’s public descriptor.')
  }
  return choices[0].descriptor
}

export async function readDescriptorFile(file: File, network: ConnectorOriginNetwork): Promise<string> {
  if (file.size > MAX_DESCRIPTOR_FILE_BYTES) throw new Error('Descriptor file is too large.')
  return importDescriptorText(await file.text(), network)
}
