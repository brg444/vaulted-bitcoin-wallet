import { validateRecoveryJournals, type RecoveryJournals } from './journals'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { isLedgerRecoveryKit, parseRecoveryKit, type RecoveryKit } from '../program/kit'
import { validateConnectorRecoveryJournal, type ConnectorRecoveryJournal } from '../program/connectorStore'
import { isConnectorTemplate } from '../program/connector'
import { validateVaultRecoveryArchive, vaultRecoveryBinding, type VaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { unlockVaultPhoneKeys } from '../savingsSpend'
import { canonicalLedgerValue, validateLedgerSavingsEnrollmentSecrets } from '../program/ledgerEnrollment'
import { compressRecoveryData, MAX_RECOVERY_PLAIN_BYTES } from './compression'

const encoder = new TextEncoder()
export const MAX_RECOVERY_BACKUP_BYTES = 3_000_000
export interface RecoveryBinding {
  vaultId: string
  network: string
  templateVersion: string
  protectionTier: string
  policyVersion: string
  spendingPolicyDigest: string
  descriptorHash: string
}
export interface RecoveryHeader {
  /** Absent for legacy headers. Version two binds the separate Savings HD envelope. */
  version?: 2
  binding: RecoveryBinding
  kit: RecoveryKit
  status: VaultStatus
  enrollment: EnrollmentSecrets
  origin: string
  rpId: string
}
export interface VaultRecoveryFile extends Partial<RecoveryJournals> {
  name: 'vaulted-recovery'
  version: 1
  header: RecoveryHeader
  archive: VaultRecoveryArchive
  connectorJournal?: ConnectorRecoveryJournal
}
export interface EncryptedRecoveryBackup {
  name: 'vaulted-recovery-backup'
  version: 1
  header: RecoveryHeader
  nonce: string
  ciphertext: string
}

export function recoveryBinding(kit: RecoveryKit, status: VaultStatus): RecoveryBinding {
  vaultRecoveryBinding(kit, status)
  return {
    vaultId: status.vaultId,
    network: status.network,
    templateVersion: status.templateVersion,
    protectionTier: kit.protectionTier,
    policyVersion: status.policyVersion,
    spendingPolicyDigest: kit.spendingPolicyDigest,
    descriptorHash: isLedgerRecoveryKit(kit)
      ? kit.descriptor.enrollmentDescriptorHash
      : isConnectorTemplate(status.templateVersion)
        ? status.connectorEnrollment!.descriptorHash
        : status.vtxoBoardingDescriptorHash!,
  }
}

/** Session header is immutable; balance, liveness and timestamps belong only in the body. */
export function recoveryStatusFacts(status: VaultStatus): VaultStatus {
  const names = [
    'vaultId',
    'network',
    'clientOrigin',
    'rpId',
    'templateVersion',
    'policyVersion',
    'protectionTier',
    'phoneBip340Pub',
    'phoneDirectP256',
    'externalOwnerWalletPub',
    'recoveryPub',
    'recoveryKeyPub',
    'vaultCosignerBasePub',
    'arkadeCosignerBasePub',
    'arkadeCosignerOrigin',
    'arkadeCosignerVersion',
    'savingsAddress',
    'savingsScript',
    'spendingPolicy',
    'spendingPolicyDigest',
    'vtxoVaultCosignerPub',
    'vtxoDelegatePub',
    'vtxoExitDelay',
    'vtxoExitDelayUnit',
    'spendingArkAddress',
    'spendingArkScript',
    'vtxoBoardingProgram',
    'vtxoBoardingDescriptor',
    'vtxoBoardingDescriptorHash',
    'vtxoBoardingScript',
    'vtxoBoardingAddress',
    'vtxoBoardingExitDelay',
    'vtxoBoardingExitDelayUnit',
    'connectorEnrollment',
    'ledgerSavings',
  ] as const
  return JSON.parse(
    JSON.stringify({
      enrolled: true,
      vtxoBoardingActive: true,
      ...Object.fromEntries(names.map((name) => [name, status[name]])),
    }),
  ) as VaultStatus
}

export function buildRecoveryHeader(
  kit: RecoveryKit,
  status: VaultStatus,
  enrollment: EnrollmentSecrets,
): RecoveryHeader {
  const validKit = parseRecoveryKit(kit)
  const facts = recoveryStatusFacts(status)
  const header = {
    ...(isLedgerRecoveryKit(validKit) ? { version: 2 as const } : {}),
    binding: recoveryBinding(validKit, facts),
    kit: validKit,
    status: facts,
    enrollment: {
      vaultId: enrollment.vaultId,
      credId: enrollment.credId,
      webauthnP256: enrollment.webauthnP256,
      phoneDirectP256: enrollment.phoneDirectP256,
      phoneBip340Pub: enrollment.phoneBip340Pub,
      nonce: enrollment.nonce,
      ciphertext: enrollment.ciphertext,
      ...(enrollment.ledgerSavings
        ? {
            ledgerSavings: validateLedgerSavingsEnrollmentSecrets(
              enrollment.ledgerSavings,
              isLedgerRecoveryKit(validKit) ? validKit.descriptor.ledgerSavings : undefined,
            ),
          }
        : {}),
    },
    origin: status.clientOrigin,
    rpId: status.rpId,
  }
  return validateRecoveryHeader(header)
}

export function validateRecoveryHeader(header: RecoveryHeader) {
  if (!header || JSON.stringify(header).length > 96 * 1024) throw new Error('Invalid recovery header')
  const binding = recoveryBinding(header.kit, header.status)
  if (JSON.stringify(header.binding) !== JSON.stringify(binding)) throw new Error('Recovery enrollment binding changed')
  if (JSON.stringify(header.status) !== JSON.stringify(recoveryStatusFacts(header.status)))
    throw new Error('Recovery header must contain immutable status facts')
  const e = header.enrollment
  const kit = parseRecoveryKit(header.kit)
  if (isLedgerRecoveryKit(kit)) {
    if (header.version !== 2) throw new Error('Ledger recovery header version required')
    const ledger = validateLedgerSavingsEnrollmentSecrets(e?.ledgerSavings, kit.descriptor.ledgerSavings)
    if (canonicalLedgerValue(ledger) !== canonicalLedgerValue(e.ledgerSavings))
      throw new Error('Ledger recovery envelope changed')
  } else if (header.version !== undefined || e?.ledgerSavings !== undefined) {
    throw new Error('Ledger recovery fields on a legacy header')
  }
  if (
    !e ||
    e.vaultId !== binding.vaultId ||
    e.phoneBip340Pub !== header.kit.descriptor.keys.phoneBip340 ||
    e.phoneDirectP256 !== header.kit.descriptor.keys.phoneDirectP256 ||
    !/^(?:[0-9a-f]{2}){1,1024}$/.test(e.credId) ||
    !/^(02|03)[0-9a-f]{64}$/.test(e.webauthnP256) ||
    !/^[0-9a-f]{24}$/.test(e.nonce) ||
    !/^[0-9a-f]{96}$/.test(e.ciphertext)
  )
    throw new Error('Recovery passkey envelope does not match the vault')
  if (
    typeof header.origin !== 'string' ||
    new URL(header.origin).origin !== header.origin ||
    new URL(header.origin).hostname !== header.rpId ||
    header.origin !== header.status.clientOrigin ||
    header.rpId !== header.status.rpId
  )
    throw new Error('Recovery passkey origin changed')
  return header
}

/** Shared identity check for complete backups and readable transaction-only data. */
export function validateRecoveryDataBinding(headerValue: RecoveryHeader, archiveValue: VaultRecoveryArchive) {
  const header = validateRecoveryHeader(headerValue)
  const archive = validateVaultRecoveryArchive(archiveValue)
  if (
    JSON.stringify(recoveryStatusFacts(archive.status)) !== JSON.stringify(header.status) ||
    archive.kit.descriptorHash !== header.kit.descriptorHash
  )
    throw new Error('Recovery data does not match its encrypted identity')
  return { header, archive }
}

export function validateVaultRecoveryFile(file: VaultRecoveryFile) {
  if (
    !file ||
    file.name !== 'vaulted-recovery' ||
    file.version !== 1 ||
    JSON.stringify(file).length > MAX_RECOVERY_PLAIN_BYTES
  )
    throw new Error('Invalid recovery file')
  const { header } = validateRecoveryDataBinding(file.header, file.archive)
  if (isConnectorTemplate(header.binding.templateVersion)) {
    validateConnectorRecoveryJournal(
      { vaultId: header.binding.vaultId, enrollmentDigest: header.status.connectorEnrollment!.enrollmentDigest },
      file.connectorJournal,
    )
  } else if (file.connectorJournal !== undefined) throw new Error('Connector journal on another program')
  if (
    file.spendingJournal !== undefined ||
    file.lightningJournal !== undefined ||
    file.ledgerSavingsJournal !== undefined ||
    file.ledgerRecoveryJournal !== undefined
  )
    validateRecoveryJournals(header.status, file as VaultRecoveryFile & RecoveryJournals)
  return file
}

export async function recoveryBackupKey(phone: Uint8Array, header: RecoveryHeader) {
  const valid = validateRecoveryHeader(header)
  if (phone.length !== 32 || hex.encode(schnorr.getPublicKey(phone)) !== valid.enrollment.phoneBip340Pub.slice(2))
    throw new Error('Backup key does not belong to this vault')
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(phone), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Uint8Array.from(hex.decode(vaultRecoveryBinding(valid.kit, valid.status).descriptorHash)),
      info: encoder.encode('vaulted/full-recovery-backup/v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function parseEncryptedRecoveryBackup(raw: unknown): EncryptedRecoveryBackup {
  const file = raw as EncryptedRecoveryBackup
  if (
    !file ||
    file.name !== 'vaulted-recovery-backup' ||
    file.version !== 1 ||
    Object.keys(file).length !== 5 ||
    JSON.stringify(file).length > MAX_RECOVERY_BACKUP_BYTES ||
    !/^[0-9a-f]{24}$/.test(file.nonce) ||
    typeof file.ciphertext !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(file.ciphertext)
  )
    throw new Error('Invalid encrypted recovery backup')
  validateRecoveryHeader(file.header)
  return file
}

export async function encryptRecoveryBackup(file: VaultRecoveryFile, key: CryptoKey): Promise<EncryptedRecoveryBackup> {
  const valid = validateVaultRecoveryFile(file)
  const plain = encoder.encode(JSON.stringify(valid))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  let compressed: Uint8Array<ArrayBuffer> | undefined
  try {
    compressed = await compressRecoveryData(plain, false)
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(JSON.stringify(valid.header)) },
        key,
        compressed,
      ),
    )
    return parseEncryptedRecoveryBackup({
      name: 'vaulted-recovery-backup',
      version: 1,
      header: valid.header,
      nonce: hex.encode(nonce),
      ciphertext: base64.encode(ciphertext),
    })
  } finally {
    plain.fill(0)
    compressed?.fill(0)
  }
}

