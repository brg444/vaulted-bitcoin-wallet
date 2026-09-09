import { ArkAddress } from '@arkade-os/sdk'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { DUST_SATS, POLICY_VERSION } from '../constants'
import type { LedgerSavingsContract } from '../ledgerSavings'
import { networkPins } from '../networkPins'
import { requireProtectionTierMatchesRecovery } from '../protectionTier'
import type { BoardingDescriptor, VaultStatus } from '../types'
import { requireBoardingDescriptor } from '../vtxo/board'
import { VaultPolicyV1Script } from '../vtxo/script'
import { PROGRAM_CSV, TRANSITION_SEQUENCE, familyClaimants, type FamilyKey } from './constants'
import type { ProgramTreeRef, VaultProgramDescriptor } from './descriptor'
import { canonicalLedgerValue, validateLedgerSavingsContract, ledgerRecoveryFamily } from './ledgerEnrollment'
import { LEDGER_NATIVE_TEMPLATE, ledgerAccountKey, ledgerSavingsContextDigest } from './ledgerNativeKeys'

export const LEDGER_ENROLLMENT_SCHEMA = 'arkade-vault/ledger-savings-enrollment-v1'
export const LEDGER_RECOVERY_SCHEMA = 'arkade-vault/ledger-savings-recovery-v1'

export interface LedgerSpendingAuthorities {
  phoneBip340Pub: string
  externalOwnerWalletPub: string
  recoveryKeyPub: string
  vaultCosignerBasePub: string
  arkadeCosignerBasePub: string
  phoneDirectP256: string
  vtxoVaultCosignerPub: string
  operatorPub: string
  vtxoDelegatePub: string
  vtxoExitDelay: number
  vtxoExitDelayUnit: string
  spendingArkAddress: string
  spendingArkScript: string
}

export interface LedgerSavingsEnrollmentDescriptor {
  schema: typeof LEDGER_ENROLLMENT_SCHEMA
  vaultId: string
  savings: LedgerSavingsContract
  spendingAuthorities: LedgerSpendingAuthorities
  boarding: BoardingDescriptor
}

export interface LedgerRecoveryDescriptor
  extends Omit<VaultProgramDescriptor, 'schema' | 'tweaks' | 'arkadeCosigner' | 'p2a' | 'connectorType'> {
  schema: typeof LEDGER_RECOVERY_SCHEMA
  connectorType?: never
  /** These keys remain the enrolled Spending identities; Savings uses ledgerSavings origins. */
  keys: VaultProgramDescriptor['keys']
  ledgerSavings: LedgerSavingsContract
  spendingAuthorities: LedgerSpendingAuthorities
  boarding: BoardingDescriptor
  enrollmentDescriptorHash: string
  savingsChange: ProgramTreeRef
}

function compressed(value: string, label: string, direct = false): string {
  if (
    typeof value !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(value) ||
    !(direct ? p256 : secp256k1).utils.isValidPublicKey(hex.decode(value), true)
  )
    throw new Error(`Invalid Ledger enrollment ${label}`)
  return value
}

