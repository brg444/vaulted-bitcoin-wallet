import { compressRecoveryData as transform } from '../recovery/compression'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { lightDescriptorDigest } from './contract'
import { validateLightEnrollment, type LightEnrollment } from './enrollment'
import { validateLightRecoveryFile, type LightRecoveryFile } from './recovery'
import { unlockLightWithPasskey } from './passkey'

export const MAX_LIGHT_BACKUP_BYTES = 3_000_000
const MAX_PLAIN_BYTES = 13_000_000
const encoder = new TextEncoder()
export interface LightEncryptedBackup {
  name: 'vaulted-light-backup'
  version: 2
  header: LightEnrollment & { origin: string; rpId: string }
  nonce: string
  ciphertext: string
}
// A non-extractable, backup-only key can update archives during the unlocked
// session without retaining the Bitcoin signing scalar or asking for Face ID.
export async function lightBackupKey(owner: Uint8Array, record: LightEnrollment): Promise<CryptoKey> {
  const valid = validateLightEnrollment(record)
  if (owner.length !== 32 || hex.encode(schnorr.getPublicKey(owner)) !== valid.descriptor.ownerPub)
    throw new Error('Backup key does not belong to this wallet')
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(owner), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Uint8Array.from(hex.decode(lightDescriptorDigest(valid.descriptor))),
      info: encoder.encode('vaulted-light/full-recovery-backup/v2'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
function aad(header: LightEncryptedBackup['header']) {
  return encoder.encode(
    JSON.stringify({
      name: 'vaulted-light-backup',
      version: 2,
      header: { ...validateLightEnrollment(header), origin: header.origin, rpId: header.rpId },
    }),
  )
}
export function parseLightEncryptedBackup(value: unknown): LightEncryptedBackup {
  if (!value || typeof value !== 'object') throw new Error('Encrypted Light backup required')
  const file = value as LightEncryptedBackup
  if (
    JSON.stringify(value).length > MAX_LIGHT_BACKUP_BYTES ||
    file.name !== 'vaulted-light-backup' ||
    file.version !== 2 ||
    Object.keys(file).length !== 5 ||
    !/^[0-9a-f]{24}$/.test(file.nonce) ||
    typeof file.ciphertext !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(file.ciphertext)
  )
    throw new Error('Invalid encrypted Light backup')
  const record = validateLightEnrollment(file.header)
  const { origin, rpId } = file.header
  if (
    typeof origin !== 'string' ||
    typeof rpId !== 'string' ||
    new URL(origin).origin !== origin ||
    new URL(origin).hostname !== rpId
  )
    throw new Error('Invalid backup passkey origin')
  const header = { ...record, origin, rpId }
  return { name: file.name, version: file.version, header, nonce: file.nonce, ciphertext: file.ciphertext }
}
export async function encryptLightBackup(file: LightRecoveryFile, key: CryptoKey): Promise<LightEncryptedBackup> {
  const valid = validateLightRecoveryFile(file)
  if (!valid.archive) throw new Error('Complete transaction recovery data is required before backing up')
  const header = { ...validateLightEnrollment(valid), origin: location.origin, rpId: location.hostname }
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plain = encoder.encode(JSON.stringify(valid))
  if (plain.length > MAX_PLAIN_BYTES) throw new Error('Recovery archive is too large')
  const compressed = await transform(plain, false)
  try {
    const ciphertext = base64.encode(
      new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(header) }, key, compressed),
      ),
    )
    return parseLightEncryptedBackup({
      name: 'vaulted-light-backup',
      version: 2,
      header,
      nonce: hex.encode(nonce),
      ciphertext,
    })
  } finally {
    plain.fill(0)
    compressed.fill(0)
  }
}
export async function decryptLightBackup(value: unknown, key: CryptoKey): Promise<LightRecoveryFile> {
  const file = parseLightEncryptedBackup(value)
  const compressed = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(hex.decode(file.nonce)), additionalData: aad(file.header) },
      key,
      Uint8Array.from(base64.decode(file.ciphertext)),
    ),
  )
  let plain: Uint8Array | undefined
  try {
    plain = await transform(compressed, true)
    const decoded = validateLightRecoveryFile(JSON.parse(new TextDecoder().decode(plain)))
    if (
      !decoded.archive ||
      JSON.stringify(validateLightEnrollment(decoded)) !== JSON.stringify(validateLightEnrollment(file.header))
    )
      throw new Error('Recovery backup identity or transaction data changed')
    return decoded
  } finally {
    compressed.fill(0)
    plain?.fill(0)
  }
}
export async function openLocalLightBackup(
  value: unknown,
  withOwner?: (owner: Uint8Array, record: LightEnrollment) => Promise<unknown>,
) {
  const encrypted = parseLightEncryptedBackup(value)
  if (location.origin !== encrypted.header.origin || location.hostname !== encrypted.header.rpId)
    throw new Error(`Open recovery at ${encrypted.header.origin} to use this wallet’s passkey`)
  const owner = await unlockLightWithPasskey(encrypted.header)
  try {
    const key = await lightBackupKey(owner, encrypted.header)
    const file = await decryptLightBackup(encrypted, key)
    if (withOwner) await withOwner(owner, validateLightEnrollment(file))
    return { file, key }
  } finally {
    owner.fill(0)
  }
}
