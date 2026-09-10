import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../network'
import { TAPROOT_NUMS_XONLY, xOnlyFromCompressed } from '../savingsTree'
import { type Claimant, familyClaimants } from './constants'
import { taggedHash } from './context'

// A new contract identity, deliberately absent from the live template registry.
export const LEDGER_NATIVE_TEMPLATE = 'phone-ledger-guardian-savings-v1'
const DOMAIN = 'vaulted/ledger-guardian-savings-v1'
const HARDENED = 0x80000000

export interface LedgerAccountOrigin {
  xpub: string
  fingerprint: string
  path: number[]
}

export interface LedgerSavingsKeyContext {
  templateVersion: typeof LEDGER_NATIVE_TEMPLATE
  network: VaultNetwork
  vaultId: string
  policyDigest: string
  phone: LedgerAccountOrigin
  hardware: LedgerAccountOrigin
  recovery?: LedgerAccountOrigin
  phoneDirectP256: string
  vaultCosignerBase: string
}

export function ledgerBip32Versions(network: VaultNetwork) {
  requireSupportedVaultNetwork(network)
  return network === 'mainnet'
    ? { public: 0x0488b21e, private: 0x0488ade4 }
    : { public: 0x043587cf, private: 0x04358394 }
}

function lowerHex(value: string, bytes: number, label: string) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${label} must be canonical hex`)
  }
  return hex.decode(value)
}

/** Account metadata is validated here; ownership requires device registration. */
export function ledgerAccountKey(origin: LedgerAccountOrigin, network: VaultNetwork): HDKey {
  if (!origin) throw new Error('Ledger account origin required')
  lowerHex(origin.fingerprint, 4, 'account fingerprint')
  const coinType = network === 'mainnet' ? 0 : 1
  if (
    !Array.isArray(origin.path) ||
    origin.path.length !== 3 ||
    origin.path[0] !== HARDENED + 86 ||
    origin.path[1] !== HARDENED + coinType ||
    !Number.isInteger(origin.path[2]) ||
    origin.path[2] < HARDENED ||
    origin.path[2] > HARDENED + 100
  )
    throw new Error('Ledger Savings requires a BIP86 account origin')
  const key = HDKey.fromExtendedKey(origin.xpub, ledgerBip32Versions(network))
  if (key.privateKey || key.publicExtendedKey !== origin.xpub || key.depth !== 3 || key.index !== origin.path[2]) {
    throw new Error('Ledger Savings requires the matching public account xpub')
  }
  return key
}

export function ledgerAccountExpression(origin: LedgerAccountOrigin, network: VaultNetwork): string {
  ledgerAccountKey(origin, network)
  return `[${origin.fingerprint}/${origin.path.map((i) => `${i - HARDENED}'`).join('/')}]${origin.xpub}`
}

function encodeFields(fields: string[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts = fields.map((field) => encoder.encode(field))
  const bytes = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0))
  let offset = 0
  for (const part of parts) {
    new DataView(bytes.buffer).setUint32(offset, part.length, false)
    bytes.set(part, offset + 4)
    offset += 4 + part.length
  }
  return bytes
}

export function ledgerSavingsContextDigest(input: LedgerSavingsKeyContext): Uint8Array {
  if (input.templateVersion !== LEDGER_NATIVE_TEMPLATE) throw new Error('Ledger Savings template mismatch')
  requireSupportedVaultNetwork(input.network)
  lowerHex(input.vaultId, 16, 'vault ID')
  lowerHex(input.policyDigest, 32, 'policy digest')
  const direct = lowerHex(input.phoneDirectP256, 33, 'phone direct key')
  if (!p256.utils.isValidPublicKey(direct, true)) throw new Error('invalid phone direct key')
  const accounts = [input.phone, input.hardware, ...(input.recovery ? [input.recovery] : [])]
  const baseKeys = [input.vaultCosignerBase]
  const pubs = accounts.map((origin) => hex.encode(ledgerAccountKey(origin, input.network).publicKey!))
  for (const base of baseKeys) {
    const pub = lowerHex(base, 33, 'cosigner base')
    if (!secp256k1.utils.isValidPublicKey(pub, true)) throw new Error('invalid cosigner base')
    pubs.push(base)
  }
  const xonlys = pubs.map((pub) => hex.encode(xOnlyFromCompressed(pub)))
  const forbidden = [
    TAPROOT_NUMS_XONLY,
    hex.encode(secp256k1.Point.BASE.toBytes(true).slice(1)),
    hex.encode(secp256k1.Point.BASE.multiply(2n).toBytes(true).slice(1)),
  ]
  if (new Set(xonlys).size !== xonlys.length || xonlys.some((pub) => forbidden.includes(pub))) {
    throw new Error('Ledger Savings authorities must be distinct non-fixture points')
  }
  return taggedHash(
    `${DOMAIN}/context`,
    encodeFields([
      input.templateVersion,
      input.network,
      input.vaultId,
      input.recovery ? 'advanced' : 'standard',
      input.policyDigest,
      ...accounts.map((origin) => ledgerAccountExpression(origin, input.network)),
      input.phoneDirectP256,
      ...baseKeys,
    ]),
  )
}

/** Initial enrollment permits only receive/change index zero. */
export function ledgerSavingsChild(parent: HDKey, branch: number, index = 0): HDKey {
  if (!Number.isInteger(branch) || branch < 0 || branch > 3 || index !== 0) {
    throw new Error('unenrolled Ledger Savings coordinate')
  }
  return exactChild(parent, branch, index)
}

function exactChild(parent: HDKey, branch: number, index: number): HDKey {
  // scure follows BIP32's invalid-child skip rule; an enrolled coordinate cannot silently advance.
  const step = parent.deriveChild(branch)
  let child: HDKey | undefined
  try {
    child = step.deriveChild(index)
    if (step.index !== branch || child.index !== index) throw new Error('invalid Ledger Savings child')
    return child
  } catch (error) {
    child?.wipePrivateData()
    throw error
  } finally {
    step.wipePrivateData()
  }
}

export function ledgerSavingsInternalParent(input: LedgerSavingsKeyContext): HDKey {
  return new HDKey({
    publicKey: hex.decode(`02${TAPROOT_NUMS_XONLY}`),
    chainCode: taggedHash(`${DOMAIN}/internal`, ledgerSavingsContextDigest(input)),
    versions: ledgerBip32Versions(input.network),
  })
}

/** The Guardian holds this enrolled base key. Recovery transaction policy is
 * enforced by its named authorization capability before deriving a child. */
export function ledgerSavingsGuardianParent(input: LedgerSavingsKeyContext): HDKey {
  return new HDKey({
    publicKey: hex.decode(input.vaultCosignerBase),
    chainCode: taggedHash(`${DOMAIN}/guardian`, ledgerSavingsContextDigest(input)),
    versions: ledgerBip32Versions(input.network),
  })
}

export function ledgerGuardianInitiateBranch(
  input: LedgerSavingsKeyContext,
  claimant: Claimant,
  change: 0 | 1,
): number {
  if (!familyClaimants(Boolean(input.recovery)).includes(claimant)) throw new Error('unenrolled recovery claimant')
  if (change !== 0 && change !== 1) throw new Error('unenrolled Guardian initiation coordinate')
  return { phone: 0, hardware: 2, recovery: 4 }[claimant] + change
}

export function ledgerGuardianClawbackBranch(
  input: LedgerSavingsKeyContext,
  claimant: Claimant,
  guardian: Claimant,
): number {
  const claimants = familyClaimants(Boolean(input.recovery))
  if (!claimants.includes(claimant) || !claimants.includes(guardian) || guardian === claimant)
    throw new Error('unenrolled Guardian cancellation authority')
  const branches: Record<Claimant, Partial<Record<Claimant, number>>> = {
    phone: { hardware: 6, recovery: 8 },
    hardware: { phone: 10, recovery: 12 },
    recovery: { phone: 14, hardware: 16 },
  }
  return branches[claimant][guardian]!
}

function requireGuardianParent(input: LedgerSavingsKeyContext, parent: HDKey) {
  if (parent.publicExtendedKey !== ledgerSavingsGuardianParent(input).publicExtendedKey)
    throw new Error('Guardian parent does not match enrollment')
}

export function ledgerGuardianInitiateChild(
  input: LedgerSavingsKeyContext,
  parent: HDKey,
  claimant: Claimant,
  change: 0 | 1,
): HDKey {
  const branch = ledgerGuardianInitiateBranch(input, claimant, change)
  requireGuardianParent(input, parent)
  return exactChild(parent, branch, 0)
}

export function ledgerGuardianClawbackChild(
  input: LedgerSavingsKeyContext,
  parent: HDKey,
  claimant: Claimant,
  guardian: Claimant,
): HDKey {
  const branch = ledgerGuardianClawbackBranch(input, claimant, guardian)
  requireGuardianParent(input, parent)
  return exactChild(parent, branch, 0)
}

/** Disjoint account branches keep each recovery leaf representable by Ledger.
 * Recovery outputs are enrolled at index zero; these are semantic roles, not a
 * caller-selected derivation path for either signing service. */
export const LEDGER_RECOVERY_BRANCH = {
  claim: 4,
  clawback: 6,
  cancel: 8,
  quarantine: 10,
} as const

export function ledgerRecoveryChild(parent: HDKey, role: keyof typeof LEDGER_RECOVERY_BRANCH): HDKey {
  if (!Object.prototype.hasOwnProperty.call(LEDGER_RECOVERY_BRANCH, role))
    throw new Error('unknown Ledger recovery key role')
  return exactChild(parent, LEDGER_RECOVERY_BRANCH[role], 0)
}

export function ledgerRecoveryInternalParent(
  input: LedgerSavingsKeyContext,
  claimant: Claimant,
  stage: 'pending' | 'quarantine',
): HDKey {
  if (!familyClaimants(Boolean(input.recovery)).includes(claimant)) throw new Error('unenrolled recovery claimant')
  if (stage !== 'pending' && stage !== 'quarantine') throw new Error('unknown recovery stage')
  return new HDKey({
    publicKey: hex.decode(`02${TAPROOT_NUMS_XONLY}`),
    chainCode: taggedHash(
      `${DOMAIN}/recovery-internal`,
      ledgerSavingsContextDigest(input),
      encodeFields([claimant, stage]),
    ),
    versions: ledgerBip32Versions(input.network),
  })
}
