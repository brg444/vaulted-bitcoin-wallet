import { hex } from '@scure/base'
import { isConnectorTemplate, CONNECTOR_TEMPLATE, DUAL_CONNECTOR_TEMPLATE, DUAL_CONNECTOR_PROGRAM } from './connector'
import { requireBoardingDescriptor } from '../vtxo/board'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import type { BoardingDescriptor, VaultStatus } from '../types'
import type { ProtectionTier } from '../protectionTier'
import type { FamilyKey } from './constants'
import {
  CONNECTOR_ENROLLMENT_SCHEMA,
  CONNECTOR_DESCRIPTOR_SCHEMA,
  buildConnectorEnrollmentPreview,
  buildConnectorRecoveryKit,
  parseConnectorRecoveryKit,
  parseConnectorOriginPath,
  fail,
  requireCompressedHex,
  requireUint32,
  type ConnectorEnrollmentOrigin,
  type ConnectorEnrollmentNetwork,
  type ConnectorEnrollmentType,
  type ConnectorEnrollmentPreview,
  type ConnectorRecoveryKit,
} from './connectorEnrollmentCore'
export * from './connectorEnrollmentCore'

// Independent wallet-side reconstruction of the connector enrollment
// commitment. The backend preview (connector_enroll.go) commits
// sha256(0x01 || enrollmentDigest || boardingHash), where the boarding half
// hashes the legacy Savings descriptor layout with the ACTUAL enrolled
// connector Savings tree substituted in. This module rebuilds that exact tuple
// from staged public facts plus server-carried cosigner bases, so a mismatched
// preview fails closed before finish. Nothing here creates keys, touches the
// network, or trusts a stored script: every script/address is recomputed.

export interface ConnectorProposalExpectation {
  templateVersion?: string
  vaultId: string
  network: ConnectorEnrollmentNetwork
  phonePub: string
  phoneDirectP256: string
  recoveryPub?: string
  protectionTier: ProtectionTier
  spendingPolicy: SpendingPolicy
  spendingPolicyDigest: string
  origin: ConnectorEnrollmentOrigin
  boardingPub: string
  arkadeOrigin?: string
  arkadeVersion: string
}

export interface VerifiedConnectorProposal {
  digest: string
  savingsHash: string
  boardingHash: string
  compositeHash: string
  connectorType: ConnectorEnrollmentType
  fingerprint: number
  originPath: number[]
  program: string
  savingsScript: string
  savingsAddress: string
  connectorScript: string
  boarding: BoardingDescriptor
  policy: SpendingPolicy
  protectionTier: ProtectionTier
  preview: ConnectorEnrollmentPreview
}

