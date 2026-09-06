import { CONNECTOR_TEMPLATE } from './program/connector'
import { loadConnectorEnrollmentPin, verifyConnectorStatus } from './program/connectorEnroll'
import { schnorr } from '@noble/curves/secp256k1.js'
import { deriveDirectP256, signDirectP256, zeroBytes } from './ceremony/directauth'
import { vaultCosignerClient } from './cosignerClient'
import type { EnrollmentSecrets } from './tenantEnrollment'
import { bytesToHex, hexToBytes } from './hex'
import {
  assertRecoveryBindingMatchesStatus,
  parseRecoveryBinding,
  passkeyProofDigest,
  recordFromRecoveryBinding,
  recoveryBindingDigest,
  verifyRecoveryBindingSignatures,
} from './passkeyBinding'
import { pinEnrolledStatus, pinFromEnrolledStatus } from './pin'
import type { VaultStatus } from './types'
import { allowPasskey, isCoarsePhone, passkeyGetOptions, prfExtension, prfFrom } from './webauthn'
import { provisionBoardingKey } from './vtxo/board'
import { requireMainnetWalletOrigin, requireMainnetWalletRpId } from './productionDomains'

const PRF_SALT = new TextEncoder().encode('arkade-2fa-vault/prf/v1')
const HKDF_INFO = new TextEncoder().encode('arkade-2fa-vault/kek/v1')

function requireRPID(status: VaultStatus): string {
  const rpId = String(status.rpId || '').toLowerCase()
  if (!rpId || rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  if (status.clientOrigin !== location.origin) {
    throw new Error('deployment origin does not match this signing client origin')
  }
  if (status.network === 'mainnet') {
    requireMainnetWalletOrigin(status.clientOrigin)
    requireMainnetWalletRpId(rpId)
  }
  return rpId
}

async function deriveKEK(prf: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function decryptPhoneSecret(
  prf: Uint8Array<ArrayBuffer>,
  nonceHex: string,
  ciphertextHex: string,
): Promise<Uint8Array> {
  const nonce = hexToBytes(nonceHex)
  const ciphertext = hexToBytes(ciphertextHex)
  if (nonce.length !== 12 || ciphertext.length !== 48) {
    throw new Error('saved passkey envelope is malformed')
  }
  try {
    const kek = await deriveKEK(prf)
    const secret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, kek, ciphertext))
    if (secret.length !== 32) {
      zeroBytes(secret)
      throw new Error('saved passkey envelope did not contain a phone key')
    }
    return secret
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('saved passkey envelope')) throw error
    throw new Error('passkey PRF authentication succeeded but could not decrypt the saved phone key', {
      cause: error,
    })
  }
}

export async function beginPasskeySession(
  purpose: 'recover' | 'install-envelope' | 'transition' | 'map-write' | 'connector-withdraw',
  status: VaultStatus,
  allowCredentialId?: string,
  candidateTxid?: string,
) {
  const issued = await vaultCosignerClient.recovery.challenge({
    purpose,
    vaultId: status.vaultId,
    ...(candidateTxid ? { candidateTxid } : {}),
  })
  const challenge = hexToBytes(issued.challenge)
  if (challenge.length !== 32) throw new Error('authorizer returned a malformed passkey challenge')
  const expectedCred = allowCredentialId || issued.allowCredentialId
  if (allowCredentialId && issued.allowCredentialId && allowCredentialId !== issued.allowCredentialId) {
    throw new Error('passkey credential does not match this vault')
  }
  const mode = purpose === 'install-envelope' ? 'local' : 'any'
  const publicKey = passkeyGetOptions(
    {
      challenge: challenge as BufferSource,
      rpId: requireRPID(status),
      userVerification: 'required',
      extensions: prfExtension(PRF_SALT, expectedCred ? hexToBytes(expectedCred) : undefined),
      allowCredentials: expectedCred ? [allowPasskey(hexToBytes(expectedCred), mode)] : undefined,
    },
    mode,
  )
  const got = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!got) throw new Error('The operation was aborted.')
  if (expectedCred && bytesToHex(new Uint8Array(got.rawId)) !== expectedCred) {
    throw new Error('passkey credential does not match this vault')
  }
  const prf = prfFrom(got)
  if (!prf || prf.length !== 32) {
    throw new Error('this passkey did not return its 32-byte PRF secret on this device')
  }
  const derived = await deriveDirectP256(prf)
  const credentialId = new Uint8Array(got.rawId)
  const response = got.response as AuthenticatorAssertionResponse
  const directProof = signDirectP256(derived.scalar, passkeyProofDigest(purpose, challenge, credentialId))
  return {
    prf,
    scalar: derived.scalar,
    derivedDirectPub: derived.pub,
    credentialId,
    assertion: {
      challengeId: issued.challengeId,
      credentialId: bytesToHex(credentialId),
      clientDataJSON: bytesToHex(new Uint8Array(response.clientDataJSON)),
      authenticatorData: bytesToHex(new Uint8Array(response.authenticatorData)),
      signature: bytesToHex(new Uint8Array(response.signature)),
      directProof: bytesToHex(directProof),
    },
  }
}