export async function decryptRecoveryBackup(raw: unknown, key: CryptoKey): Promise<VaultRecoveryFile> {
  const file = parseEncryptedRecoveryBackup(raw)
  const compressed = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(hex.decode(file.nonce)),
        additionalData: encoder.encode(JSON.stringify(file.header)),
      },
      key,
      Uint8Array.from(base64.decode(file.ciphertext)),
    ),
  )
  let plain: Uint8Array | undefined
  try {
    plain = await compressRecoveryData(compressed, true)
    const decoded = validateVaultRecoveryFile(JSON.parse(new TextDecoder().decode(plain)))
    if (JSON.stringify(decoded.header) !== JSON.stringify(file.header)) throw new Error('Recovery header changed')
    return decoded
  } finally {
    compressed.fill(0)
    plain?.fill(0)
  }
}

export async function openLocalRecoveryBackup(
  raw: unknown,
  restored?: (file: VaultRecoveryFile, phone: Uint8Array, ledgerSavingsSeed?: Uint8Array) => Promise<unknown>,
) {
  const file = parseEncryptedRecoveryBackup(raw)
  if (location.origin !== file.header.origin || location.hostname !== file.header.rpId)
    throw new Error(`Open recovery at ${file.header.origin} to use the original passkey`)
  const { spendingPhone: phone, ledgerSavingsSeed } = await unlockVaultPhoneKeys(
    file.header.enrollment,
    file.header.status,
  )
  try {
    const decoded = await decryptRecoveryBackup(file, await recoveryBackupKey(phone, file.header))
    if (restored) await restored(decoded, phone, ledgerSavingsSeed)
    return decoded
  } finally {
    phone.fill(0)
    ledgerSavingsSeed?.fill(0)
  }
}