// Verify the backend preview against a full local reconstruction. Every
// committed value is recomputed; only the composite hash is compared.
export function requireProposedConnectorDescriptor(
  raw: unknown,
  proposedHash: string,
  expected: ConnectorProposalExpectation,
): VerifiedConnectorProposal {
  if (!/^[0-9a-f]{64}$/.test(proposedHash)) fail('connector enrollment hash required')
  if (!raw || typeof raw !== 'object') fail('connector enrollment preview required')
  const composite = raw as Record<string, unknown>
  if (composite.schema !== CONNECTOR_ENROLLMENT_SCHEMA || composite.vaultId !== expected.vaultId)
    fail('connector enrollment preview has the wrong schema')
  const connector = composite.connector as Record<string, unknown>
  if (!connector || typeof connector !== 'object') fail('connector enrollment preview is missing its descriptor')
  if (
    connector.schema !== CONNECTOR_DESCRIPTOR_SCHEMA ||
    connector.template !== (expected.templateVersion ?? CONNECTOR_TEMPLATE) ||
    connector.vaultId !== expected.vaultId ||
    connector.network !== expected.network ||
    connector.protectionTier !== expected.protectionTier
  )
    fail('connector enrollment preview does not match this setup')
  if (connector.connectorType !== expected.origin.connectorType) fail('connector type does not match descriptor import')
  if (String(connector.hardwarePub || '').toLowerCase() !== expected.origin.connectorPub.toLowerCase())
    fail('connector key does not match descriptor import')
  if (connector.fingerprint !== expected.origin.connectorFingerprint)
    fail('connector fingerprint does not match import')
  const originPath = parseConnectorOriginPath(connector.originPath)
  if (
    originPath.length !== expected.origin.connectorPath.length ||
    originPath.some((step, i) => step !== expected.origin.connectorPath[i])
  )
    fail('connector origin path does not match import')
  if (String(connector.phonePub || '').toLowerCase() !== expected.phonePub.toLowerCase())
    fail('connector preview phone key does not match this wallet')
  const wantRecovery = expected.protectionTier === 'advanced'
  if (
    (String(connector.recoveryPub || '').toLowerCase() || undefined) !==
    (expected.recoveryPub?.toLowerCase() || undefined)
  )
    fail('connector preview recovery key does not match this setup')
  if (!wantRecovery && connector.recoveryPub) fail('this setup skipped recovery')
  if (String(connector.phoneDirectP256 || '').toLowerCase() !== expected.phoneDirectP256.toLowerCase())
    fail('connector preview direct key does not match this wallet')
  if (connector.spendingPolicyDigest !== expected.spendingPolicyDigest)
    fail('connector preview spending policy does not match this setup')
  const arkadeOrigin = typeof connector.arkadeOrigin === 'string' ? connector.arkadeOrigin.trim() : ''
  const arkadeVersion = typeof connector.arkadeVersion === 'string' ? connector.arkadeVersion.trim() : ''
  if (!arkadeOrigin || arkadeOrigin === 'configured' || !arkadeVersion || arkadeVersion !== expected.arkadeVersion)
    fail('connector preview is missing its committed Arkade identity')
  if (expected.arkadeOrigin && arkadeOrigin !== expected.arkadeOrigin) fail('connector preview Arkade identity changed')
  const boarding = requireBoardingDescriptor(composite.boarding, {
    vaultId: expected.vaultId,
    phonePub: expected.phonePub,
    boardingPub: expected.boardingPub,
    network: expected.network,
  })
  const preview = buildConnectorEnrollmentPreview({
    templateVersion: String(connector.template),
    vaultId: expected.vaultId,
    network: expected.network,
    protectionTier: expected.protectionTier,
    phonePub: expected.phonePub,
    phoneDirectP256: expected.phoneDirectP256,
    ...(expected.recoveryPub ? { recoveryPub: expected.recoveryPub } : {}),
    vaultCosignerBase: requireCompressedHex(connector.vaultCosignerBase, 'vaultCosignerBase'),
    arkadeCosignerBase: requireCompressedHex(connector.arkadeCosignerBase, 'arkadeCosignerBase'),
    arkadeOrigin,
    arkadeVersion,
    spendingPolicy: expected.spendingPolicy,
    origin: expected.origin,
    boarding,
  })
  if (
    spendingPolicyDigest(preview.policy, expected.network) !==
    spendingPolicyDigest(expected.spendingPolicy, expected.network)
  )
    fail('connector preview spending policy does not match this setup')
  if (preview.digest !== connector.enrollmentDigest) fail('connector enrollment digest does not match reconstruction')
  if (hex.encode(preview.family.program) !== connector.program) fail('connector program does not match reconstruction')
  if (hex.encode(preview.family.savings.script) !== connector.savingsScript)
    fail('connector Savings script does not match reconstruction')
  if (preview.family.savings.address !== connector.savingsAddress)
    fail('connector Savings address does not match reconstruction')
  if (hex.encode(preview.family.connector.script) !== connector.connectorScript)
    fail('connector script does not match reconstruction')
  if (preview.compositeHash !== proposedHash.toLowerCase())
    fail('connector enrollment hash does not match reconstruction')
  return {
    digest: preview.digest,
    savingsHash: preview.savingsHash,
    boardingHash: preview.boardingHash,
    compositeHash: preview.compositeHash,
    connectorType: expected.origin.connectorType,
    fingerprint: expected.origin.connectorFingerprint,
    originPath: [...expected.origin.connectorPath],
    program: hex.encode(preview.family.program),
    savingsScript: hex.encode(preview.family.savings.script),
    savingsAddress: preview.family.savings.address,
    connectorScript: hex.encode(preview.family.connector.script),
    boarding,
    policy: preview.policy,
    protectionTier: preview.protectionTier,
    preview,
  }
}

export interface ConnectorEnrollmentPin {
  vaultId: string
  network: ConnectorEnrollmentNetwork
  connectorPub: string
  connectorType: ConnectorEnrollmentType
  connectorFingerprint: number
  connectorPath: number[]
  enrollmentDigest: string
  descriptorHash: string
  savingsAddress: string
  savingsScript: string
  protectionTier: ProtectionTier
}