export function validateLedgerSavingsEnrollmentDescriptor(raw: unknown): LedgerSavingsEnrollmentDescriptor {
  const value = raw as LedgerSavingsEnrollmentDescriptor
  if (!value || value.schema !== LEDGER_ENROLLMENT_SCHEMA || !value.spendingAuthorities || !value.boarding)
    throw new Error('Ledger Savings enrollment descriptor required')
  const savings = validateLedgerSavingsContract(value.savings)
  const context = savings.context
  if (value.vaultId !== context.vaultId) throw new Error('Ledger Savings enrollment vault changed')
  const a = value.spendingAuthorities,
    pins = networkPins(context.network)
  const authorities: LedgerSpendingAuthorities = {
    phoneBip340Pub: compressed(a.phoneBip340Pub, 'Spending phone'),
    externalOwnerWalletPub: compressed(a.externalOwnerWalletPub, 'Spending hardware'),
    recoveryKeyPub: a.recoveryKeyPub ? compressed(a.recoveryKeyPub, 'Spending recovery') : '',
    vaultCosignerBasePub: compressed(a.vaultCosignerBasePub, 'Spending Guardian root'),
    arkadeCosignerBasePub: compressed(a.arkadeCosignerBasePub, 'Spending cosigner root'),
    phoneDirectP256: compressed(a.phoneDirectP256, 'phone authentication', true),
    vtxoVaultCosignerPub: compressed(a.vtxoVaultCosignerPub, 'Spending Guardian'),
    operatorPub: compressed(a.operatorPub, 'Operator'),
    vtxoDelegatePub: compressed(a.vtxoDelegatePub, 'delegate'),
    vtxoExitDelay: a.vtxoExitDelay,
    vtxoExitDelayUnit: a.vtxoExitDelayUnit,
    spendingArkAddress: a.spendingArkAddress,
    spendingArkScript: a.spendingArkScript,
  }
  if (
    Boolean(authorities.recoveryKeyPub) !== Boolean(context.recovery) ||
    authorities.phoneDirectP256 !== context.phoneDirectP256 ||
    authorities.operatorPub !== pins.operatorSignerPub ||
    authorities.vtxoExitDelay !== pins.policyExitDelay ||
    authorities.vtxoExitDelayUnit !== 'seconds'
  )
    throw new Error('Ledger Spending identities do not match enrollment')
  // Dedicated Spending exit authorities are disjoint from the Savings branches.
  for (const role of ['hardware', ...(context.recovery ? ['recovery'] : [])] as const) {
    const origin = role === 'hardware' ? context.hardware : context.recovery!
    const parent = ledgerAccountKey(origin, context.network),
      branch = parent.deriveChild(12),
      child = branch.deriveChild(0)
    const expected = role === 'hardware' ? authorities.externalOwnerWalletPub : authorities.recoveryKeyPub
    if (branch.index !== 12 || child.index !== 0 || `02${hex.encode(child.publicKey!.slice(1))}` !== expected)
      throw new Error('Ledger Spending authority must match the enrolled account /12/0')
  }
  const xonly = (pub: string) => hex.decode(pub.slice(2))
  const script = new VaultPolicyV1Script({
    userPub: xonly(authorities.phoneBip340Pub),
    exitDevicePub: xonly(authorities.phoneBip340Pub),
    exitHardwarePub: xonly(authorities.externalOwnerWalletPub),
    ...(authorities.recoveryKeyPub ? { exitRecoveryPub: xonly(authorities.recoveryKeyPub) } : {}),
    vtxoVaultCosignerPub: xonly(authorities.vtxoVaultCosignerPub),
    arkdServerPub: xonly(authorities.operatorPub),
    delegatePub: xonly(authorities.vtxoDelegatePub),
    exitDelay: BigInt(authorities.vtxoExitDelay),
    exitDelayUnit: 'seconds',
    network: context.network,
  })
  const address = ArkAddress.decode(authorities.spendingArkAddress)
  if (
    address.hrp !== pins.arkHrp ||
    hex.encode(address.serverPubKey) !== authorities.operatorPub.slice(2) ||
    hex.encode(address.pkScript) !== authorities.spendingArkScript ||
    hex.encode(script.pkScript) !== authorities.spendingArkScript
  )
    throw new Error('Ledger enrollment changed the Spending script')
  const verifiedBoard = requireBoardingDescriptor(value.boarding, {
    vaultId: value.vaultId,
    network: context.network,
    phonePub: authorities.phoneBip340Pub,
    boardingPub: value.boarding.boardingPub,
  })
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
    script: boardScript,
    address: boardAddress,
  } = verifiedBoard
  const boarding: BoardingDescriptor = {
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
    script: boardScript,
    address: boardAddress,
  }
  const built: LedgerSavingsEnrollmentDescriptor = {
    schema: LEDGER_ENROLLMENT_SCHEMA,
    vaultId: value.vaultId,
    savings,
    spendingAuthorities: authorities,
    boarding,
  }
  if (canonicalLedgerValue(raw) !== canonicalLedgerValue(built))
    throw new Error('Ledger enrollment descriptor contains unsupported fields')
  return built
}

