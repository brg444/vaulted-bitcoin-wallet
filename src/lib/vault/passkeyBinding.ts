import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { verifyDirectP256 } from './ceremony/directauth'
import { bytesToHex, hexToBytes } from './hex'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import type { LedgerSavingsAccessBackup } from './cosignerClient'
import { LEDGER_NATIVE_TEMPLATE, ledgerSavingsContextDigest } from './program/ledgerNativeKeys'
import { validateLedgerSavingsEnrollmentSecrets } from './program/ledgerEnrollment'

const encoder = new TextEncoder()
const BINDING_DOMAIN = encoder.encode('arkade-vault/recovery-binding/v4')
const CONNECTOR_BINDING_DOMAIN = encoder.encode('arkade-vault/recovery-binding/v5')
const LEDGER_BINDING_DOMAIN = encoder.encode('arkade-vault/recovery-binding/v6')
const PROOF_DOMAIN = encoder.encode('arkade-2fa-vault/passkey-proof/v1')
const ZERO = Uint8Array.of(0)

export type AccessMode = 'closed' | 'setup' | 'resume' | 'ready' | 'enable' | 'signin'

export function accessMode(
  status: Pick<VaultStatus, 'enrolled' | 'enrollmentMode' | 'passkeyLoginAvailable'> | null,
  { hasLocal = false, hasPending = false } = {},
): AccessMode {
  if (!status?.enrolled) {
    const mode = status?.enrollmentMode
    if (mode && mode !== 'open' && mode !== 'token') return 'closed'
    return hasPending ? 'resume' : 'setup'
  }
  if (hasLocal) return status.passkeyLoginAvailable ? 'ready' : 'enable'
  if (hasPending) return 'resume'
  return 'signin'
}

export function passkeyProofDigest(purpose: string, challenge: Uint8Array, credentialId: Uint8Array): Uint8Array {
  if (
    purpose !== 'recover' &&
    purpose !== 'install-envelope' &&
    purpose !== 'transition' &&
    purpose !== 'map-write' &&
    purpose !== 'connector-withdraw' &&
    purpose !== 'light-backup-open' &&
    purpose !== 'recovery-archive-open' &&
    purpose !== 'lnurl-register' &&
    purpose !== 'lnurl-revoke'
  ) {
    throw new Error('invalid passkey purpose')
  }
  return sha256(concat(PROOF_DOMAIN, ZERO, encoder.encode(purpose), ZERO, challenge, ZERO, credentialId))
}

export function recoveryBindingDigest(binding: string): Uint8Array {
  if (!binding || binding.length > 16 * 1024) throw new Error('recovery binding')
  const version = (JSON.parse(binding) as { version?: unknown }).version
  const domain =
    version === 4
      ? BINDING_DOMAIN
      : version === 5
        ? CONNECTOR_BINDING_DOMAIN
        : version === 6
          ? LEDGER_BINDING_DOMAIN
          : undefined
  if (!domain) throw new Error('recovery binding version')
  return sha256(concat(domain, ZERO, encoder.encode(binding)))
}

type RecoveryBinding = Record<string, string | number | boolean>

export function parseRecoveryBinding(binding: string): RecoveryBinding {
  if (!binding || binding.length > 16 * 1024) throw new Error('recovery binding')
  const value = JSON.parse(binding) as RecoveryBinding
  const expected = [
    'version',
    'credentialId',
    'webauthnP256',
    'phoneDirectP256',
    'phoneBip340Pub',
    'externalOwnerWalletPub',
    'vaultCosignerBasePub',
    'arkadeCosignerBasePub',
    'arkadeCosignerOrigin',
    'arkadeCosignerVersion',
    'clientOrigin',
    'rpId',
    'network',
    'vaultId',
    'templateVersion',
    'policyVersion',
    'protectionTier',
    'savingsAddress',
    'savingsScript',
    'vtxoVaultCosignerPub',
    'vtxoExitDelay',
    'vtxoExitDelayUnit',
    'spendingArkAddress',
    'spendingArkScript',
    'vtxoDelegatePub',
    'vtxoBoardingActive',
    'vtxoBoardingProgram',
    'vtxoBoardingAddress',
    'vtxoBoardingScript',
    'vtxoBoardingExitDelay',
    'vtxoBoardingExitDelayUnit',
    'recipientDustSats',
    'txRecipientCapSats',
    'periodAllowanceSats',
    'absoluteFeeCapSats',
    'feerateCapSatVb',
    'envelopeNonce',
    'envelopeCiphertext',
  ]
  if (value?.version === 5)
    expected.push(
      'connectorType',
      'connectorPub',
      'connectorFingerprint',
      'connectorPath',
      'connectorEnrollmentDigest',
      'connectorDescriptorHash',
    )
  if (value?.version === 6)
    expected.push('ledgerSavingsContextDigest', 'ledgerSavingsDescriptorHash', 'ledgerSavingsBackup')
  const got = Object.keys(value || {})
  if (got.length !== expected.length || expected.some((field, i) => got[i] !== field)) {
    throw new Error('recovery binding fields or order')
  }
  if (value.version !== 4 && value.version !== 5 && value.version !== 6) throw new Error('recovery binding version')
  return value
}

