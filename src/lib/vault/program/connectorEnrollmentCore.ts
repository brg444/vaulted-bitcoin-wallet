import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { buildConnectorFamily, connectorEnrollmentDigest, CONNECTOR_TEMPLATE, type ConnectorOrigin } from './connector'
import { encodeRawVaultProgramDescriptor, type VaultProgramDescriptor } from './descriptor'
import { DUST_SATS, POLICY_VERSION } from '../constants'
import {
  P2A_OUTPUT_INDEX,
  P2A_SCRIPT_HEX,
  P2A_VALUE_SATS,
  PROGRAM_CSV,
  PROGRAM_SCHEMA,
  TRANSITION_SEQUENCE,
  familyKeysFor,
} from './constants'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import { requireProtectionTierMatchesRecovery, type ProtectionTier } from '../protectionTier'
import type { BoardingDescriptor } from '../types'

// Pure connector descriptor and Recovery Kit reconstruction. No SDK, HTTP, or browser storage dependencies.

export const CONNECTOR_ENROLLMENT_SCHEMA = 'arkade-vault/enrollment-with-connector-v1'
export const CONNECTOR_DESCRIPTOR_SCHEMA = 'arkade-vault/connector-enrollment-v1'
export const BOARDING_ENROLLMENT_SCHEMA = 'arkade-vault/enrollment-with-board-v1'

export type ConnectorEnrollmentNetwork = 'mainnet' | 'mutinynet'
export type ConnectorEnrollmentType = 'p2wpkh' | 'p2tr'

export interface ConnectorEnrollmentOrigin {
  /** Full compressed lowercase hex; exact odd parity is preserved. */
  connectorPub: string
  connectorType: ConnectorEnrollmentType
  connectorFingerprint: number
  connectorPath: number[]
}

export interface ConnectorEnrollmentPreviewInput {
  templateVersion?: string
  vaultId: string
  network: ConnectorEnrollmentNetwork
  protectionTier: ProtectionTier
  phonePub: string
  phoneDirectP256: string
  recoveryPub?: string
  vaultCosignerBase: string
  arkadeCosignerBase: string
  arkadeOrigin: string
  arkadeVersion: string
  spendingPolicy: SpendingPolicy
  origin: ConnectorEnrollmentOrigin
  boarding?: BoardingDescriptor
}

export interface ConnectorEnrollmentPreview {
  family: ReturnType<typeof buildConnectorFamily>
  origin: ConnectorOrigin
  digest: string
  savingsHash: string
  boardingHash: string
  compositeHash: string
  descriptor: VaultProgramDescriptor
  policy: SpendingPolicy
  protectionTier: ProtectionTier
}

export function fail(message: string): never {
  throw new Error(message)
}

export function requireCompressedHex(value: unknown, name: string): string {
  const key = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^(02|03)[0-9a-f]{64}$/.test(key)) fail(`${name} must be a compressed public key`)
  return key
}

export function requireUint32(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff)
    fail(`${name} must be a uint32`)
  return value as number
}

export function parseConnectorOriginPath(value: unknown): number[] {
  if (typeof value !== 'string' || !value) fail('connector origin path required')
  const steps = value.split('/').map((step) => {
    if (!/^\d{1,10}$/.test(step)) fail('connector origin path required')
    const n = Number(step)
    if (!Number.isSafeInteger(n) || n > 0xffffffff) fail('connector origin path required')
    return n
  })
  if (steps.length < 1 || steps.length > 255) fail('connector origin path required')
  return steps
}

function appendLE32(parts: Uint8Array[], value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  parts.push(bytes)
}

function appendField(parts: Uint8Array[], value: string) {
  const bytes = new TextEncoder().encode(value)
  appendLE32(parts, bytes.length)
  parts.push(bytes)
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  // Public descriptor data: hash the concatenated bytes as built. A
  // wipe-before-hash here committed only a zero buffer (Codex qualification).
  return out
}

