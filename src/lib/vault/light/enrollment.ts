import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { p256 } from '@noble/curves/nist.js'
import { authorizerBase, fetchPublicStatus, parseStatusJson } from '../status'
import { readBounded } from '../bounded'
import { openEnrollmentToken, clearOpenEnrollmentSession } from '../openEnrollmentSession'
import { compressedES256, type EnrollmentSecrets } from '../tenantEnrollment'
import { PRF_SALT } from '../prfEnvelope'
import { deriveDirectP256, zeroBytes } from '../ceremony/directauth'
import { allowPasskey, passkeyCreateOptions, passkeyGetOptions, prfExtension, prfFrom } from '../webauthn'
import {
  lightDescriptorDigest,
  lightPolicyDigest,
  validateLightDescriptor,
  validateLightPolicy,
  type LightDescriptor,
  type LightPolicy,
} from './contract'
import { wrapLightOwnerKey, unlockLightOwnerKey, validateLightKeyBackup, type LightKeyBackup } from './keyBackup'
import { lightStatusMatchesDescriptor } from './status'

export const LIGHT_LOCAL_STORE = 'vaulted-light:enrollment-v1'
export const LIGHT_STAGE_STORE = 'vaulted-light:pending-v1'
export interface LightEnrollment {
  descriptor: LightDescriptor
  enrollment: EnrollmentSecrets
  recoveryBackup: LightKeyBackup
}
export interface LightEnrollmentRequest {
  handle: string
  vaultId: string
  userHandle: string
  clientDataJSON: string
  authenticatorData: string
  attestationObject: string
  credentialId: string
  webauthnP256: string
  phoneDirectP256: string
  ownerPub: string
  descriptorHash: string
  spendingPolicy: LightPolicy
  spendingPolicyDigest: string
}
export interface PendingLightEnrollment extends LightEnrollment {
  token: string
  request: LightEnrollmentRequest
}

export class LightEnrollmentExpiredError extends Error {
  constructor() {
    super('This setup expired before the wallet was created. Restart setup and save the new recovery file.')
    this.name = 'LightEnrollmentExpiredError'
  }
}

export function clearExpiredLightEnrollment() {
  localStorage.removeItem(LIGHT_STAGE_STORE)
  clearOpenEnrollmentSession()
}