export function assertRecoveryBindingMatchesStatus(binding: string | RecoveryBinding, status: VaultStatus) {
  const value = typeof binding === 'string' ? parseRecoveryBinding(binding) : binding
  const pairs: [string, keyof VaultStatus][] = [
    ['phoneDirectP256', 'phoneDirectP256'],
    ['phoneBip340Pub', 'phoneBip340Pub'],
    ['externalOwnerWalletPub', 'externalOwnerWalletPub'],
    ['vaultCosignerBasePub', 'vaultCosignerBasePub'],
    ['arkadeCosignerBasePub', 'arkadeCosignerBasePub'],
    ['arkadeCosignerOrigin', 'arkadeCosignerOrigin'],
    ['arkadeCosignerVersion', 'arkadeCosignerVersion'],
    ['clientOrigin', 'clientOrigin'],
    ['rpId', 'rpId'],
    ['network', 'network'],
    ['vaultId', 'vaultId'],
    ['templateVersion', 'templateVersion'],
    ['policyVersion', 'policyVersion'],
    ['protectionTier', 'protectionTier'],
    ['savingsAddress', 'savingsAddress'],
    ['savingsScript', 'savingsScript'],
    ['vtxoVaultCosignerPub', 'vtxoVaultCosignerPub'],
    ['vtxoExitDelay', 'vtxoExitDelay'],
    ['vtxoExitDelayUnit', 'vtxoExitDelayUnit'],
    ['spendingArkAddress', 'spendingArkAddress'],
    ['spendingArkScript', 'spendingArkScript'],
    ['vtxoDelegatePub', 'vtxoDelegatePub'],
    ['vtxoBoardingActive', 'vtxoBoardingActive'],
    ['vtxoBoardingProgram', 'vtxoBoardingProgram'],
    ['vtxoBoardingAddress', 'vtxoBoardingAddress'],
    ['vtxoBoardingScript', 'vtxoBoardingScript'],
    ['vtxoBoardingExitDelay', 'vtxoBoardingExitDelay'],
    ['vtxoBoardingExitDelayUnit', 'vtxoBoardingExitDelayUnit'],
    ['txRecipientCapSats', 'txCap'],
    ['periodAllowanceSats', 'periodAllowance'],
    ['absoluteFeeCapSats', 'absoluteFeeCap'],
    ['feerateCapSatVb', 'feerateCapSatVb'],
  ]
  for (const [bindingField, statusField] of pairs) {
    if (String(value[bindingField] ?? '') !== String(status[statusField] ?? '')) {
      throw new Error('recovery binding ' + bindingField + ' does not match vault status')
    }
  }
  if (value.version === 5) {
    const identity = status.connectorEnrollment
    if (
      !identity ||
      value.connectorType !== identity.connectorType ||
      value.connectorPub !== identity.connectorPub ||
      value.connectorFingerprint !== identity.connectorFingerprint ||
      value.connectorPath !== identity.connectorPath.join('/') ||
      value.connectorEnrollmentDigest !== identity.enrollmentDigest ||
      value.connectorDescriptorHash !== identity.descriptorHash
    )
      throw new Error('connector recovery binding does not match vault status')
  } else if (status.connectorEnrollment) throw new Error('connector requires version 5 recovery binding')
  if (value.version === 6) {
    if (
      status.templateVersion !== LEDGER_NATIVE_TEMPLATE ||
      !status.ledgerSavings ||
      value.ledgerSavingsContextDigest !== bytesToHex(ledgerSavingsContextDigest(status.ledgerSavings.context)) ||
      value.ledgerSavingsDescriptorHash !== status.ledgerSavings.descriptorHash
    )
      throw new Error('Ledger recovery binding does not match vault status')
    ledgerEnrollmentFromBinding(value, status)
  } else if (status.ledgerSavings || status.templateVersion === LEDGER_NATIVE_TEMPLATE) {
    throw new Error('Ledger Savings requires version 6 recovery binding')
  }
  return value
}