function requirePinShape(pin: ConnectorEnrollmentPin): void {
  if (!pin || typeof pin !== 'object') fail('connector enrollment pin required')
  if (!pin.vaultId.trim() || (pin.network !== 'mainnet' && pin.network !== 'mutinynet'))
    fail('connector enrollment pin required')
  requireCompressedHex(pin.connectorPub, 'connectorPub')
  if (pin.connectorType !== 'p2wpkh' && pin.connectorType !== 'p2tr') fail('connector enrollment pin required')
  requireUint32(pin.connectorFingerprint, 'connectorFingerprint')
  if (!Array.isArray(pin.connectorPath) || pin.connectorPath.length < 1 || pin.connectorPath.length > 255)
    fail('connector enrollment pin required')
  pin.connectorPath.forEach((step) => requireUint32(step, 'connectorPath'))
  if (!/^[0-9a-f]{64}$/.test(pin.enrollmentDigest) || !/^[0-9a-f]{64}$/.test(pin.descriptorHash))
    fail('connector enrollment pin required')
  if (!pin.savingsAddress.trim() || !/^[0-9a-f]+$/.test(pin.savingsScript)) fail('connector enrollment pin required')
}

// Reconstruct the status commitment and compare it to the retained enrollment
// pin. Fresh-device pins are restored only after verifying the signed binding.
export function verifyConnectorStatus(
  status: VaultStatus,
  pin: ConnectorEnrollmentPin,
  options?: { boardingPub?: string; arkadeOrigin?: string; arkadeVersion?: string },
): void {
  requirePinShape(pin)
  if (!status?.enrolled) fail('vault is not enrolled')
  if (status.vaultId !== pin.vaultId) fail('connector vault id does not match enrollment')
  if (status.network !== pin.network) fail('connector network does not match enrollment')
  if (!isConnectorTemplate(status.templateVersion)) fail('vault is not a connector enrollment')
  const identity = status.connectorEnrollment
  if (
    !identity ||
    identity.connectorPub !== pin.connectorPub ||
    identity.connectorType !== pin.connectorType ||
    identity.connectorFingerprint !== pin.connectorFingerprint ||
    identity.connectorPath.join('/') !== pin.connectorPath.join('/') ||
    identity.enrollmentDigest !== pin.enrollmentDigest ||
    identity.descriptorHash !== pin.descriptorHash
  )
    fail('connector status origin does not match enrollment')
  if (status.protectionTier !== pin.protectionTier) fail('connector protection tier changed')
  if (String(status.externalOwnerWalletPub || '').toLowerCase() !== pin.connectorPub.toLowerCase())
    fail('connector key does not match enrolled hardware')
  if (status.savingsAddress !== pin.savingsAddress) fail('connector Savings address changed')
  if (String(status.savingsScript || '').toLowerCase() !== pin.savingsScript.toLowerCase())
    fail('connector Savings script changed')
  const phonePub = String(status.phoneBip340Pub || '')
  const phoneDirectP256 = String(status.phoneDirectP256 || '')
  const vaultCosignerBase = String(status.vaultCosignerBasePub || '')
  const arkadeCosignerBase = String(status.arkadeCosignerBasePub || '')
  if (!phonePub || !phoneDirectP256 || !vaultCosignerBase || !arkadeCosignerBase)
    fail('connector status is missing enrolled facts')
  const policy = validateSpendingPolicy(status.spendingPolicy as SpendingPolicy, pin.network)
  if (status.spendingPolicyDigest && status.spendingPolicyDigest !== spendingPolicyDigest(policy, pin.network))
    fail('connector spending policy changed')
  const arkadeOrigin = String(options?.arkadeOrigin ?? status.arkadeCosignerOrigin ?? '').trim()
  const arkadeVersion = String(options?.arkadeVersion ?? status.arkadeCosignerVersion ?? '').trim()
  if (!arkadeOrigin || !arkadeVersion) fail('connector status is missing Arkade identity')
  const recoveryPub = String(status.recoveryPub || status.recoveryKeyPub || '') || undefined
  let boarding: BoardingDescriptor | undefined
  // The full composite commitment pins boarding as well as Savings. A fresh
  // status response cannot replace its boarding key or cosigner identity.
  if (status.vtxoBoardingDescriptor) {
    boarding = requireBoardingDescriptor(status.vtxoBoardingDescriptor, {
      vaultId: pin.vaultId,
      phonePub,
      boardingPub: options?.boardingPub ?? status.vtxoBoardingDescriptor.boardingPub,
      network: pin.network,
    })
  }
  const preview = buildConnectorEnrollmentPreview({
    vaultId: pin.vaultId,
    templateVersion: status.templateVersion,
    network: pin.network,
    protectionTier: pin.protectionTier,
    phonePub,
    phoneDirectP256,
    ...(recoveryPub ? { recoveryPub } : {}),
    vaultCosignerBase,
    arkadeCosignerBase,
    arkadeOrigin,
    arkadeVersion,
    spendingPolicy: policy,
    origin: {
      connectorPub: pin.connectorPub,
      connectorType: pin.connectorType,
      connectorFingerprint: pin.connectorFingerprint,
      connectorPath: [...pin.connectorPath],
    },
    ...(boarding ? { boarding } : {}),
  })
  if (preview.digest !== pin.enrollmentDigest.toLowerCase())
    fail('enrolled connector digest does not match this wallet')
  if (boarding && preview.compositeHash !== identity.descriptorHash) fail('connector composite hash changed')
  if (!boarding) fail('connector boarding descriptor required')
  if (boarding) {
    if (!status.vtxoBoardingDescriptorHash) fail('vault-board-v1 descriptor hash required')
    if (preview.boardingHash !== status.vtxoBoardingDescriptorHash.toLowerCase())
      fail('enrolled boarding descriptor does not match this wallet')
  }
}

