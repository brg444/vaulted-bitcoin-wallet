import {
  buildRecoveryHeader,
  encryptRecoveryBackup,
  parseEncryptedRecoveryBackup,
  recoveryStatusFacts,
  validateVaultRecoveryFile,
  validateRecoveryDataBinding,
  type RecoveryHeader,
  type EncryptedRecoveryBackup,
  type VaultRecoveryFile,
} from './backupCodec'
import { validateVaultRecoveryArchive, type VaultRecoveryArchive } from '../vtxo/recoveryArchive'
import { buildRecoveryKit, parseRecoveryKit } from '../program/kit'
import { buildVaultProgramDescriptor } from '../program/descriptor'
import { validateSpendingPolicy } from '../spendingPolicy'
import { normalizeRecoveryChain, type ExitArchive } from './exitArchive'

// Compare JSON values independently of property order, while rejecting extra fields.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
}

function select(value: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => value[name] !== undefined).map((name) => [name, value[name]]))
}
function publicFees(value: Record<string, unknown>) {
  return {
    ...select(value, ['txFeeRate']),
    ...(value.intentFee
      ? {
          intentFee: select(value.intentFee as Record<string, unknown>, [
            'offchainInput',
            'onchainInput',
            'offchainOutput',
            'onchainOutput',
          ]),
        }
      : {}),
  }
}
function publicInfo(raw: string): string {
  const info = JSON.parse(raw)
  return JSON.stringify({
    ...select(info, [
      'network',
      'signerPubkey',
      'checkpointTapscript',
      'forfeitPubkey',
      'forfeitAddress',
      'boardingExitDelay',
      'unilateralExitDelay',
      'sessionDuration',
      'dust',
      'digest',
      'version',
      'vtxoTreeExpiry',
      'maxTxWeight',
      'maxOpReturnOutputs',
      'utxoMaxAmount',
      'utxoMinAmount',
      'vtxoMaxAmount',
      'vtxoMinAmount',
    ]),
    fees: publicFees(info.fees || {}),
    deprecatedSigners: (info.deprecatedSigners || []).map((signer: Record<string, unknown>) =>
      select(signer, ['pubkey', 'cutoffDate']),
    ),
    serviceStatus: {},
    ...(info.scheduledSession
      ? {
          scheduledSession: {
            ...select(info.scheduledSession, ['duration', 'nextEndTime', 'nextStartTime', 'period']),
            fees: publicFees(info.scheduledSession.fees || {}),
          },
        }
      : {}),
  })
}
function publicCoins(raw: string): string {
  return JSON.stringify(
    JSON.parse(raw).map((coin: Record<string, unknown>) => ({
      ...select(coin, [
        'txid',
        'vout',
        'value',
        'script',
        'isSpent',
        'createdAt',
        'isUnrolled',
        'isSwept',
        'isPreconfirmed',
        'settledBy',
        'spentBy',
        'arkTxId',
        'commitmentTxIds',
        'expiresAt',
        'expiresAtHeight',
      ]),
      ...(coin.status
        ? {
            status: select(coin.status as Record<string, unknown>, [
              'confirmed',
              'block_height',
              'block_hash',
              'block_time',
            ]),
          }
        : {}),
      ...(coin.virtualStatus
        ? {
            virtualStatus: select(coin.virtualStatus as Record<string, unknown>, [
              'state',
              'commitmentTxIds',
              'batchExpiry',
            ]),
          }
        : {}),
    })),
  )
}

/** Transaction paths are readable without a phone. Operational journals remain encrypted. */
export const MAX_PORTABLE_RECOVERY_BYTES = 32_000_000

export function publicExitArchive(archive: ExitArchive): ExitArchive {
  return {
    version: 1,
    descriptorHash: archive.descriptorHash,
    capturedAt: archive.capturedAt,
    info: publicInfo(archive.info),
    coins: publicCoins(archive.coins),
    branches: Object.fromEntries(
      Object.entries(archive.branches).map(([key, chain]) => [key, normalizeRecoveryChain(chain)]),
    ),
    transactions: { ...archive.transactions },
  }
}

export interface PortableRecoveryPackage {
  name: 'vaulted-recovery-package'
  version: 1
  archive: VaultRecoveryArchive
  backup: EncryptedRecoveryBackup
}