export async function enablePasskeyLogin(rec: EnrollmentSecrets): Promise<VaultStatus> {
  let session: Awaited<ReturnType<typeof beginPasskeySession>> | undefined
  let phoneSecret: Uint8Array | undefined
  try {
    const vaultId = rec.vaultId
    if (!vaultId) throw new Error('vault id required')
    const status = await vaultCosignerClient.enrollment.status(vaultId)
    if (!status.enrolled) throw new Error('vault is not enrolled')
    const connectorPin = loadConnectorEnrollmentPin(vaultId)
    if (connectorPin) verifyConnectorStatus(status, connectorPin)
    else if (status.templateVersion === CONNECTOR_TEMPLATE) {
      // A lost browser pin must come from the existing signed recovery binding,
      // never from signing a replacement binding supplied by the service.
      if (status.passkeyLoginAvailable) return (await signInWithPasskey(vaultId)).status
      throw new Error('connector enrollment pin required before installing passkey sign-in')
    }
    session = await beginPasskeySession('install-envelope', status, rec.credId)
    phoneSecret = await decryptPhoneSecret(session.prf, rec.nonce, rec.ciphertext)
    const bindingResponse = await vaultCosignerClient.enrollment.binding({
      vaultId: status.vaultId,
      envelopeNonce: rec.nonce,
      envelopeCiphertext: rec.ciphertext,
    })
    assertRecoveryBindingMatchesStatus(bindingResponse.binding, status)
    const digest = recoveryBindingDigest(bindingResponse.binding)
    if (bytesToHex(digest) !== bindingResponse.bindingDigest) {
      throw new Error('server recovery binding digest mismatch')
    }
    const bindingDirectSig = signDirectP256(session.scalar, digest)
    const bindingPhoneSig = schnorr.sign(digest, phoneSecret)
    verifyRecoveryBindingSignatures({
      binding: bindingResponse.binding,
      bindingDigestHex: bindingResponse.bindingDigest,
      bindingDirectSigHex: bytesToHex(bindingDirectSig),
      bindingPhoneSigHex: bytesToHex(bindingPhoneSig),
      derivedDirectPub: session.derivedDirectPub,
      phoneSecret,
    })
    await vaultCosignerClient.enrollment.install({
      vaultId,
      challengeId: session.assertion.challengeId,
      credentialId: session.assertion.credentialId,
      clientDataJSON: session.assertion.clientDataJSON,
      authenticatorData: session.assertion.authenticatorData,
      signature: session.assertion.signature,
      directProof: session.assertion.directProof,
      envelopeNonce: rec.nonce,
      envelopeCiphertext: rec.ciphertext,
      binding: bindingResponse.binding,
      bindingDirectSig: bytesToHex(bindingDirectSig),
      bindingPhoneSig: bytesToHex(bindingPhoneSig),
    })
    const live = await vaultCosignerClient.enrollment.status(vaultId)
    if (!live.passkeyLoginAvailable) {
      throw new Error('authorizer did not persist passkey sign-in recovery data')
    }
    assertRecoveryBindingMatchesStatus(bindingResponse.binding, live)
    // Validate the complete program pin without making authentication depend
    // on durable browser storage. The session coordinator persists it after
    // the verified session is already live.
    pinFromEnrolledStatus(live)
    await provisionBoardingKey(phoneSecret, live)
    return live
  } finally {
    zeroBytes(session?.prf as Uint8Array, session?.scalar as Uint8Array, phoneSecret as Uint8Array)
  }
}