export interface ConnectorPreflight {
  network: ConnectorEnrollmentNetwork
}

export interface ConnectorCapability {
  schema: string
  program: string
  template: string
  reserveSats: number
  enrollmentSchema: string
}
export const REQUIRED_CONNECTOR_CAPABILITY: ConnectorCapability = {
  schema: 'arkade-vault/connector-capability-v1',
  program: DUAL_CONNECTOR_PROGRAM,
  template: DUAL_CONNECTOR_TEMPLATE,
  reserveSats: 1000,
  enrollmentSchema: CONNECTOR_ENROLLMENT_SCHEMA,
}
export function requireConnectorCapability(publicStatus: { connectorCapability?: ConnectorCapability }): void {
  const advertised = publicStatus.connectorCapability
  if (
    !advertised ||
    Object.entries(REQUIRED_CONNECTOR_CAPABILITY).some(
      ([key, value]) => advertised[key as keyof ConnectorCapability] !== value,
    )
  )
    fail('Guardian does not support connector enrollment')
}

// Capability preflight runs BEFORE passkey creation. It checks everything the
// public status advertises (network, boarding program, policy bounds) and
// requires the versioned connector enrollment capability. An old Guardian
// without that capability fails here — never after creating a passkey. The
// propose-time unknown-field mapping in tenantEnrollment remains as backstop.
export function preflightConnectorEnrollment(
  publicStatus: { network: string; vtxoBoardingProgram?: string; connectorCapability?: ConnectorCapability },
  network: ConnectorEnrollmentNetwork,
  policy: SpendingPolicy,
): ConnectorPreflight {
  if (network !== 'mainnet' && network !== 'mutinynet') fail('unsupported network')
  if (publicStatus.network !== network) fail('connector enrollment network mismatch')
  if (publicStatus.vtxoBoardingProgram !== 'vault-board-v1')
    fail('vault service does not advertise the required boarding program')
  validateSpendingPolicy(policy, network)
  requireConnectorCapability(publicStatus)
  return { network }
}

const CONNECTOR_PIN_STORE = 'arkade-vault-connector-enrollment'

export function connectorPinKey(vaultId: string): string {
  const id = String(vaultId || '').trim()
  if (!id) fail('vault id required')
  return `${CONNECTOR_PIN_STORE}:${id}`
}

export function saveConnectorEnrollmentPin(pin: ConnectorEnrollmentPin, storage: Storage = localStorage): void {
  requirePinShape(pin)
  storage.setItem(connectorPinKey(pin.vaultId), JSON.stringify(pin))
}

export function loadConnectorEnrollmentPin(
  vaultId: string,
  storage: Storage = localStorage,
): ConnectorEnrollmentPin | null {
  const raw = storage.getItem(connectorPinKey(vaultId))
  if (!raw) return null
  try {
    const pin = JSON.parse(raw) as ConnectorEnrollmentPin
    requirePinShape(pin)
    return pin
  } catch {
    return null
  }
}

export function connectorOriginFromImport(result: {
  type: ConnectorEnrollmentType
  publicKey: string
  fingerprint: number
  path: number[]
  address: string
  selectedPath: string
}): ConnectorEnrollmentOrigin & { address: string; selectedPath: string } {
  return {
    connectorPub: result.publicKey,
    connectorType: result.type,
    connectorFingerprint: result.fingerprint,
    connectorPath: [...result.path],
    address: result.address,
    selectedPath: result.selectedPath,
  }
}