/** Exact runtime composite encoding. Existing enrollment hashes are untouched. */
export function hashLedgerSavingsEnrollment(raw: LedgerSavingsEnrollmentDescriptor): string {
  const d = validateLedgerSavingsEnrollmentDescriptor(raw),
    a = d.spendingAuthorities,
    b = d.boarding
  const fields = [
    d.schema,
    d.vaultId,
    hex.encode(ledgerSavingsContextDigest(d.savings.context)),
    a.phoneBip340Pub,
    a.externalOwnerWalletPub,
    a.recoveryKeyPub,
    a.vaultCosignerBasePub,
    a.arkadeCosignerBasePub,
    a.phoneDirectP256,
    a.vtxoVaultCosignerPub,
    a.operatorPub,
    a.vtxoDelegatePub,
    a.vtxoExitDelayUnit,
    a.spendingArkAddress,
    a.spendingArkScript,
    b.schema,
    b.program,
    b.template,
    b.network,
    b.boardingPub,
    b.recoveryPhonePub,
    b.vaultBoardCosignerPub,
    b.operatorPub,
    b.exitDelayUnit,
    b.script,
    b.address,
  ]
  const parts: Uint8Array[] = []
  const u32 = (n: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, n, true)
    return bytes
  }
  for (const field of fields) {
    const bytes = new TextEncoder().encode(field)
    parts.push(u32(bytes.length), bytes)
  }
  parts.push(u32(a.vtxoExitDelay), u32(b.exitDelay))
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return hex.encode(sha256(bytes))
}

export function ledgerEnrollmentFromStatus(status: VaultStatus): LedgerSavingsEnrollmentDescriptor {
  if (status.templateVersion !== LEDGER_NATIVE_TEMPLATE || !status.ledgerSavings || !status.vtxoBoardingDescriptor)
    throw new Error('Ledger Savings status required')
  const value = validateLedgerSavingsEnrollmentDescriptor({
    schema: LEDGER_ENROLLMENT_SCHEMA,
    vaultId: status.vaultId,
    savings: { context: status.ledgerSavings.context, spendingPolicy: status.ledgerSavings.spendingPolicy },
    spendingAuthorities: {
      phoneBip340Pub: status.phoneBip340Pub,
      externalOwnerWalletPub: status.externalOwnerWalletPub,
      recoveryKeyPub: status.recoveryKeyPub || status.recoveryPub || '',
      vaultCosignerBasePub: status.vaultCosignerBasePub,
      arkadeCosignerBasePub: status.arkadeCosignerBasePub,
      phoneDirectP256: status.phoneDirectP256,
      vtxoVaultCosignerPub: status.vtxoVaultCosignerPub,
      operatorPub: networkPins(status.network).operatorSignerPub,
      vtxoDelegatePub: status.vtxoDelegatePub,
      vtxoExitDelay: status.vtxoExitDelay,
      vtxoExitDelayUnit: status.vtxoExitDelayUnit,
      spendingArkAddress: status.spendingArkAddress,
      spendingArkScript: status.spendingArkScript,
    },
    boarding: status.vtxoBoardingDescriptor,
  })
  const family = ledgerRecoveryFamily(value.savings)
  if (
    value.savings.context.network !== status.network ||
    status.savingsAddress !== family.receive.address ||
    status.savingsScript !== hex.encode(family.receive.script) ||
    status.spendingPolicyDigest !== value.savings.context.policyDigest ||
    canonicalLedgerValue(status.spendingPolicy) !== canonicalLedgerValue(value.savings.spendingPolicy) ||
    hashLedgerSavingsEnrollment(value) !== status.ledgerSavings.descriptorHash ||
    (status.vtxoBoardingDescriptorHash !== undefined &&
      status.vtxoBoardingDescriptorHash !== status.ledgerSavings.descriptorHash)
  )
    throw new Error('Ledger Savings status differs from immutable enrollment')
  requireProtectionTierMatchesRecovery(status.protectionTier, value.spendingAuthorities.recoveryKeyPub)
  return value
}

