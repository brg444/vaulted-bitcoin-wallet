import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { requireSupportedVaultNetwork, type VaultNetwork } from './network'
import {
  ledgerAccountKey,
  ledgerBip32Versions,
  ledgerSavingsContextDigest,
  type LedgerAccountOrigin,
  type LedgerSavingsKeyContext,
} from './program/ledgerNativeKeys'

export type LedgerPhoneBackupPurpose = 'passkey-prf' | 'recovery-secret'
const NAME = 'vaulted-ledger-savings-phone-seed' as const
const VERSION = 1 as const
const DOMAIN = 'vaulted-ledger-savings/phone-seed-encryption/v1'
const HARDENED = 0x80000000

// This envelope contains only the Savings HD seed, not the Spending scalar or a complete Recovery Kit.
export interface LedgerPhoneSeedBackup {
  name: typeof NAME
  version: typeof VERSION
  purpose: LedgerPhoneBackupPurpose
  contextDigest: string
  phoneOrigin: LedgerAccountOrigin
  salt: string
  nonce: string
  ciphertext: string
}

function requirePurpose(value: unknown): asserts value is LedgerPhoneBackupPurpose {
  if (value !== 'passkey-prf' && value !== 'recovery-secret') throw new Error('unsupported Ledger phone backup purpose')
}

function copy32(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new Error('Ledger phone seed and key material must be 32 bytes')
  return Uint8Array.from(value)
}

/** Generate a fresh Savings seed automatically; never reinterpret an existing Spending scalar as this seed. */
export function generateLedgerPhoneSeed(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

/** Returns public enrollment metadata. The caller retains ownership of the seed and must wipe it after use. */
export function deriveLedgerPhoneAccount(seed: Uint8Array, network: VaultNetwork, account = 0): LedgerAccountOrigin {
  requireSupportedVaultNetwork(network)
  if (!Number.isInteger(account) || account < 0 || account > 100)
    throw new Error('Ledger phone account must be between zero and 100')
  const copy = copy32(seed)
  const nodes: HDKey[] = []
  try {
    let node = HDKey.fromMasterSeed(copy, ledgerBip32Versions(network))
    nodes.push(node)
    const fingerprint = node.fingerprint.toString(16).padStart(8, '0')
    const path = [HARDENED + 86, HARDENED + (network === 'mainnet' ? 0 : 1), HARDENED + account]
    for (const index of path) {
      node = node.deriveChild(index)
      nodes.push(node)
      if (node.index !== index) throw new Error('invalid Ledger phone account derivation')
    }
    return { xpub: node.publicExtendedKey, fingerprint, path }
  } finally {
    copy.fill(0)
    for (const node of nodes) node.wipePrivateData()
  }
}

function sameOrigin(left: LedgerAccountOrigin, right: LedgerAccountOrigin): boolean {
  return (
    left.xpub === right.xpub &&
    left.fingerprint === right.fingerprint &&
    left.path.length === right.path.length &&
    left.path.every((index, position) => index === right.path[position])
  )
}

function requireSeedOrigin(seed: Uint8Array, network: VaultNetwork, origin: LedgerAccountOrigin) {
  if (!sameOrigin(deriveLedgerPhoneAccount(seed, network, origin.path[2] - HARDENED), origin))
    throw new Error('Ledger phone seed does not match its enrolled account origin')
}

function binding(context: LedgerSavingsKeyContext) {
  const contextDigest = hex.encode(ledgerSavingsContextDigest(context))
  return {
    contextDigest,
    phoneOrigin: {
      xpub: context.phone.xpub,
      fingerprint: context.phone.fingerprint,
      path: [...context.phone.path],
    },
  }
}

function additionalData(header: Omit<LedgerPhoneSeedBackup, 'ciphertext'>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(header))
}

async function deriveKey(material: Uint8Array, salt: Uint8Array<ArrayBuffer>, purpose: LedgerPhoneBackupPurpose) {
  const copy = copy32(material)
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

/** Material is a 32-byte passkey PRF result or random recovery key, never a password or the Spending scalar. */
export async function wrapLedgerPhoneSeed(
  seed: Uint8Array,
  material: Uint8Array,
  purpose: LedgerPhoneBackupPurpose,
  context: LedgerSavingsKeyContext,
): Promise<LedgerPhoneSeedBackup> {
  requirePurpose(purpose)
  const enrolled = binding(context)
  const copy = copy32(seed)
  try {
    requireSeedOrigin(copy, context.network, enrolled.phoneOrigin)
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const header = {
      name: NAME,
      version: VERSION,
      purpose,
      ...enrolled,
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

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

export function validateLedgerPhoneSeedBackup(value: unknown, context: LedgerSavingsKeyContext): LedgerPhoneSeedBackup {
  const enrolled = binding(context)
  const keys = ['name', 'version', 'purpose', 'contextDigest', 'phoneOrigin', 'salt', 'nonce', 'ciphertext']
  if (!hasExactKeys(value, keys)) throw new Error('Ledger phone seed backup format mismatch')
  requirePurpose(value.purpose)
  if (
    value.name !== NAME ||
    value.version !== VERSION ||
    value.contextDigest !== enrolled.contextDigest ||
    !hasExactKeys(value.phoneOrigin, ['xpub', 'fingerprint', 'path']) ||
    typeof value.phoneOrigin.xpub !== 'string' ||
    typeof value.phoneOrigin.fingerprint !== 'string' ||
    !Array.isArray(value.phoneOrigin.path) ||
    typeof value.salt !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.salt) ||
    typeof value.nonce !== 'string' ||
    !/^[0-9a-f]{24}$/.test(value.nonce) ||
    typeof value.ciphertext !== 'string' ||
    !/^[0-9a-f]{96}$/.test(value.ciphertext)
  ) {
    throw new Error('Ledger phone seed backup does not match its enrollment or format')
  }
  const origin = {
    xpub: value.phoneOrigin.xpub,
    fingerprint: value.phoneOrigin.fingerprint,
    path: [...value.phoneOrigin.path],
  }
  ledgerAccountKey(origin, context.network)
  if (!sameOrigin(origin, enrolled.phoneOrigin)) throw new Error('Ledger phone seed backup account origin mismatch')
  return {
    name: NAME,
    version: VERSION,
    purpose: value.purpose,
    ...enrolled,
    salt: value.salt,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  }
}

/** The caller verifies its passkey ceremony and must wipe the returned seed after use. */
export async function unlockLedgerPhoneSeed(
  value: unknown,
  material: Uint8Array,
  purpose: LedgerPhoneBackupPurpose,
  context: LedgerSavingsKeyContext,
): Promise<Uint8Array<ArrayBuffer>> {
  requirePurpose(purpose)
  const network = context.network
  const backup = validateLedgerPhoneSeedBackup(value, context)
  if (backup.purpose !== purpose) throw new Error('Ledger phone backup purpose does not match')
  const { ciphertext, ...header } = backup
  const key = await deriveKey(material, Uint8Array.from(hex.decode(backup.salt)), purpose)
  let seed: Uint8Array<ArrayBuffer> | undefined
  try {
    seed = new Uint8Array(
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
    requireSeedOrigin(seed, network, backup.phoneOrigin)
    return seed
  } catch {
    seed?.fill(0)
    throw new Error('Unable to unlock this Ledger phone seed backup')
  }
}
