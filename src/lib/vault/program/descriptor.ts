import { buildConnectorFamily, CONNECTOR_TEMPLATE, type ConnectorKind } from './connector'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { DUST_SATS, POLICY_VERSION, SUPPORTED_NETWORKS, type VaultNetwork } from '../constants'
import { bytesToHex, encodeUtf8, hexToBytes, requireLowerHex } from '../hex'
import {
  familyClaimants,
  familyKeysFor,
  P2A_OUTPUT_INDEX,
  P2A_SCRIPT_HEX,
  P2A_VALUE_SATS,
  TRANSITION_SEQUENCE,
  PROGRAM_CSV,
  PROGRAM_SCHEMA,
  isSavingsTemplate,
  SAVINGS_TEMPLATE,
  type Claimant,
  type FamilyKey,
} from './constants'
import {
  defaultSpendingPolicy,
  spendingPolicyDigest,
  validateSpendingPolicy,
  type SpendingPolicy,
} from '../spendingPolicy'
import { requireProtectionTier, requireProtectionTierMatchesRecovery, type ProtectionTier } from '../protectionTier'
import { type InitiateTweaks, buildVaultProgramFamily } from './trees'

const COMPRESSED = 33

export interface ProgramTreeRef {
  script: string
  address: string
}

export interface VaultProgramDescriptor {
  connectorType?: ConnectorKind
  schema: typeof PROGRAM_SCHEMA
  network: VaultNetwork
  vaultId: string
  templateVersion: string
  policyVersion: string
  protectionTier: ProtectionTier
  keys: {
    phoneBip340: string
    phoneDirectP256: string
    hardware: string
    recovery?: string
    vaultCosignerBase: string
    arkadeCosignerBase: string
  }
  tweaks: {
    initiate: InitiateTweaks
    pending: Record<FamilyKey, { vault: string; arkade: string }>
  }
  arkadeCosigner: {
    origin: string
    version: string
  }
  csv: {
    hardware: number
    phone: number
    recovery: number
  }
  policy: {
    program: SpendingPolicy['program']
    schema: SpendingPolicy['schema']
    period: SpendingPolicy['period']
    digest: string
    recipientDustSats: number
    recipientCapSats: number
    periodAllowanceSats: number
    absoluteFeeCapSats: number
    feerateCapSatVb: number
  }
  p2a: {
    script: string
    valueSats: number
    outputIndex: number
  }
  transitionSequence: number
  savings: ProgramTreeRef
  pending: Record<FamilyKey, ProgramTreeRef & { delay: number }>
  quarantine: Record<FamilyKey, ProgramTreeRef & { guardians: readonly string[] }>
}

export interface VaultProgramDescriptorInput {
  vaultId: string
  network: VaultNetwork
  phonePub: string
  hardwarePub: string
  recoveryPub?: string
  phoneDirectP256: string
  vaultCosignerBase: string
  arkadeCosignerBase: string
  arkadeCosigner: {
    origin: string
    version: string
  }
  templateVersion?: string
  connectorType?: ConnectorKind
  protectionTier: ProtectionTier
  spendingPolicy?: SpendingPolicy
}

function appendU32(parts: Uint8Array[], value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} is not a uint32`)
  }
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value, false)
  parts.push(buf)
}

function appendI64(parts: Uint8Array[], value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} is not a safe non-negative integer`)
  }
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), false)
  parts.push(buf)
}

function appendBytes(parts: Uint8Array[], bytes: Uint8Array) {
  appendU32(parts, bytes.length, 'length')
  parts.push(bytes)
}

function appendHex(parts: Uint8Array[], value: string, name: string, exactBytes: number) {
  appendBytes(parts, hexToBytes(requireLowerHex(value, name, exactBytes)))
}

function appendText(parts: Uint8Array[], value: string, name: string) {
  if (!value || value !== value.trim() || value !== value.toLowerCase()) {
    throw new Error(`${name} must be non-empty canonical lowercase`)
  }
  appendBytes(parts, encodeUtf8(value))
}

