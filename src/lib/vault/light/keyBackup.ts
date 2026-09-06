import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { lightDescriptorDigest, validateLightDescriptor, type LightDescriptor } from './contract'

export type LightBackupPurpose = 'passkey-prf' | 'recovery-secret'
const NAME = 'vaulted-light-owner-key' as const
const VERSION = 1 as const
const DOMAIN = 'vaulted-light/owner-key-encryption/v1'

// This is encrypted owner-key material, not a complete VTXO exit/recovery kit.
export interface LightKeyBackup {
  name: typeof NAME
  version: typeof VERSION
  purpose: LightBackupPurpose
  descriptorDigest: string
  ownerPub: string
  salt: string
  nonce: string
  ciphertext: string
}

function requirePurpose(value: unknown): asserts value is LightBackupPurpose {
  if (value !== 'passkey-prf' && value !== 'recovery-secret') throw new Error('unsupported Light backup purpose')
}

function require32(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error('Light key material must be 32 bytes')
  return Uint8Array.from(value)
}

function additionalData(backup: Omit<LightKeyBackup, 'ciphertext'>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(backup))
}

async function deriveKey(material: Uint8Array, salt: Uint8Array<ArrayBuffer>, purpose: LightBackupPurpose) {
  const copy = require32(material)
  try {
    const key = await crypto.subtle.importKey('raw', copy, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${DOMAIN}/${purpose}`) },
      key,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    copy.fill(0)
  }
}

/** Material must be a 32-byte passkey PRF result or cryptographically random recovery secret, never a password. */
export async function wrapLightOwnerKey(
  ownerKey: Uint8Array,
  material: Uint8Array,
  purpose: LightBackupPurpose,
  descriptor: LightDescriptor,
): Promise<LightKeyBackup> {
  requirePurpose(purpose)
  const valid = validateLightDescriptor(descriptor)
  const copy = require32(ownerKey)
  try {
    if (hex.encode(schnorr.getPublicKey(copy)) !== valid.ownerPub) throw new Error('Light owner key does not match')
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const header = {
      name: NAME,
      version: VERSION,
      purpose,
      descriptorDigest: lightDescriptorDigest(valid),
      ownerPub: valid.ownerPub,
      salt: hex.encode(salt),
      nonce: hex.encode(nonce),
    }
    const key = await deriveKey(material, salt, purpose)
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalData(header), tagLength: 128 },
      key,
      copy,
    )
    return { ...header, ciphertext: hex.encode(new Uint8Array(ciphertext)) }
  } finally {
    copy.fill(0)
  }
}

export function validateLightKeyBackup(value: unknown, descriptor: LightDescriptor): LightKeyBackup {
  const valid = validateLightDescriptor(descriptor)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Light key backup required')
  const backup = value as LightKeyBackup
  requirePurpose(backup.purpose)
  const keys = ['name', 'version', 'purpose', 'descriptorDigest', 'ownerPub', 'salt', 'nonce', 'ciphertext']
  if (
    Object.keys(backup).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(backup, key)) ||
    backup.name !== NAME ||
    backup.version !== VERSION ||
    backup.descriptorDigest !== lightDescriptorDigest(valid) ||
    backup.ownerPub !== valid.ownerPub ||
    typeof backup.salt !== 'string' ||
    !/^[0-9a-f]{64}$/.test(backup.salt) ||
    typeof backup.nonce !== 'string' ||
    !/^[0-9a-f]{24}$/.test(backup.nonce) ||
    typeof backup.ciphertext !== 'string' ||
    !/^[0-9a-f]{96}$/.test(backup.ciphertext)
  ) {
    throw new Error('Light key backup does not match its descriptor or format')
  }
  return {
    name: NAME,
    version: VERSION,
    purpose: backup.purpose,
    descriptorDigest: backup.descriptorDigest,
    ownerPub: backup.ownerPub,
    salt: backup.salt,
    nonce: backup.nonce,
    ciphertext: backup.ciphertext,
  }
}

/** The caller verifies its passkey ceremony and must wipe the returned key after use. */
export async function unlockLightOwnerKey(
  value: unknown,
  material: Uint8Array,
  purpose: LightBackupPurpose,
  descriptor: LightDescriptor,
): Promise<Uint8Array<ArrayBuffer>> {
  requirePurpose(purpose)
  const backup = validateLightKeyBackup(value, descriptor)
  if (backup.purpose !== purpose) throw new Error('Light backup purpose does not match')
  const { ciphertext, ...header } = backup
  const key = await deriveKey(material, Uint8Array.from(hex.decode(backup.salt)), purpose)
  let owner: Uint8Array<ArrayBuffer> | undefined
  try {
    owner = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: Uint8Array.from(hex.decode(backup.nonce)),
          additionalData: additionalData(header),
          tagLength: 128,
        },
        key,
        Uint8Array.from(hex.decode(ciphertext)),
      ),
    )
    if (owner.length !== 32 || hex.encode(schnorr.getPublicKey(owner)) !== backup.ownerPub) throw new Error()
    return owner
  } catch {
    owner?.fill(0)
    throw new Error('Unable to unlock this Light key backup')
  }
}
