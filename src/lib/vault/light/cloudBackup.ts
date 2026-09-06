import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { authorizerBase } from '../status'
import { readBounded } from '../bounded'
import { PRF_SALT } from '../prfEnvelope'
import { allowPasskey, passkeyGetOptions, prfExtension, prfFrom } from '../webauthn'
import { deriveDirectP256, signDirectP256, zeroBytes } from '../ceremony/directauth'
import { validateLightEnrollment, type LightEnrollment } from './enrollment'
import { unlockLightOwnerKey } from './keyBackup'
import { decryptLightBackup, encryptLightBackup, lightBackupKey, parseLightEncryptedBackup } from './backupCodec'
import { storeLightRecoveryArchive, loadLightRecoveryArchive, type LightRecoveryArchive } from './recoveryArchive'
import type { LightRecoveryFile } from './recovery'

interface CloudSnapshot {
  revision: number
  payload: string
}
export interface LightBackupSession {
  token: string
  expiresAt: string
  record: LightEnrollment
  key: CryptoKey
  revision: number
  fingerprint: string
  file?: LightRecoveryFile
  pending?: { revision: number; payload: string; fingerprint: string }
}
async function post<T>(phase: string, body: unknown): Promise<T> {
  const response = await fetch(`${authorizerBase()}/v1/light/backup/${phase}`, {
    method: 'POST',
    redirect: 'error',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await readBounded(response, 3_100_000)
  if (!response.ok)
    throw new Error(
      'Cloud backup is unavailable. Your previous backup is unchanged. Reopen with your passkey and retry.',
    )
  return JSON.parse(text) as T
}
const encode = (value: string) => new TextEncoder().encode(value)
function proofDigest(challenge: string, id: string) {
  const parts = [
    encode('arkade-2fa-vault/passkey-proof/v1'),
    Uint8Array.of(0),
    encode('light-backup-open'),
    Uint8Array.of(0),
    hex.decode(challenge),
    Uint8Array.of(0),
    hex.decode(id),
  ]
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return sha256(bytes)
}
export async function openLightCloudBackup(local?: LightEnrollment): Promise<LightBackupSession> {
  const challenge = await post<{ challengeId: string; challenge: string }>('challenge', {})
  if (!/^[0-9a-f]{64}$/.test(challenge.challenge)) throw new Error('Invalid backup challenge')
  const id = local ? Uint8Array.from(hex.decode(local.enrollment.credId)) : undefined
  const credential = (await navigator.credentials.get({
    publicKey: passkeyGetOptions({
      rpId: location.hostname,
      challenge: Uint8Array.from(hex.decode(challenge.challenge)),
      userVerification: 'required',
      ...(id ? { allowCredentials: [allowPasskey(id)] } : {}),
      extensions: prfExtension(PRF_SALT, id),
    }),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey request cancelled')
  const assertion = credential.response as AuthenticatorAssertionResponse
  const credentialId = hex.encode(new Uint8Array(credential.rawId))
  const vaultId = assertion.userHandle ? new TextDecoder().decode(assertion.userHandle) : local?.descriptor.vaultId
  if (
    !vaultId ||
    !/^[0-9a-f]{64}$/.test(vaultId) ||
    (local && (vaultId !== local.descriptor.vaultId || credentialId !== local.enrollment.credId))
  )
    throw new Error('Choose the original Light passkey')
  const prf = prfFrom(credential)
  if (!prf || prf.length !== 32) throw new Error('This passkey provider cannot restore your wallet backup')
  let direct: Awaited<ReturnType<typeof deriveDirectP256>> | undefined
  let owner: Uint8Array | undefined
  try {
    direct = await deriveDirectP256(prf)
    const response = await post<{ token: string; vaultId: string; expiresAt: string; backup: CloudSnapshot | null }>(
      'open',
      {
        vaultId,
        challengeId: challenge.challengeId,
        credentialId,
        clientDataJSON: hex.encode(new Uint8Array(assertion.clientDataJSON)),
        authenticatorData: hex.encode(new Uint8Array(assertion.authenticatorData)),
        signature: hex.encode(new Uint8Array(assertion.signature)),
        directProof: hex.encode(signDirectP256(direct.scalar, proofDigest(challenge.challenge, credentialId))),
      },
    )
    if (
      response.vaultId !== vaultId ||
      !/^[0-9a-f]{64}$/.test(response.token) ||
      !Number.isFinite(Date.parse(response.expiresAt))
    )
      throw new Error('Invalid cloud backup session')
    const encrypted = response.backup ? parseLightEncryptedBackup(JSON.parse(response.backup.payload)) : undefined
    if (encrypted && (encrypted.header.origin !== location.origin || encrypted.header.rpId !== location.hostname))
      throw new Error('Backup passkey origin changed')
    const record = validateLightEnrollment(encrypted?.header ?? local)
    if (
      record.descriptor.vaultId !== vaultId ||
      record.enrollment.credId !== credentialId ||
      record.enrollment.phoneDirectP256 !== hex.encode(direct.pub) ||
      (local && JSON.stringify(record) !== JSON.stringify(validateLightEnrollment(local)))
    )
      throw new Error('Cloud backup does not match your original wallet')
    owner = await unlockLightOwnerKey(record.enrollment.lightKeyBackup, prf, 'passkey-prf', record.descriptor)
    const key = await lightBackupKey(owner, record)
    const file = encrypted ? await decryptLightBackup(encrypted, key) : undefined
    const revision = response.backup?.revision ?? 0
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid backup revision')
    // Do not silently replace a newer snapshot already observed on this device.
    const seen = Number(localStorage.getItem(revisionKey(vaultId)) || 0)
    if (revision < seen) throw new Error('Cloud backup is older than the last saved copy on this device')
    if (file?.archive) {
      const previous = await loadLightRecoveryArchive(record.descriptor)
      if (!previous || Date.parse(previous.capturedAt) < Date.parse(file.archive.capturedAt))
        await storeLightRecoveryArchive(file.archive, record.descriptor)
    }
    localStorage.setItem(revisionKey(vaultId), String(revision))
    return {
      token: response.token,
      expiresAt: response.expiresAt,
      record,
      key,
      revision,
      file,
      fingerprint: file?.archive ? fingerprint(file.archive) : '',
    }
  } finally {
    zeroBytes(prf, owner, direct?.scalar)
  }
}
const revisionKey = (id: string) => `vaulted-light:${id}:cloud-revision`
function fingerprint(archive: LightRecoveryArchive) {
  const data = { ...archive, capturedAt: undefined }
  return hex.encode(sha256(encode(JSON.stringify(data))))
}
// Serialize callers sharing a session so a capture and a manual export cannot
// race its revision or pending ciphertext. Other devices still use server CAS.
const activeSyncs = new WeakMap<LightBackupSession, Promise<LightRecoveryFile>>()
export function syncLightCloudBackup(session: LightBackupSession, archive: LightRecoveryArchive) {
  const previous = activeSyncs.get(session)
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => syncSnapshot(session, archive))
    .finally(() => {
      if (activeSyncs.get(session) === pending) activeSyncs.delete(session)
    })
  activeSyncs.set(session, pending)
  return pending
}
async function syncSnapshot(session: LightBackupSession, archive: LightRecoveryArchive): Promise<LightRecoveryFile> {
  const nextFingerprint = fingerprint(archive)
  while (session.pending || !session.revision || session.fingerprint !== nextFingerprint) {
    if (Date.now() >= Date.parse(session.expiresAt)) throw new Error('Unlock with your passkey to resume cloud backup')
    if (!session.pending) {
      const file: LightRecoveryFile = {
        ...session.record,
        name: 'vaulted-light-recovery',
        version: 1,
        createdAt: archive.capturedAt,
        archive,
      }
      const encrypted = await encryptLightBackup(file, session.key)
      // Retain these exact bytes before dispatch. A lost response must retry the
      // same ciphertext and revision, including when a newer payment is queued.
      session.pending = { revision: session.revision, payload: JSON.stringify(encrypted), fingerprint: nextFingerprint }
    }
    const pending = session.pending
    const saved = await post<CloudSnapshot>('write', {
      token: session.token,
      revision: pending.revision,
      payload: pending.payload,
    })
    if (saved.revision !== pending.revision + 1 || saved.payload !== pending.payload)
      throw new Error('Cloud backup could not be verified')
    const read = await post<CloudSnapshot>('read', { token: session.token })
    if (read.revision !== saved.revision || read.payload !== pending.payload)
      throw new Error('Cloud backup could not be verified')
    const verified = await decryptLightBackup(JSON.parse(read.payload), session.key)
    localStorage.setItem(revisionKey(session.record.descriptor.vaultId), String(read.revision))
    session.revision = read.revision
    session.file = verified
    session.fingerprint = pending.fingerprint
    session.pending = undefined
  }
  if (Date.now() >= Date.parse(session.expiresAt)) throw new Error('Unlock with your passkey to resume cloud backup')
  return session.file!
}