async function post<T>(phase: 'start' | 'propose' | 'finish', token: string, request: unknown): Promise<T> {
  const response = await fetch(`${authorizerBase()}/v1/light/enroll/${phase}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vault-Enrollment-Token': token },
    body: JSON.stringify(request),
  })
  const text = await readBounded(response)
  if (phase === 'finish' && response.status === 410 && JSON.parse(text).error === 'light_enrollment_expired')
    throw new LightEnrollmentExpiredError()
  if (!response.ok)
    throw new Error(`Light setup could not ${phase} (${response.status}). Keep your saved recovery file and retry.`)
  return JSON.parse(text) as T
}

export function validateLightEnrollment(value: unknown): LightEnrollment {
  if (!value || typeof value !== 'object') throw new Error('Light backup required')
  const record = value as LightEnrollment
  const descriptor = validateLightDescriptor(record.descriptor)
  const enrollment = record.enrollment
  if (
    !enrollment ||
    enrollment.vaultId !== descriptor.vaultId ||
    enrollment.phoneBip340Pub !== `02${descriptor.ownerPub}` ||
    !/^[0-9a-f]{2,2048}$/.test(enrollment.credId) ||
    enrollment.credId.length % 2 ||
    !/^(02|03)[0-9a-f]{64}$/.test(enrollment.webauthnP256) ||
    !/^(02|03)[0-9a-f]{64}$/.test(enrollment.phoneDirectP256)
  )
    throw new Error('Light credential does not match its descriptor')
  const passkeyBackup = validateLightKeyBackup(enrollment.lightKeyBackup, descriptor)
  const recoveryBackup = validateLightKeyBackup(record.recoveryBackup, descriptor)
  if (passkeyBackup.purpose !== 'passkey-prf' || recoveryBackup.purpose !== 'recovery-secret')
    throw new Error('Light backup purposes do not match')
  try {
    p256.Point.fromHex(enrollment.webauthnP256)
    p256.Point.fromHex(enrollment.phoneDirectP256)
  } catch {
    throw new Error('Light credential keys are invalid')
  }
  return {
    descriptor,
    enrollment: {
      vaultId: descriptor.vaultId,
      credId: enrollment.credId,
      webauthnP256: enrollment.webauthnP256,
      phoneDirectP256: enrollment.phoneDirectP256,
      phoneBip340Pub: enrollment.phoneBip340Pub,
      nonce: passkeyBackup.nonce,
      ciphertext: passkeyBackup.ciphertext,
      lightKeyBackup: passkeyBackup,
    },
    recoveryBackup,
  }
}

export function loadLightEnrollment(): LightEnrollment | null {
  const raw = localStorage.getItem(LIGHT_LOCAL_STORE)
  return raw ? validateLightEnrollment(JSON.parse(raw)) : null
}

export async function beginLightEnrollment(
  selected: LightPolicy,
  invite = '',
): Promise<{ pending: PendingLightEnrollment; recoverySecret: string }> {
  const publicStatus = await fetchPublicStatus()
  const rpId = publicStatus.rpId
  if (rpId !== location.hostname || publicStatus.clientOrigin !== location.origin)
    throw new Error('Open Vaulted at its signing address before setup')
  const policy = validateLightPolicy(selected, publicStatus.network as LightDescriptor['network'])
  const digest = lightPolicyDigest(policy, publicStatus.network as LightDescriptor['network'])
  let token = invite.trim()
  if (!token) {
    if (publicStatus.enrollmentMode !== 'open') throw new Error('Enter your invite code')
    token = await openEnrollmentToken()
  }
  const start = await post<{
    handle: string
    vaultId: string
    challenge: string
    userId: string
    rpId: string
    spendingPolicyDigest: string
  }>('start', token, { spendingPolicy: policy, spendingPolicyDigest: digest })
  if (
    !/^[0-9a-f]{64}$/.test(start.vaultId) ||
    start.userId !== hex.encode(new TextEncoder().encode(start.vaultId)) ||
    start.rpId !== rpId ||
    start.spendingPolicyDigest !== digest
  )
    throw new Error('Light setup identity mismatch')
  const credential = (await navigator.credentials.create({
    publicKey: passkeyCreateOptions({
      rp: { name: 'Vaulted Light', id: rpId },
      user: { id: Uint8Array.from(hex.decode(start.userId)), name: 'Vaulted Light', displayName: 'Vaulted Light' },
      challenge: Uint8Array.from(hex.decode(start.challenge)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: prfExtension(PRF_SALT),
    }),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey setup was cancelled')
  let prf = prfFrom(credential)
  if (!prf) {
    const assertion = (await navigator.credentials.get({
      publicKey: passkeyGetOptions(
        {
          rpId,
          challenge: Uint8Array.from(hex.decode(start.challenge)),
          allowCredentials: [allowPasskey(credential.rawId, true)],
          userVerification: 'required',
          extensions: prfExtension(PRF_SALT, new Uint8Array(credential.rawId)),
        },
        true,
      ),
    })) as PublicKeyCredential | null
    prf = assertion ? prfFrom(assertion) : null
  }
  if (!prf || prf.length !== 32)
    throw new Error('This passkey cannot protect wallet keys. Use a device with passkey PRF support.')
  const owner = secp256k1.utils.randomSecretKey()
  // Persist the even-Y owner representation used by both implementations.
  if (secp256k1.getPublicKey(owner, true)[0] === 3) {
    const scalar = secp256k1.Point.Fn.ORDER - BigInt(`0x${hex.encode(owner)}`)
    owner.set(hex.decode(scalar.toString(16).padStart(64, '0')))
  }
  const recovery = crypto.getRandomValues(new Uint8Array(32))
  let direct: Awaited<ReturnType<typeof deriveDirectP256>> | undefined
  try {
    const att = credential.response as AuthenticatorAttestationResponse
    direct = await deriveDirectP256(prf)
    const request: LightEnrollmentRequest = {
      handle: start.handle,
      vaultId: start.vaultId,
      userHandle: start.userId,
      clientDataJSON: hex.encode(new Uint8Array(att.clientDataJSON)),
      authenticatorData: hex.encode(new Uint8Array(att.getAuthenticatorData())),
      attestationObject: hex.encode(new Uint8Array(att.attestationObject)),
      credentialId: hex.encode(new Uint8Array(credential.rawId)),
      webauthnP256: hex.encode(await compressedES256(att)),
      phoneDirectP256: hex.encode(direct.pub),
      ownerPub: hex.encode(schnorr.getPublicKey(owner)),
      descriptorHash: '',
      spendingPolicy: policy,
      spendingPolicyDigest: digest,
    }
    const proposed = await post<{ descriptor: LightDescriptor; descriptorHash: string }>('propose', token, request)
    const descriptor = validateLightDescriptor(proposed.descriptor)
    if (
      descriptor.vaultId !== start.vaultId ||
      descriptor.ownerPub !== request.ownerPub ||
      descriptor.network !== publicStatus.network ||
      descriptor.spendingPolicyDigest !== digest ||
      lightDescriptorDigest(descriptor) !== proposed.descriptorHash
    )
      throw new Error('Light descriptor changed during setup')
    request.descriptorHash = proposed.descriptorHash
    const passkeyBackup = await wrapLightOwnerKey(owner, prf, 'passkey-prf', descriptor)
    const recoveryBackup = await wrapLightOwnerKey(owner, recovery, 'recovery-secret', descriptor)
    const enrollment: EnrollmentSecrets = {
      vaultId: descriptor.vaultId,
      credId: request.credentialId,
      webauthnP256: request.webauthnP256,
      phoneDirectP256: request.phoneDirectP256,
      phoneBip340Pub: `02${descriptor.ownerPub}`,
      nonce: passkeyBackup.nonce,
      ciphertext: passkeyBackup.ciphertext,
      lightKeyBackup: passkeyBackup,
    }
    const pending: PendingLightEnrollment = { descriptor, enrollment, recoveryBackup, token, request }
    // Neither the owner scalar, PRF nor recovery secret is written to browser storage.
    localStorage.setItem(LIGHT_STAGE_STORE, JSON.stringify(pending))
    return { pending, recoverySecret: hex.encode(recovery) }
  } finally {
    zeroBytes(owner, recovery, prf, direct?.scalar as Uint8Array)
  }
}

export async function verifyLightRecoverySecret(record: LightEnrollment, secret: string) {
  if (!/^[0-9a-f]{64}$/.test(secret.trim())) throw new Error('Enter all 64 characters of your recovery secret')
  const material = hex.decode(secret.trim())
  try {
    const owner = await unlockLightOwnerKey(record.recoveryBackup, material, 'recovery-secret', record.descriptor)
    owner.fill(0)
  } finally {
    material.fill(0)
  }
}

export async function finishLightEnrollment(pending: PendingLightEnrollment, secret: string) {
  const valid = validateLightEnrollment(pending)
  await verifyLightRecoverySecret(valid, secret)
  const response = await post<unknown>('finish', pending.token, pending.request)
  const status = lightStatusMatchesDescriptor(
    parseStatusJson(JSON.stringify(response), valid.descriptor.vaultId),
    valid.descriptor,
  )
  localStorage.setItem(LIGHT_LOCAL_STORE, JSON.stringify(valid))
  localStorage.removeItem(LIGHT_STAGE_STORE)
  clearOpenEnrollmentSession()
  return { record: valid, status }
}

export function loadPendingLightEnrollment(): PendingLightEnrollment | null {
  const raw = localStorage.getItem(LIGHT_STAGE_STORE)
  if (!raw) return null
  const parsed = JSON.parse(raw) as PendingLightEnrollment
  const valid = validateLightEnrollment(parsed)
  if (
    !parsed.request ||
    parsed.request.vaultId !== valid.descriptor.vaultId ||
    parsed.request.descriptorHash !== lightDescriptorDigest(valid.descriptor) ||
    typeof parsed.token !== 'string'
  )
    throw new Error('Pending Light setup is invalid')
  return { ...valid, request: parsed.request, token: parsed.token }
}

export function verifySavedLightRecoveryFile(value: unknown, expected: LightEnrollment) {
  const saved = validateLightEnrollment(value)
  const current = validateLightEnrollment(expected)
  if (JSON.stringify(saved) !== JSON.stringify(current)) throw new Error('Choose the recovery file for this setup')
  return saved
}