const CONNECTOR_KIT_STORE = 'arkade-vault-connector-kit'

export function connectorKitKey(vaultId: string): string {
  const id = String(vaultId || '').trim()
  if (!id) fail('vault id required')
  return `${CONNECTOR_KIT_STORE}:${id}`
}

export function saveConnectorRecoveryKit(kit: ConnectorRecoveryKit, storage: Storage = localStorage): void {
  parseConnectorRecoveryKit(kit)
  storage.setItem(connectorKitKey(kit.vaultId), JSON.stringify(kit))
}

export function loadConnectorRecoveryKit(
  vaultId: string,
  storage: Storage = localStorage,
): ConnectorRecoveryKit | null {
  const raw = storage.getItem(connectorKitKey(vaultId))
  if (!raw) return null
  try {
    return parseConnectorRecoveryKit(JSON.parse(raw))
  } catch {
    return null
  }
}

// Explicit kit restoration uses the versioned public map saved at enrollment.
// Fresh-device passkey sign-in instead verifies the version-5 signed binding.
// Returns null when no parseable kit exists; the caller must then treat the
// vault as unverified for connector operations.
export function restoreConnectorPinFromKit(
  vaultId: string,
  storage: Storage = localStorage,
): ConnectorEnrollmentPin | null {
  const kit = loadConnectorRecoveryKit(vaultId, storage)
  if (!kit) return null
  const pin: ConnectorEnrollmentPin = {
    vaultId: kit.vaultId,
    network: kit.network,
    connectorPub: kit.origin.connectorPub,
    connectorType: kit.origin.connectorType,
    connectorFingerprint: kit.origin.connectorFingerprint,
    connectorPath: [...kit.origin.connectorPath],
    enrollmentDigest: kit.enrollmentDigest,
    descriptorHash: kit.descriptorHash,
    savingsAddress: kit.savingsAddress,
    savingsScript: kit.savingsScript,
    protectionTier: kit.protectionTier,
  }
  requirePinShape(pin)
  saveConnectorEnrollmentPin(pin, storage)
  return pin
}

export type { FamilyKey }

// Call only after the existing phone/direct signatures have authenticated the
// recovery binding and every status field has been compared to that binding.
export function connectorPinFromVerifiedStatus(status: VaultStatus): ConnectorEnrollmentPin {
  const identity = status.connectorEnrollment
  if (
    !identity ||
    (status.network !== 'mainnet' && status.network !== 'mutinynet') ||
    (status.protectionTier !== 'standard' && status.protectionTier !== 'advanced')
  )
    fail('connector enrollment identity required')
  const pin: ConnectorEnrollmentPin = {
    vaultId: status.vaultId,
    network: status.network,
    protectionTier: status.protectionTier,
    ...identity,
    savingsAddress: status.savingsAddress,
    savingsScript: status.savingsScript,
  }
  verifyConnectorStatus(status, pin)
  return pin
}

export function connectorKitFromVerifiedStatus(status: VaultStatus): ConnectorRecoveryKit {
  const pin = connectorPinFromVerifiedStatus(status)
  const origin: ConnectorEnrollmentOrigin = {
    connectorType: pin.connectorType,
    connectorPub: pin.connectorPub,
    connectorFingerprint: pin.connectorFingerprint,
    connectorPath: [...pin.connectorPath],
  }
  const boarding = status.vtxoBoardingDescriptor!
  const preview = buildConnectorEnrollmentPreview({
    vaultId: pin.vaultId,
    templateVersion: status.templateVersion,
    network: pin.network,
    protectionTier: pin.protectionTier,
    origin,
    phonePub: status.phoneBip340Pub!,
    phoneDirectP256: status.phoneDirectP256!,
    vaultCosignerBase: status.vaultCosignerBasePub!,
    arkadeCosignerBase: status.arkadeCosignerBasePub!,
    arkadeOrigin: status.arkadeCosignerOrigin!,
    arkadeVersion: status.arkadeCosignerVersion!,
    recoveryPub: status.recoveryPub || status.recoveryKeyPub,
    spendingPolicy: validateSpendingPolicy(status.spendingPolicy, pin.network),
    boarding,
  })
  return buildConnectorRecoveryKit(preview, { vaultId: pin.vaultId, network: pin.network, origin, boarding })
}