// Byte layout of runtime hashVaultBoardComposite: LE32-length-prefixed fields
// plus a trailing LE32 exit delay, sha256 hex. Shared with legacy enrollments.
export function hashConnectorBoarding(vaultId: string, savingsHash: string, boarding: BoardingDescriptor): string {
  if (!/^[0-9a-f]{64}$/.test(savingsHash)) fail('connector savings hash required')
  const fields = [
    BOARDING_ENROLLMENT_SCHEMA,
    vaultId,
    savingsHash,
    boarding.schema,
    boarding.program,
    boarding.template,
    boarding.network,
    boarding.boardingPub,
    boarding.recoveryPhonePub,
    boarding.vaultBoardCosignerPub,
    boarding.operatorPub,
    boarding.exitDelayUnit,
    boarding.script,
    boarding.address,
  ]
  const parts: Uint8Array[] = []
  for (const field of fields) appendField(parts, field)
  appendLE32(parts, boarding.exitDelay)
  return hex.encode(sha256(concatParts(parts)))
}

// Runtime hashConnectorBoardComposite: sha256(0x01 || digest || boardingHash).
export function hashConnectorBoardComposite(digestHex: string, boardingHashHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) fail('connector enrollment digest required')
  if (!/^[0-9a-f]{64}$/.test(boardingHashHex)) fail('connector boarding hash required')
  const payload = new Uint8Array(65)
  payload[0] = 0x01
  payload.set(hex.decode(digestHex), 1)
  payload.set(hex.decode(boardingHashHex), 33)
  const out = hex.encode(sha256(payload))
  payload.fill(0)
  return out
}

function toOrigin(origin: ConnectorEnrollmentOrigin): ConnectorOrigin {
  return {
    publicKey: hex.decode(requireCompressedHex(origin.connectorPub, 'connectorPub')),
    fingerprint: requireUint32(origin.connectorFingerprint, 'connectorFingerprint'),
    path: [...origin.connectorPath],
  }
}

export function buildConnectorEnrollmentPreview(input: ConnectorEnrollmentPreviewInput): ConnectorEnrollmentPreview {
  const network =
    input.network === 'mainnet' || input.network === 'mutinynet' ? input.network : fail('unsupported network')
  const protectionTier = requireProtectionTierMatchesRecovery(input.protectionTier, input.recoveryPub || '')
  const policy = validateSpendingPolicy(input.spendingPolicy, network)
  const origin = toOrigin(input.origin)
  if (input.origin.connectorType !== 'p2wpkh' && input.origin.connectorType !== 'p2tr')
    fail('connector type must be p2tr or p2wpkh')
  const familyInput = {
    templateVersion: input.templateVersion ?? CONNECTOR_TEMPLATE,
    connectorType: input.origin.connectorType,
    vaultId: input.vaultId,
    network,
    phonePub: requireCompressedHex(input.phonePub, 'phonePub'),
    hardwarePub: requireCompressedHex(input.origin.connectorPub, 'connectorPub'),
    ...(input.recoveryPub ? { recoveryPub: requireCompressedHex(input.recoveryPub, 'recoveryPub') } : {}),
    phoneDirectP256: requireCompressedHex(input.phoneDirectP256, 'phoneDirectP256'),
    vaultCosignerBase: requireCompressedHex(input.vaultCosignerBase, 'vaultCosignerBase'),
    arkadeCosignerBase: requireCompressedHex(input.arkadeCosignerBase, 'arkadeCosignerBase'),
    absoluteFeeCapSats: policy.absoluteFeeCapSats,
    feerateCapSatPerV: policy.feerateCapSatPerV,
  }
  const family = buildConnectorFamily(familyInput)
  const digest = connectorEnrollmentDigest({ ...familyInput, protectionTier, spendingPolicy: policy }, origin)
  const hasRecovery = Boolean(input.recoveryPub)
  const pending = {} as VaultProgramDescriptor['pending']
  const quarantine = {} as VaultProgramDescriptor['quarantine']
  for (const key of familyKeysFor(hasRecovery)) {
    pending[key] = {
      script: hex.encode(family.pending[key].script),
      address: family.pending[key].address,
      delay: family.pending[key].delay,
    }
    quarantine[key] = {
      script: hex.encode(family.quarantine[key].script),
      address: family.quarantine[key].address,
      guardians: [...family.quarantine[key].guardians],
    }
  }
  const descriptor: VaultProgramDescriptor = {
    connectorType: input.origin.connectorType,
    schema: PROGRAM_SCHEMA,
    network,
    vaultId: input.vaultId,
    templateVersion: input.templateVersion ?? CONNECTOR_TEMPLATE,
    policyVersion: POLICY_VERSION,
    protectionTier,
    keys: {
      phoneBip340: familyInput.phonePub,
      phoneDirectP256: familyInput.phoneDirectP256,
      hardware: familyInput.hardwarePub,
      ...(familyInput.recoveryPub ? { recovery: familyInput.recoveryPub } : {}),
      vaultCosignerBase: familyInput.vaultCosignerBase,
      arkadeCosignerBase: familyInput.arkadeCosignerBase,
    },
    tweaks: { initiate: family.initiateTweaks, pending: family.pendingTweaks },
    arkadeCosigner: { origin: input.arkadeOrigin.trim(), version: input.arkadeVersion.trim() },
    csv: { ...PROGRAM_CSV },
    policy: {
      program: policy.program,
      schema: policy.schema,
      period: policy.period,
      digest: spendingPolicyDigest(policy, network),
      recipientDustSats: DUST_SATS,
      recipientCapSats: policy.txRecipientCapSats,
      periodAllowanceSats: policy.periodAllowanceSats,
      absoluteFeeCapSats: policy.absoluteFeeCapSats,
      feerateCapSatVb: policy.feerateCapSatPerV,
    },
    p2a: { script: P2A_SCRIPT_HEX, valueSats: P2A_VALUE_SATS, outputIndex: P2A_OUTPUT_INDEX },
    transitionSequence: TRANSITION_SEQUENCE,
    savings: { script: hex.encode(family.savings.script), address: family.savings.address },
    pending,
    quarantine,
  }
  const savingsHash = hex.encode(sha256(encodeRawVaultProgramDescriptor(descriptor)))
  // The boarding half is skipped when no boarding descriptor is supplied
  // (digest-only re-verification); the composite always commits boarding.
  const boardingHash = input.boarding ? hashConnectorBoarding(input.vaultId, savingsHash, input.boarding) : ''
  const compositeHash = input.boarding ? hashConnectorBoardComposite(digest, boardingHash) : ''
  return {
    family,
    origin,
    digest,
    savingsHash,
    boardingHash,
    compositeHash,
    descriptor,
    policy,
    protectionTier,
  }
}