export async function unlockLocalEnrollment(
  rec: EnrollmentSecrets,
): Promise<{ enrollment: EnrollmentSecrets; status: VaultStatus }> {
  const publicStatus = await vaultCosignerClient.enrollment.publicStatus()
  const rpId = String(publicStatus.rpId || location.hostname).toLowerCase()
  if (rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  const live = await vaultCosignerClient.enrollment.status(rec.vaultId)
  if (live.templateVersion === CONNECTOR_TEMPLATE) return signInWithPasskey(rec.vaultId)
  pinEnrolledStatus(live)
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const got = (await navigator.credentials.get({
    publicKey: passkeyGetOptions(
      {
        challenge,
        rpId,
        allowCredentials: [allowPasskey(hexToBytes(rec.credId), 'local')],
        userVerification: 'required',
        extensions: prfExtension(PRF_SALT, hexToBytes(rec.credId)),
      },
      'local',
    ),
  })) as PublicKeyCredential | null
  if (!got) throw new Error('The operation was aborted.')
  const prf = prfFrom(got)
  if (!prf || prf.length !== 32) throw new Error('authenticator did not return PRF')
  try {
    const secret = await decryptPhoneSecret(prf, rec.nonce, rec.ciphertext)
    try {
      await provisionBoardingKey(secret, live)
      return { enrollment: rec, status: live }
    } finally {
      zeroBytes(secret)
    }
  } finally {
    zeroBytes(prf)
  }
}

export async function discoverVaultIdFromPasskey(): Promise<string> {
  const publicStatus = await vaultCosignerClient.enrollment.publicStatus()
  const rpId = String(publicStatus.rpId || location.hostname).toLowerCase()
  if (rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const got = (await navigator.credentials.get({
    publicKey: passkeyGetOptions(
      {
        challenge,
        rpId,
        userVerification: 'required',
      },
      isCoarsePhone() ? 'local' : 'any',
    ),
  })) as PublicKeyCredential | null
  if (!got) throw new Error('The operation was aborted.')
  const handle = (got.response as AuthenticatorAssertionResponse).userHandle
  if (!handle) throw new Error('this passkey is not tied to a vault')
  const vaultId = new TextDecoder().decode(new Uint8Array(handle)).trim()
  if (!vaultId) throw new Error('this passkey is not tied to a vault')
  return vaultId
}

export async function signInWithPasskey(
  vaultId: string,
): Promise<{ status: VaultStatus; enrollment: EnrollmentSecrets }> {
  let session: Awaited<ReturnType<typeof beginPasskeySession>> | undefined
  let phoneSecret: Uint8Array | undefined
  try {
    const id = String(vaultId || '').trim()
    if (!id) throw new Error('vault id required')
    const status = await vaultCosignerClient.enrollment.status(id)
    if (!status.enrolled) throw new Error('this deployment has not been set up yet')
    if (!status.passkeyLoginAvailable) {
      throw new Error('passkey sign-in must first be enabled on the original enrolled device')
    }
    session = await beginPasskeySession('recover', status)
    const recovered = await vaultCosignerClient.enrollment.recover({
      vaultId: status.vaultId,
      ...session.assertion,
    })
    const parsed = parseRecoveryBinding(recovered.binding)
    if (bytesToHex(session.credentialId) !== parsed.credentialId) {
      throw new Error('selected passkey does not belong to this vault')
    }
    if (bytesToHex(session.derivedDirectPub) !== parsed.phoneDirectP256) {
      throw new Error('passkey PRF derived a different DirectP256 identity')
    }
    if (
      recovered.envelopeNonce !== parsed.envelopeNonce ||
      recovered.envelopeCiphertext !== parsed.envelopeCiphertext
    ) {
      throw new Error('recovered passkey envelope does not match its signed binding')
    }
    assertRecoveryBindingMatchesStatus(parsed, status)
    phoneSecret = await decryptPhoneSecret(session.prf, recovered.envelopeNonce, recovered.envelopeCiphertext)
    const verified = verifyRecoveryBindingSignatures({
      binding: recovered.binding,
      bindingDigestHex: recovered.bindingDigest,
      bindingDirectSigHex: recovered.bindingDirectSig,
      bindingPhoneSigHex: recovered.bindingPhoneSig,
      derivedDirectPub: session.derivedDirectPub,
      phoneSecret,
    })
    assertRecoveryBindingMatchesStatus(verified, status)
    // The signed recovery binding already commits to these fields. Validate
    // their pin shape here; persistence is best effort in the coordinator so
    // private browsing cannot turn a valid recovery into a failed login.
    pinFromEnrolledStatus(status)
    await provisionBoardingKey(phoneSecret, status)
    return { status, enrollment: recordFromRecoveryBinding(verified) }
  } finally {
    zeroBytes(session?.prf as Uint8Array, session?.scalar as Uint8Array, phoneSecret as Uint8Array)
  }
}