export function buildLedgerRecoveryDescriptor(raw: LedgerSavingsEnrollmentDescriptor): LedgerRecoveryDescriptor {
  const d = validateLedgerSavingsEnrollmentDescriptor(raw),
    a = d.spendingAuthorities,
    p = d.savings.spendingPolicy
  const c = d.savings.context,
    family = ledgerRecoveryFamily(d.savings)
  const tree = (t: { script: Uint8Array; address?: string }) => ({ script: hex.encode(t.script), address: t.address! })
  const pending = {},
    quarantine = {}
  for (const claimant of familyClaimants(Boolean(c.recovery))) {
    const f = family.recovery[claimant]!,
      key = `savings-${claimant}` as FamilyKey
    Object.assign(pending, { [key]: { ...tree(f.pending), delay: f.delay } })
    Object.assign(quarantine, { [key]: { ...tree(f.quarantine), guardians: [...f.guardians] } })
  }
  return {
    schema: LEDGER_RECOVERY_SCHEMA,
    network: c.network,
    vaultId: c.vaultId,
    templateVersion: LEDGER_NATIVE_TEMPLATE,
    policyVersion: POLICY_VERSION,
    protectionTier: c.recovery ? 'advanced' : 'standard',
    keys: {
      phoneBip340: a.phoneBip340Pub,
      phoneDirectP256: a.phoneDirectP256,
      hardware: a.externalOwnerWalletPub,
      ...(a.recoveryKeyPub ? { recovery: a.recoveryKeyPub } : {}),
      vaultCosignerBase: a.vaultCosignerBasePub,
      arkadeCosignerBase: a.arkadeCosignerBasePub,
    },
    csv: { ...PROGRAM_CSV },
    policy: {
      program: p.program,
      schema: p.schema,
      period: p.period,
      digest: c.policyDigest,
      recipientDustSats: DUST_SATS,
      recipientCapSats: p.txRecipientCapSats,
      periodAllowanceSats: p.periodAllowanceSats,
      absoluteFeeCapSats: p.absoluteFeeCapSats,
      feerateCapSatVb: p.feerateCapSatPerV,
    },
    transitionSequence: TRANSITION_SEQUENCE,
    ledgerSavings: d.savings,
    spendingAuthorities: a,
    boarding: d.boarding,
    enrollmentDescriptorHash: hashLedgerSavingsEnrollment(d),
    savings: tree(family.receive),
    savingsChange: tree(family.change),
    pending: pending as LedgerRecoveryDescriptor['pending'],
    quarantine: quarantine as LedgerRecoveryDescriptor['quarantine'],
  }
}

export function validateLedgerRecoveryDescriptor(raw: unknown): LedgerRecoveryDescriptor {
  const d = raw as LedgerRecoveryDescriptor
  if (!d || d.schema !== LEDGER_RECOVERY_SCHEMA) throw new Error('Ledger recovery descriptor required')
  const rebuilt = buildLedgerRecoveryDescriptor({
    schema: LEDGER_ENROLLMENT_SCHEMA,
    vaultId: d.vaultId,
    savings: d.ledgerSavings,
    spendingAuthorities: d.spendingAuthorities,
    boarding: d.boarding,
  })
  if (canonicalLedgerValue(d) !== canonicalLedgerValue(rebuilt)) throw new Error('Ledger recovery descriptor changed')
  return rebuilt
}

export function hashLedgerRecoveryDescriptor(raw: LedgerRecoveryDescriptor): string {
  return hex.encode(sha256(new TextEncoder().encode(canonicalLedgerValue(validateLedgerRecoveryDescriptor(raw)))))
}