export const CONNECTOR_KIT_NAME = 'arkade-connector-enrollment'
export const CONNECTOR_KIT_VERSION = 1

// Versioned connector recovery binding. Old Recovery Kit bytes are untouched:
// this is a distinct document for connector vaults carrying the origin,
// enrollment digest, and boarding descriptor needed to re-verify and recover.
export interface ConnectorRecoveryKit {
  templateVersion?: string
  name: typeof CONNECTOR_KIT_NAME
  version: typeof CONNECTOR_KIT_VERSION
  vaultId: string
  network: ConnectorEnrollmentNetwork
  protectionTier: ProtectionTier
  origin: ConnectorEnrollmentOrigin
  enrollmentDigest: string
  savingsAddress: string
  savingsScript: string
  connectorScript: string
  phonePub: string
  phoneDirectP256: string
  recoveryPub?: string
  vaultCosignerBase: string
  arkadeCosignerBase: string
  arkadeOrigin: string
  arkadeVersion: string
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
  boarding: BoardingDescriptor
  savingsHash: string
  boardingHash: string
  descriptorHash: string
}

export function buildConnectorRecoveryKit(
  preview: Pick<
    ConnectorEnrollmentPreview,
    'digest' | 'savingsHash' | 'boardingHash' | 'compositeHash' | 'policy' | 'protectionTier' | 'descriptor' | 'family'
  >,
  input: {
    vaultId: string
    network: ConnectorEnrollmentNetwork
    origin: ConnectorEnrollmentOrigin
    boarding: BoardingDescriptor
  },
): ConnectorRecoveryKit {
  return {
    name: CONNECTOR_KIT_NAME,
    version: CONNECTOR_KIT_VERSION,
    ...(preview.descriptor.templateVersion !== CONNECTOR_TEMPLATE
      ? { templateVersion: preview.descriptor.templateVersion }
      : {}),
    vaultId: input.vaultId,
    network: input.network,
    protectionTier: preview.protectionTier,
    origin: { ...input.origin, connectorPath: [...input.origin.connectorPath] },
    enrollmentDigest: preview.digest,
    savingsAddress: preview.descriptor.savings.address,
    savingsScript: preview.descriptor.savings.script,
    connectorScript: hex.encode(preview.family.connector.script),
    phonePub: preview.descriptor.keys.phoneBip340,
    phoneDirectP256: preview.descriptor.keys.phoneDirectP256,
    ...(preview.descriptor.keys.recovery ? { recoveryPub: preview.descriptor.keys.recovery } : {}),
    vaultCosignerBase: preview.descriptor.keys.vaultCosignerBase,
    arkadeCosignerBase: preview.descriptor.keys.arkadeCosignerBase,
    arkadeOrigin: preview.descriptor.arkadeCosigner.origin,
    arkadeVersion: preview.descriptor.arkadeCosigner.version,
    spendingPolicy: preview.policy,
    spendingPolicyDigest: preview.descriptor.policy.digest,
    boarding: input.boarding,
    savingsHash: preview.savingsHash,
    boardingHash: preview.boardingHash,
    descriptorHash: preview.compositeHash,
  }
}