export async function createPortableRecoveryPackage(file: VaultRecoveryFile, key: CryptoKey) {
  const valid = validateVaultRecoveryFile(file)
  const d = valid.header.kit.descriptor
  const policy = validateSpendingPolicy(valid.header.status.spendingPolicy, d.network)
  const kit = buildRecoveryKit(
    buildVaultProgramDescriptor({
      vaultId: d.vaultId,
      network: d.network,
      templateVersion: d.templateVersion,
      connectorType: d.connectorType,
      protectionTier: d.protectionTier,
      spendingPolicy: policy,
      phonePub: d.keys.phoneBip340,
      hardwarePub: d.keys.hardware,
      recoveryPub: d.keys.recovery,
      phoneDirectP256: d.keys.phoneDirectP256,
      vaultCosignerBase: d.keys.vaultCosignerBase,
      arkadeCosignerBase: d.keys.arkadeCosignerBase,
      arkadeCosigner: { origin: d.arkadeCosigner.origin, version: d.arkadeCosigner.version },
    }),
  )
  const status = recoveryStatusFacts(valid.header.status)
  status.spendingPolicy = policy
  if (status.vtxoBoardingDescriptor) {
    const {
      schema,
      program,
      template,
      network,
      boardingPub,
      recoveryPhonePub,
      vaultBoardCosignerPub,
      operatorPub,
      exitDelay,
      exitDelayUnit,
      script,
      address,
    } = status.vtxoBoardingDescriptor
    status.vtxoBoardingDescriptor = {
      schema,
      program,
      template,
      network,
      boardingPub,
      recoveryPhonePub,
      vaultBoardCosignerPub,
      operatorPub,
      exitDelay,
      exitDelayUnit,
      script,
      address,
    }
  }
  if (status.connectorEnrollment) {
    const { connectorType, connectorPub, connectorFingerprint, connectorPath, enrollmentDigest, descriptorHash } =
      status.connectorEnrollment
    status.connectorEnrollment = {
      connectorType,
      connectorPub,
      connectorFingerprint,
      connectorPath: [...connectorPath],
      enrollmentDigest,
      descriptorHash,
    }
  }
  const header = buildRecoveryHeader(kit, status, valid.header.enrollment)
  // An unexpected extension in the public identity requires review before export.
  if (canonical(header) !== canonical(valid.header))
    throw new Error('Recovery identity contains unsupported export fields')
  // Deliberately select the public archive. Never spread the complete file:
  // journals can retain signed authorizations and sensitive payment metadata.
  const archive: VaultRecoveryArchive = {
    name: 'vaulted-program-recovery-data',
    version: 1,
    kit: parseRecoveryKit(header.kit),
    status: recoveryStatusFacts(header.status),
    spending: {
      version: 1,
      descriptorHash: valid.archive.spending.descriptorHash,
      capturedAt: valid.archive.spending.capturedAt,
      info: publicInfo(valid.archive.spending.info),
      coins: publicCoins(valid.archive.spending.coins),
      branches: Object.fromEntries(
        Object.entries(valid.archive.spending.branches).map(([point, chain]) => [point, normalizeRecoveryChain(chain)]),
      ),
      transactions: { ...valid.archive.spending.transactions },
    },
    onchain: valid.archive.onchain.map(({ txid, vout, value, script, parentHex }) => ({
      txid,
      vout,
      value,
      script,
      parentHex,
    })),
  }
  return parsePortableRecoveryPackage({
    name: 'vaulted-recovery-package',
    version: 1,
    archive,
    backup: await encryptRecoveryBackup({ ...valid, header }, key),
  })
}

export function parsePortableRecoveryPackage(raw: unknown): PortableRecoveryPackage {
  const value = raw as PortableRecoveryPackage
  if (
    !value ||
    value.name !== 'vaulted-recovery-package' ||
    value.version !== 1 ||
    Object.keys(value).sort().join(',') !== 'archive,backup,name,version' ||
    JSON.stringify(value).length > MAX_PORTABLE_RECOVERY_BYTES
  )
    throw new Error('Invalid portable recovery package')
  const backup = parseEncryptedRecoveryBackup(value.backup)
  const archive = validateVaultRecoveryArchive(value.archive)
  // Bind the readable paths to the same wallet and key envelope as the backup.
  validateRecoveryDataBinding(backup.header, archive)
  return value
}

/** A distinct format prevents transaction-only data from entering wallet restore. */
export interface ReadableRecoverySource {
  name: 'vaulted-readable-recovery'
  version: 1
  header: RecoveryHeader
  archive: VaultRecoveryArchive
}

export function validateReadableRecoverySource(value: ReadableRecoverySource): ReadableRecoverySource {
  if (
    !value ||
    value.name !== 'vaulted-readable-recovery' ||
    value.version !== 1 ||
    Object.keys(value).sort().join(',') !== 'archive,header,name,version'
  )
    throw new Error('Invalid readable recovery data')
  validateRecoveryDataBinding(value.header, value.archive)
  return value
}

export function portableRecoverySource(raw: unknown): ReadableRecoverySource {
  const value = parsePortableRecoveryPackage(raw)
  return validateReadableRecoverySource({
    name: 'vaulted-readable-recovery',
    version: 1,
    header: value.backup.header,
    archive: value.archive,
  })
}