/** Public registration and a PRF-encrypted seed, using the Guardian's exact struct order. */
export function ledgerAccessBackup(rec: EnrollmentSecrets): LedgerSavingsAccessBackup | undefined {
  if (!rec.ledgerSavings) return undefined
  const valid = validateLedgerSavingsEnrollmentSecrets(rec.ledgerSavings)
  return { registration: valid.registration, phoneSeedBackup: valid.phoneSeedBackup }
}

export function canonicalLedgerAccessBackup(value: LedgerSavingsAccessBackup): string {
  const r = value.registration,
    p = value.phoneSeedBackup
  return JSON.stringify({
    registration: {
      name: r.name,
      version: r.version,
      contextDigest: r.contextDigest,
      walletId: r.walletId,
      walletHmac: r.walletHmac,
      walletPolicy: {
        name: r.walletPolicy.name,
        descriptorTemplate: r.walletPolicy.descriptorTemplate,
        keysInfo: r.walletPolicy.keysInfo,
      },
      receiveAddress: r.receiveAddress,
      changeAddress: r.changeAddress,
    },
    phoneSeedBackup: {
      name: p.name,
      version: p.version,
      purpose: p.purpose,
      contextDigest: p.contextDigest,
      phoneOrigin: { xpub: p.phoneOrigin.xpub, fingerprint: p.phoneOrigin.fingerprint, path: p.phoneOrigin.path },
      salt: p.salt,
      nonce: p.nonce,
      ciphertext: p.ciphertext,
    },
  })
}

function ledgerEnrollmentFromBinding(value: RecoveryBinding, status: VaultStatus) {
  if (!status.ledgerSavings || typeof value.ledgerSavingsBackup !== 'string')
    throw new Error('Ledger recovery backup required')
  const contract = { context: status.ledgerSavings.context, spendingPolicy: status.ledgerSavings.spendingPolicy }
  const backup = JSON.parse(value.ledgerSavingsBackup) as LedgerSavingsAccessBackup
  if (!backup || Object.keys(backup).length !== 2 || !backup.registration || !backup.phoneSeedBackup)
    throw new Error('Ledger recovery backup fields changed')
  const enrolled = validateLedgerSavingsEnrollmentSecrets({ version: 1, contract, ...backup }, contract)
  if (canonicalLedgerAccessBackup(enrolled) !== value.ledgerSavingsBackup)
    throw new Error('Ledger recovery backup is not canonical')
  return enrolled
}

export function verifyRecoveryBindingSignatures(input: {
  binding: string
  bindingDigestHex: string
  bindingDirectSigHex: string
  bindingPhoneSigHex: string
  derivedDirectPub: Uint8Array
  phoneSecret: Uint8Array
}) {
  const value = parseRecoveryBinding(input.binding)
  const digest = recoveryBindingDigest(input.binding)
  if (bytesToHex(digest) !== input.bindingDigestHex) throw new Error('recovery binding digest mismatch')
  if (bytesToHex(input.derivedDirectPub) !== value.phoneDirectP256) {
    throw new Error('passkey PRF derived a different DirectP256 identity')
  }
  if (!verifyDirectP256(input.derivedDirectPub, digest, hexToBytes(input.bindingDirectSigHex))) {
    throw new Error('recovery binding DirectP256 signature invalid')
  }
  const derivedPhone = secp256k1.getPublicKey(input.phoneSecret, true)
  if (bytesToHex(derivedPhone) !== value.phoneBip340Pub) {
    throw new Error('recovered Phone key does not match enrollment')
  }
  if (!schnorr.verify(hexToBytes(input.bindingPhoneSigHex), digest, derivedPhone.slice(1))) {
    throw new Error('recovery binding Phone signature invalid')
  }
  return value
}

export function recordFromRecoveryBinding(value: RecoveryBinding, status?: VaultStatus): EnrollmentSecrets {
  const vaultId = String(value.vaultId || '').trim()
  if (!vaultId) throw new Error('vault id required')
  if (value.version === 6 && !status) throw new Error('Ledger recovery requires verified vault status')
  if (status) assertRecoveryBindingMatchesStatus(value, status)
  return {
    ...(value.version === 6 ? { ledgerSavings: ledgerEnrollmentFromBinding(value, status!) } : {}),
    vaultId,
    credId: String(value.credentialId),
    webauthnP256: String(value.webauthnP256),
    phoneDirectP256: String(value.phoneDirectP256),
    phoneBip340Pub: String(value.phoneBip340Pub),
    nonce: String(value.envelopeNonce),
    ciphertext: String(value.envelopeCiphertext),
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const part of parts) {
    out.set(part, off)
    off += part.length
  }
  return out
}
