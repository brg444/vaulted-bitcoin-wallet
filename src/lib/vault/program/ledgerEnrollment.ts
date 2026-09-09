import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import type { LedgerSavingsRegistration } from '../ledgerClient'
import type { LedgerSavingsContract } from '../ledgerSavings'
import { validateLedgerPhoneSeedBackup, type LedgerPhoneSeedBackup } from '../ledgerPhoneBackup'
import { validateSpendingPolicy } from '../spendingPolicy'
import { buildLedgerNativeFamily } from './ledgerNativeFamily'
import { ledgerSavingsContextDigest, type LedgerAccountOrigin, type LedgerSavingsKeyContext } from './ledgerNativeKeys'

/** Separate Savings HD envelope; the enclosing enrollment retains the original Spending scalar. */
export interface LedgerSavingsEnrollmentSecrets {
  version: 1
  contract: LedgerSavingsContract
  registration: LedgerSavingsRegistration
  phoneSeedBackup: LedgerPhoneSeedBackup
}

export function canonicalLedgerValue(value: unknown): string {
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

function exact(value: unknown, rebuilt: unknown, label: string) {
  if (canonicalLedgerValue(value) !== canonicalLedgerValue(rebuilt))
    throw new Error(`${label} contains changed or unsupported fields`)
}

function origin(value: LedgerAccountOrigin): LedgerAccountOrigin {
  if (!value || !Array.isArray(value.path)) throw new Error('Ledger account origin required')
  return { xpub: value.xpub, fingerprint: value.fingerprint, path: [...value.path] }
}

// Public deterministic trees only. Full-value keys and independent copies prevent
// an imported or subsequently mutated contract from sharing another identity.
const familyCache = new Map<string, ReturnType<typeof buildLedgerNativeFamily>>()
export function ledgerRecoveryFamily(contract: LedgerSavingsContract): ReturnType<typeof buildLedgerNativeFamily> {
  const key = canonicalLedgerValue(contract)
  const cached = familyCache.get(key)
  if (cached) return structuredClone(cached)
  const family = buildLedgerNativeFamily(contract.context, contract.spendingPolicy)
  if (familyCache.size >= 8) familyCache.delete(familyCache.keys().next().value!)
  familyCache.set(key, structuredClone(family))
  return family
}

export function validateLedgerSavingsContract(raw: unknown): LedgerSavingsContract {
  const value = raw as LedgerSavingsContract
  if (!value?.context) throw new Error('Ledger Savings contract required')
  const c = value.context
  const context: LedgerSavingsKeyContext = {
    templateVersion: c.templateVersion,
    network: c.network,
    vaultId: c.vaultId,
    policyDigest: c.policyDigest,
    phone: origin(c.phone),
    hardware: origin(c.hardware),
    ...(c.recovery ? { recovery: origin(c.recovery) } : {}),
    phoneDirectP256: c.phoneDirectP256,
    vaultCosignerBase: c.vaultCosignerBase,
  }
  const spendingPolicy = validateSpendingPolicy(value.spendingPolicy, c.network)
  const built = { context, spendingPolicy }
  ledgerRecoveryFamily(built)
  exact(value, built, 'Ledger Savings contract')
  return built
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function compactSize(value: number): Uint8Array {
  if (value < 253) return new Uint8Array([value])
  if (value <= 0xffff) return new Uint8Array([253, value & 255, value >>> 8])
  throw new Error('Ledger wallet policy exceeds supported size')
}

/** BIP388 wallet-policy v2 ID, matching the pinned official Ledger client. */
export function ledgerWalletPolicyId(policy: LedgerSavingsRegistration['walletPolicy']): string {
  const utf8 = new TextEncoder()
  const strings = [policy.name, policy.descriptorTemplate, ...policy.keysInfo]
  if (strings.some((s) => typeof s !== 'string' || !/^[\x20-\x7e]+$/.test(s)))
    throw new Error('Ledger wallet policy must use printable ASCII')
  const root = (leaves: Uint8Array[]): Uint8Array => {
    if (leaves.length === 0) return new Uint8Array(32)
    if (leaves.length === 1) return leaves[0]
    const split = 2 ** Math.floor(Math.log2(leaves.length - 1))
    return sha256(concat([new Uint8Array([1]), root(leaves.slice(0, split)), root(leaves.slice(split))]))
  }
  const name = utf8.encode(policy.name),
    descriptor = utf8.encode(policy.descriptorTemplate)
  return hex.encode(
    sha256(
      concat([
        new Uint8Array([2]),
        compactSize(name.length),
        name,
        compactSize(descriptor.length),
        sha256(descriptor),
        compactSize(policy.keysInfo.length),
        root(policy.keysInfo.map((key) => sha256(concat([new Uint8Array([0]), utf8.encode(key)])))),
      ]),
    ),
  )
}

/** Synchronous verification permits strict parsing before any recovery unlock or device prompt. */
export function validateLedgerRegistrationBinding(
  contract: LedgerSavingsContract,
  raw: unknown,
): LedgerSavingsRegistration {
  const valid = validateLedgerSavingsContract(contract)
  const family = ledgerRecoveryFamily(valid)
  const value = raw as LedgerSavingsRegistration
  if (!value || typeof value.walletHmac !== 'string' || !/^[0-9a-f]{64}$/.test(value.walletHmac))
    throw new Error('Ledger registration HMAC required')
  const built: LedgerSavingsRegistration = {
    name: 'vaulted-ledger-registration',
    version: 1,
    contextDigest: hex.encode(ledgerSavingsContextDigest(valid.context)),
    walletId: ledgerWalletPolicyId(family.walletPolicy),
    walletHmac: value.walletHmac,
    walletPolicy: family.walletPolicy,
    receiveAddress: family.receive.address,
    changeAddress: family.change.address,
  }
  exact(value, built, 'Ledger registration binding')
  return built
}

export function validateLedgerSavingsEnrollmentSecrets(
  raw: unknown,
  expected?: LedgerSavingsContract,
): LedgerSavingsEnrollmentSecrets {
  const value = raw as LedgerSavingsEnrollmentSecrets
  if (!value || value.version !== 1) throw new Error('Unsupported Ledger Savings enrollment backup')
  const contract = validateLedgerSavingsContract(value.contract)
  if (expected) exact(contract, validateLedgerSavingsContract(expected), 'Ledger Savings enrollment contract')
  const registration = validateLedgerRegistrationBinding(contract, value.registration)
  const phoneSeedBackup = validateLedgerPhoneSeedBackup(value.phoneSeedBackup, contract.context)
  if (phoneSeedBackup.purpose !== 'passkey-prf')
    throw new Error('Enrollment requires the passkey Savings seed envelope')
  const built: LedgerSavingsEnrollmentSecrets = { version: 1, contract, registration, phoneSeedBackup }
  exact(value, built, 'Ledger Savings enrollment backup')
  return built
}