function appendRawText(parts: Uint8Array[], value: string, name: string) {
  if (!value || value !== value.trim()) throw new Error(`${name} required`)
  appendBytes(parts, encodeUtf8(value))
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function requireSecp(pub: string, name: string): string {
  const hexKey = requireLowerHex(pub, name, COMPRESSED)
  if (hexKey[1] !== '2' && hexKey[1] !== '3') throw new Error(`${name} must be compressed`)
  if (!secp256k1.utils.isValidPublicKey(hexToBytes(hexKey), true)) {
    throw new Error(`${name} is not a valid secp256k1 public key`)
  }
  return hexKey
}

function requireP256(pub: string, name: string): string {
  const hexKey = requireLowerHex(pub, name, COMPRESSED)
  if (hexKey[0] !== '0' || (hexKey[1] !== '2' && hexKey[1] !== '3')) {
    throw new Error(`${name} must be compressed`)
  }
  if (!p256.utils.isValidPublicKey(hexToBytes(hexKey), true)) {
    throw new Error(`${name} is not a valid P-256 public key`)
  }
  return hexKey
}

function requirePair(pair: { vault: string; arkade: string }, name: string) {
  return {
    vault: requireSecp(pair.vault, `${name}.vault`),
    arkade: requireSecp(pair.arkade, `${name}.arkade`),
  }
}

function treeRef(script: Uint8Array, address: string): ProgramTreeRef {
  return { script: hex.encode(script), address }
}

export function buildVaultProgramDescriptor(input: VaultProgramDescriptorInput): VaultProgramDescriptor {
  const keys = {
    phoneBip340: requireSecp(input.phonePub, 'phone'),
    phoneDirectP256: requireP256(input.phoneDirectP256, 'phoneDirectP256'),
    hardware: requireSecp(input.hardwarePub, 'hardware'),
    ...(input.recoveryPub ? { recovery: requireSecp(input.recoveryPub, 'recovery') } : {}),
    vaultCosignerBase: requireSecp(input.vaultCosignerBase, 'vaultCosignerBase'),
    arkadeCosignerBase: requireSecp(input.arkadeCosignerBase, 'arkadeCosignerBase'),
  }
  if (!input.arkadeCosigner.origin.trim() || !input.arkadeCosigner.version.trim()) {
    throw new Error('arkade cosigner origin and version required')
  }
  const selectedPolicy = validateSpendingPolicy(
    input.spendingPolicy || defaultSpendingPolicy(input.network),
    input.network,
  )
  const protectionTier = requireProtectionTierMatchesRecovery(input.protectionTier, keys.recovery)
  const family = buildDescriptorFamily({
    vaultId: input.vaultId,
    phonePub: keys.phoneBip340,
    hardwarePub: keys.hardware,
    recoveryPub: keys.recovery,
    phoneDirectP256: keys.phoneDirectP256,
    vaultCosignerBase: keys.vaultCosignerBase,
    arkadeCosignerBase: keys.arkadeCosignerBase,
    network: input.network,
    templateVersion: input.templateVersion || SAVINGS_TEMPLATE,
    ...(input.connectorType ? { connectorType: input.connectorType } : {}),
    absoluteFeeCapSats: selectedPolicy.absoluteFeeCapSats,
    feerateCapSatPerV: selectedPolicy.feerateCapSatPerV,
  })
  const tweaks = {
    initiate: family.initiateTweaks,
    pending: family.pendingTweaks,
  }
  const pending = {} as VaultProgramDescriptor['pending']
  const quarantine = {} as VaultProgramDescriptor['quarantine']
  for (const key of familyKeysFor(Boolean(keys.recovery))) {
    pending[key] = {
      ...treeRef(family.pending[key].script, family.pending[key].address),
      delay: family.pending[key].delay,
    }
    quarantine[key] = {
      ...treeRef(family.quarantine[key].script, family.quarantine[key].address),
      guardians: family.quarantine[key].guardians,
    }
  }
  return validateVaultProgramDescriptor({
    schema: PROGRAM_SCHEMA,
    network: input.network,
    vaultId: input.vaultId,
    templateVersion: input.templateVersion || SAVINGS_TEMPLATE,
    ...(input.connectorType ? { connectorType: input.connectorType } : {}),
    policyVersion: POLICY_VERSION,
    protectionTier,
    keys,
    tweaks,
    arkadeCosigner: {
      origin: input.arkadeCosigner.origin.trim(),
      version: input.arkadeCosigner.version.trim(),
    },
    csv: { ...PROGRAM_CSV },
    policy: {
      program: selectedPolicy.program,
      schema: selectedPolicy.schema,
      period: selectedPolicy.period,
      digest: spendingPolicyDigest(selectedPolicy, input.network),
      recipientDustSats: DUST_SATS,
      recipientCapSats: selectedPolicy.txRecipientCapSats,
      periodAllowanceSats: selectedPolicy.periodAllowanceSats,
      absoluteFeeCapSats: selectedPolicy.absoluteFeeCapSats,
      feerateCapSatVb: selectedPolicy.feerateCapSatPerV,
    },
    p2a: {
      script: P2A_SCRIPT_HEX,
      valueSats: P2A_VALUE_SATS,
      outputIndex: P2A_OUTPUT_INDEX,
    },
    transitionSequence: TRANSITION_SEQUENCE,
    savings: treeRef(family.savings.script, family.savings.address),
    pending,
    quarantine,
  })
}

export function validateVaultProgramDescriptor(d: VaultProgramDescriptor): VaultProgramDescriptor {
  if (d.schema !== PROGRAM_SCHEMA) throw new Error('unsupported vault schema')
  if (!SUPPORTED_NETWORKS.includes(d.network)) throw new Error(`unsupported network ${d.network}`)
  if (!d.vaultId || String(d.vaultId).trim() === '') throw new Error('vault id required')
  if (!isSavingsTemplate(d.templateVersion) && d.templateVersion !== CONNECTOR_TEMPLATE)
    throw new Error('template version is not this release')
  if (d.policyVersion !== POLICY_VERSION) throw new Error('policy version is not this release')
  requireProtectionTierMatchesRecovery(d.protectionTier, d.keys.recovery)
  if (
    d.csv.hardware !== PROGRAM_CSV.hardware ||
    d.csv.phone !== PROGRAM_CSV.phone ||
    d.csv.recovery !== PROGRAM_CSV.recovery
  ) {
    throw new Error('csv delays do not match this release')
  }
  if (d.p2a.script !== P2A_SCRIPT_HEX || d.p2a.valueSats !== P2A_VALUE_SATS || d.p2a.outputIndex !== P2A_OUTPUT_INDEX) {
    throw new Error('P2A lock does not match this release')
  }
  if (d.transitionSequence !== TRANSITION_SEQUENCE) throw new Error('transition sequence does not match this release')
  if (d.policy.recipientDustSats !== DUST_SATS) throw new Error('dust does not match this release')
  const selectedPolicy = validateSpendingPolicy(
    {
      program: d.policy.program,
      schema: d.policy.schema,
      period: d.policy.period,
      periodAllowanceSats: d.policy.periodAllowanceSats,
      txRecipientCapSats: d.policy.recipientCapSats,
      absoluteFeeCapSats: d.policy.absoluteFeeCapSats,
      feerateCapSatPerV: d.policy.feerateCapSatVb,
    },
    d.network,
  )
  if (spendingPolicyDigest(selectedPolicy, d.network) !== d.policy.digest)
    throw new Error('spending policy digest does not match')
  requireSecp(d.keys.phoneBip340, 'phone')
  requireP256(d.keys.phoneDirectP256, 'phoneDirectP256')
  requireSecp(d.keys.hardware, 'hardware')
  if (d.keys.recovery) requireSecp(d.keys.recovery, 'recovery')
  requireSecp(d.keys.vaultCosignerBase, 'vaultCosignerBase')
  requireSecp(d.keys.arkadeCosignerBase, 'arkadeCosignerBase')
  const hasRecovery = Boolean(d.keys.recovery)
  const claimants = familyClaimants(hasRecovery)
  const keys = familyKeysFor(hasRecovery)
  for (const claimant of claimants) {
    requirePair(d.tweaks.initiate[claimant]!, `initiate.${claimant}`)
  }
  for (const key of keys) {
    requirePair(d.tweaks.pending[key], `pending.${key}`)
  }
  const rebuilt = buildDescriptorFamily({
    vaultId: d.vaultId,
    phonePub: d.keys.phoneBip340,
    hardwarePub: d.keys.hardware,
    recoveryPub: d.keys.recovery,
    phoneDirectP256: d.keys.phoneDirectP256,
    vaultCosignerBase: d.keys.vaultCosignerBase,
    arkadeCosignerBase: d.keys.arkadeCosignerBase,
    network: d.network,
    templateVersion: d.templateVersion,
    connectorType: d.connectorType,
    absoluteFeeCapSats: selectedPolicy.absoluteFeeCapSats,
    feerateCapSatPerV: selectedPolicy.feerateCapSatPerV,
  })
  for (const claimant of claimants) {
    if (
      d.tweaks.initiate[claimant]!.vault !== rebuilt.initiateTweaks[claimant]!.vault ||
      d.tweaks.initiate[claimant]!.arkade !== rebuilt.initiateTweaks[claimant]!.arkade
    ) {
      throw new Error('initiate tweaks do not match derived authorization scripts')
    }
  }
  for (const key of keys) {
    if (
      d.tweaks.pending[key].vault !== rebuilt.pendingTweaks[key].vault ||
      d.tweaks.pending[key].arkade !== rebuilt.pendingTweaks[key].arkade
    ) {
      throw new Error('pending tweaks do not match derived authorization scripts')
    }
  }
  if (d.savings.address !== rebuilt.savings.address || d.savings.script !== hex.encode(rebuilt.savings.script)) {
    throw new Error('savings tree does not match rebuilt descriptor')
  }
  for (const key of keys) {
    if (!d.pending[key] || !d.quarantine[key]) throw new Error(`missing ${key} trees`)
    if (d.pending[key].address !== rebuilt.pending[key].address)
      throw new Error(`${key} pending does not match rebuilt descriptor`)
    if (d.pending[key].script !== hex.encode(rebuilt.pending[key].script)) {
      throw new Error(`${key} pending does not match rebuilt descriptor`)
    }
    if (d.pending[key].delay !== rebuilt.pending[key].delay) throw new Error(`${key} pending delay does not match`)
    if (d.quarantine[key].address !== rebuilt.quarantine[key].address) {
      throw new Error(`${key} quarantine does not match rebuilt descriptor`)
    }
    if (d.quarantine[key].script !== hex.encode(rebuilt.quarantine[key].script)) {
      throw new Error(`${key} quarantine does not match rebuilt descriptor`)
    }
    const want = rebuilt.quarantine[key].guardians
    if (
      d.quarantine[key].guardians.length !== want.length ||
      d.quarantine[key].guardians.some((g, i) => g !== want[i])
    ) {
      throw new Error(`${key} quarantine guardians do not match`)
    }
  }
  return d
}

export function encodeVaultProgramDescriptor(input: VaultProgramDescriptor): Uint8Array {
  return encodeRawVaultProgramDescriptor(validateVaultProgramDescriptor(input))
}

// Raw big-endian canonical encoding without validation. The connector
// enrollment path assembles a descriptor with the connector template and the
// actual enrolled Savings tree, which the legacy validator does not accept;
// hashing it here must use this exact same byte layout.
export function encodeRawVaultProgramDescriptor(d: VaultProgramDescriptor): Uint8Array {
  const parts: Uint8Array[] = []
  appendText(parts, d.schema, 'schema')
  appendText(parts, d.network, 'network')
  appendText(parts, d.vaultId, 'vaultId')
  appendBytes(parts, encodeUtf8(d.templateVersion))
  appendBytes(parts, encodeUtf8(d.policyVersion))
  appendText(parts, requireProtectionTier(d.protectionTier), 'protectionTier')
  appendHex(parts, d.keys.phoneBip340, 'phone', COMPRESSED)
  appendHex(parts, d.keys.phoneDirectP256, 'phoneDirectP256', COMPRESSED)
  appendHex(parts, d.keys.hardware, 'hardware', COMPRESSED)
  if (d.keys.recovery) appendHex(parts, d.keys.recovery, 'recovery', COMPRESSED)
  appendHex(parts, d.keys.vaultCosignerBase, 'vaultCosignerBase', COMPRESSED)
  appendHex(parts, d.keys.arkadeCosignerBase, 'arkadeCosignerBase', COMPRESSED)
  const hasRecovery = Boolean(d.keys.recovery)
  for (const claimant of familyClaimants(hasRecovery)) {
    appendHex(parts, d.tweaks.initiate[claimant]!.vault, `initiate.${claimant}.vault`, COMPRESSED)
    appendHex(parts, d.tweaks.initiate[claimant]!.arkade, `initiate.${claimant}.arkade`, COMPRESSED)
  }
  for (const key of familyKeysFor(hasRecovery)) {
    appendHex(parts, d.tweaks.pending[key].vault, `pending.${key}.vault`, COMPRESSED)
    appendHex(parts, d.tweaks.pending[key].arkade, `pending.${key}.arkade`, COMPRESSED)
  }
  appendRawText(parts, d.arkadeCosigner.origin, 'arkade origin')
  appendRawText(parts, d.arkadeCosigner.version, 'arkade version')
  appendU32(parts, d.csv.hardware, 'csv.hardware')
  appendU32(parts, d.csv.phone, 'csv.phone')
  appendU32(parts, d.csv.recovery, 'csv.recovery')
  appendBytes(parts, encodeUtf8(d.policy.program))
  appendBytes(parts, encodeUtf8(d.policy.schema))
  appendBytes(parts, encodeUtf8(d.policy.period))
  appendHex(parts, d.policy.digest, 'policy.digest', 32)
  appendI64(parts, d.policy.recipientDustSats, 'dust')
  appendI64(parts, d.policy.recipientCapSats, 'tx cap')
  appendI64(parts, d.policy.periodAllowanceSats, 'period')
  appendI64(parts, d.policy.absoluteFeeCapSats, 'fee cap')
  appendI64(parts, d.policy.feerateCapSatVb, 'feerate')
  appendHex(parts, d.p2a.script, 'p2a.script', d.p2a.script.length / 2)
  appendI64(parts, d.p2a.valueSats, 'p2a.value')
  appendU32(parts, d.p2a.outputIndex, 'p2a.index')
  appendU32(parts, d.transitionSequence, 'sequence')
  appendHex(parts, d.savings.script, 'savings.script', d.savings.script.length / 2)
  appendText(parts, d.savings.address, 'savings.address')
  for (const key of familyKeysFor(hasRecovery)) {
    appendHex(parts, d.pending[key].script, `${key}.pending.script`, d.pending[key].script.length / 2)
    appendText(parts, d.pending[key].address, `${key}.pending.address`)
    appendU32(parts, d.pending[key].delay, `${key}.pending.delay`)
  }
  for (const key of familyKeysFor(hasRecovery)) {
    appendHex(parts, d.quarantine[key].script, `${key}.quarantine.script`, d.quarantine[key].script.length / 2)
    appendText(parts, d.quarantine[key].address, `${key}.quarantine.address`)
    appendText(parts, d.quarantine[key].guardians[0], `${key}.guardian0`)
    if (d.quarantine[key].guardians[1]) {
      appendText(parts, d.quarantine[key].guardians[1], `${key}.guardian1`)
    }
  }
  return concat(parts)
}

export function hashVaultProgramDescriptor(d: VaultProgramDescriptor): string {
  return bytesToHex(sha256(encodeVaultProgramDescriptor(d)))
}

export function familyFromDescriptor(d: VaultProgramDescriptor) {
  const valid = validateVaultProgramDescriptor(d)
  return buildDescriptorFamily({
    vaultId: valid.vaultId,
    phonePub: valid.keys.phoneBip340,
    hardwarePub: valid.keys.hardware,
    recoveryPub: valid.keys.recovery,
    phoneDirectP256: valid.keys.phoneDirectP256,
    vaultCosignerBase: valid.keys.vaultCosignerBase,
    arkadeCosignerBase: valid.keys.arkadeCosignerBase,
    network: valid.network,
    templateVersion: valid.templateVersion,
    connectorType: valid.connectorType,
    absoluteFeeCapSats: valid.policy.absoluteFeeCapSats,
    feerateCapSatPerV: valid.policy.feerateCapSatVb,
  })
}

export type { Claimant, FamilyKey }

// Recovery uses the same initiate, pending and quarantine machinery. Only
// the normal Savings leaf and its control proof differ for connector vaults.
function buildDescriptorFamily(
  input: Parameters<typeof buildVaultProgramFamily>[0] & { connectorType?: ConnectorKind },
) {
  if (input.templateVersion !== CONNECTOR_TEMPLATE) {
    if (input.connectorType !== undefined) throw new Error('connector type on a legacy descriptor')
    return buildVaultProgramFamily(input)
  }
  if (input.connectorType !== 'p2tr' && input.connectorType !== 'p2wpkh') throw new Error('connector type required')
  return buildConnectorFamily({ ...input, connectorType: input.connectorType })
}