// Re-verifies the kit offline: rebuilds the full preview from kit facts and
// requires every committed hash to match. Throws on any drift.
export function parseConnectorRecoveryKit(raw: unknown): ConnectorRecoveryKit {
  const kit = raw as ConnectorRecoveryKit
  if (!kit || kit.name !== CONNECTOR_KIT_NAME) fail('not a connector enrollment kit')
  if (kit.version !== CONNECTOR_KIT_VERSION) fail('unsupported connector kit version')
  const rebuilt = buildConnectorEnrollmentPreview({
    vaultId: kit.vaultId,
    templateVersion: kit.templateVersion ?? CONNECTOR_TEMPLATE,
    network: kit.network,
    protectionTier: kit.protectionTier,
    phonePub: kit.phonePub,
    phoneDirectP256: kit.phoneDirectP256,
    ...(kit.recoveryPub ? { recoveryPub: kit.recoveryPub } : {}),
    vaultCosignerBase: kit.vaultCosignerBase,
    arkadeCosignerBase: kit.arkadeCosignerBase,
    arkadeOrigin: kit.arkadeOrigin,
    arkadeVersion: kit.arkadeVersion,
    spendingPolicy: kit.spendingPolicy,
    origin: kit.origin,
    boarding: kit.boarding,
  })
  if (rebuilt.digest !== kit.enrollmentDigest) fail('connector kit digest does not match rebuild')
  if (rebuilt.savingsHash !== kit.savingsHash) fail('connector kit savings hash does not match rebuild')
  if (rebuilt.boardingHash !== kit.boardingHash) fail('connector kit boarding hash does not match rebuild')
  if (rebuilt.compositeHash !== kit.descriptorHash) fail('connector kit hash does not match rebuild')
  if (rebuilt.descriptor.savings.script !== kit.savingsScript)
    fail('connector kit Savings script does not match rebuild')
  if (rebuilt.descriptor.savings.address !== kit.savingsAddress)
    fail('connector kit Savings address does not match rebuild')
  if (hex.encode(rebuilt.family.connector.script) !== kit.connectorScript)
    fail('connector kit script does not match rebuild')
  return kit
}

// Adapt the versioned connector kit to the common recovery transaction tools.
// Origin and all enrollment hashes are verified before exposing a descriptor.
export function connectorRecoveryDescriptor(raw: unknown): VaultProgramDescriptor {
  const kit = parseConnectorRecoveryKit(raw)
  return buildConnectorEnrollmentPreview({
    vaultId: kit.vaultId,
    templateVersion: kit.templateVersion ?? CONNECTOR_TEMPLATE,
    network: kit.network,
    protectionTier: kit.protectionTier,
    origin: kit.origin,
    phonePub: kit.phonePub,
    phoneDirectP256: kit.phoneDirectP256,
    vaultCosignerBase: kit.vaultCosignerBase,
    arkadeCosignerBase: kit.arkadeCosignerBase,
    arkadeOrigin: kit.arkadeOrigin,
    arkadeVersion: kit.arkadeVersion,
    recoveryPub: kit.recoveryPub,
    spendingPolicy: kit.spendingPolicy,
    boarding: kit.boarding,
  }).descriptor
}
