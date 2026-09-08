import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../network'
import { TAPROOT_NUMS_XONLY, xOnlyFromCompressed } from '../savingsTree'
import { type Claimant, familyClaimants } from './constants'
import { taggedHash } from './context'
import { arkadeScriptHash, tweakByArkScript } from './tweak'

// A new contract identity, deliberately absent from the live template registry.
export const LEDGER_NATIVE_TEMPLATE = 'phone-ledger-recovery-savings-v1'
const DOMAIN = 'vaulted/ledger-native-savings-v1'
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
  arkadeCosignerBase: string
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
  const baseKeys = [input.vaultCosignerBase, input.arkadeCosignerBase]
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
  // scure follows BIP32's invalid-child skip rule; an enrolled coordinate cannot silently advance.
  const step = parent.deriveChild(branch)
  const child = step.deriveChild(index)
  if (step.index !== branch || child.index !== index) throw new Error('invalid Ledger Savings child')
  return child
}

export function ledgerSavingsInternalParent(input: LedgerSavingsKeyContext): HDKey {
  return new HDKey({
    publicKey: hex.decode(`02${TAPROOT_NUMS_XONLY}`),
    chainCode: taggedHash(`${DOMAIN}/internal`, ledgerSavingsContextDigest(input)),
    versions: ledgerBip32Versions(input.network),
  })
}

/** Pure construction only: signing services must supply the reconstructed named program. */
export function ledgerRecoveryProgramParent(
  input: LedgerSavingsKeyContext,
  claimant: Claimant,
  cosigner: 'vault' | 'arkade',
  program: Uint8Array,
): HDKey {
  if (!familyClaimants(Boolean(input.recovery)).includes(claimant)) throw new Error('unenrolled recovery claimant')
  if (cosigner !== 'vault' && cosigner !== 'arkade') throw new Error('unknown recovery cosigner')
  if (!(program instanceof Uint8Array) || !program.length) throw new Error('recovery program required')
  const base = cosigner === 'vault' ? input.vaultCosignerBase : input.arkadeCosignerBase
  return new HDKey({
    publicKey: hex.decode(tweakByArkScript(base, program)),
    chainCode: taggedHash(
      `${DOMAIN}/program`,
      ledgerSavingsContextDigest(input),
      encodeFields([claimant, cosigner]),
      arkadeScriptHash(program),
    ),
    versions: ledgerBip32Versions(input.network),
  })
}
