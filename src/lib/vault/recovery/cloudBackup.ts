import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { authorizerBase } from '../status'
import { readBounded } from '../bounded'
import { PRF_SALT, unwrapPhoneSecret } from '../prfEnvelope'
import { allowPasskey, passkeyGetOptions, prfExtension, prfFrom } from '../webauthn'
import { deriveDirectP256, signDirectP256, zeroBytes } from '../ceremony/directauth'
import { passkeyProofDigest } from '../passkeyBinding'
import {
  validateRecoveryHeader,
  recoveryBackupKey,
  encryptRecoveryBackup,
  decryptRecoveryBackup,
  parseEncryptedRecoveryBackup,
  type RecoveryBinding,
  type RecoveryHeader,
  type VaultRecoveryFile,
} from './backupCodec'

interface CloudSnapshot {
  revision: number
  payload: string
}
export interface RecoveryBackupSession {
  token: string
  expiresAt: string
  header: RecoveryHeader
  key: CryptoKey
  revision: number
  fingerprint: string
  file?: VaultRecoveryFile
  pending?: { revision: number; payload: string; fingerprint: string }
}

async function post<T>(phase: 'challenge' | 'open' | 'read' | 'write', body: unknown): Promise<T> {
  const response = await fetch(`${authorizerBase()}/v1/recovery-archive/${phase}`, {
    method: 'POST',
    redirect: 'error',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await readBounded(response, 3_100_000)
  if (!response.ok) throw new Error('Cloud recovery backup is unavailable. The previous copy has been retained.')
  return JSON.parse(text) as T
}

export async function openRecoveryCloudBackup(
  local?: RecoveryHeader,
  restored?: (file: VaultRecoveryFile, phone: Uint8Array) => Promise<unknown>,
): Promise<RecoveryBackupSession> {
  if (local) validateRecoveryHeader(local)
  const challenge = await post<{ challengeId: string; challenge: string }>('challenge', {})
  if (!/^[0-9a-f]{64}$/.test(challenge.challenge)) throw new Error('Invalid recovery backup challenge')
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
  const vaultId = assertion.userHandle ? new TextDecoder().decode(assertion.userHandle) : local?.binding.vaultId
  if (
    !vaultId ||
    !/^[0-9a-f]{32}(?:[0-9a-f]{32})?$/.test(vaultId) ||
    (local && (vaultId !== local.binding.vaultId || credentialId !== local.enrollment.credId))
  )
    throw new Error('Choose the original vault passkey')
  const prf = prfFrom(credential)
  if (!prf || prf.length !== 32) throw new Error('The original passkey PRF is required for recovery')
  let direct: Awaited<ReturnType<typeof deriveDirectP256>> | undefined
  let phone: Uint8Array | undefined
  try {
    direct = await deriveDirectP256(prf)
    const response = await post<{
      token: string
      vaultId: string
      expiresAt: string
      backup: CloudSnapshot | null
      binding: RecoveryBinding
    }>('open', {
      vaultId,
      challengeId: challenge.challengeId,
      credentialId,
      clientDataJSON: hex.encode(new Uint8Array(assertion.clientDataJSON)),
      authenticatorData: hex.encode(new Uint8Array(assertion.authenticatorData)),
      signature: hex.encode(new Uint8Array(assertion.signature)),
      directProof: hex.encode(
        signDirectP256(
          direct.scalar,
          passkeyProofDigest('recovery-archive-open', hex.decode(challenge.challenge), hex.decode(credentialId)),
        ),
      ),
    })
    if (
      response.vaultId !== vaultId ||
      !/^[0-9a-f]{64}$/.test(response.token) ||
      !Number.isFinite(Date.parse(response.expiresAt)) ||
      Date.parse(response.expiresAt) <= Date.now()
    )
      throw new Error('Invalid recovery backup session')
    const encrypted = response.backup ? parseEncryptedRecoveryBackup(JSON.parse(response.backup.payload)) : undefined
    const header = validateRecoveryHeader(encrypted?.header ?? local!)
    if (
      header.origin !== location.origin ||
      header.rpId !== location.hostname ||
      header.enrollment.credId !== credentialId ||
      header.binding.vaultId !== vaultId ||
      header.enrollment.phoneDirectP256 !== hex.encode(direct.pub) ||
      JSON.stringify(header.binding) !== JSON.stringify(response.binding) ||
      (local && JSON.stringify(local) !== JSON.stringify(header))
    )
      throw new Error('Recovery backup does not match the original enrollment')
    phone = await unwrapPhoneSecret(prf, header.enrollment.nonce, header.enrollment.ciphertext)
    const key = await recoveryBackupKey(phone, header)
    const file = encrypted ? await decryptRecoveryBackup(encrypted, key) : undefined
    const revision = response.backup?.revision ?? 0
    const seen = Number(localStorage.getItem(revisionKey(vaultId)) || 0)
    if (!Number.isSafeInteger(revision) || revision < 0 || revision < seen)
      throw new Error('Cloud backup is older than the last verified copy')
    if (file && restored) await restored(file, phone)
    localStorage.setItem(revisionKey(vaultId), String(revision))
    return {
      token: response.token,
      expiresAt: response.expiresAt,
      header,
      key,
      revision,
      file,
      fingerprint: file ? fingerprint(file) : '',
    }
  } finally {
    zeroBytes(prf, phone, direct?.scalar)
  }
}

const revisionKey = (id: string) => `vaulted:${id}:recovery-archive-revision`
function fingerprint(file: VaultRecoveryFile) {
  return hex.encode(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({
          ...file,
          archive: { ...file.archive, spending: { ...file.archive.spending, capturedAt: undefined } },
        }),
      ),
    ),
  )
}
const activeSyncs = new WeakMap<RecoveryBackupSession, Promise<VaultRecoveryFile>>()
export function syncRecoveryCloudBackup(session: RecoveryBackupSession, file: VaultRecoveryFile) {
  // Snapshot before queuing so callers cannot mutate a pending upload's identity.
  const snapshot = JSON.parse(JSON.stringify(file)) as VaultRecoveryFile
  const previous = activeSyncs.get(session)
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => syncSnapshot(session, snapshot))
    .finally(() => {
      if (activeSyncs.get(session) === pending) activeSyncs.delete(session)
    })
  activeSyncs.set(session, pending)
  return pending
}

async function syncSnapshot(session: RecoveryBackupSession, file: VaultRecoveryFile) {
  if (JSON.stringify(file.header) !== JSON.stringify(session.header)) throw new Error('Recovery backup header changed')
  const nextFingerprint = fingerprint(file)
  while (session.pending || !session.revision || session.fingerprint !== nextFingerprint) {
    if (Date.now() >= Date.parse(session.expiresAt))
      throw new Error('Unlock with the original passkey to resume backup')
    if (!session.pending)
      session.pending = {
        revision: session.revision,
        payload: JSON.stringify(await encryptRecoveryBackup(file, session.key)),
        fingerprint: nextFingerprint,
      }
    const pending = session.pending
    const saved = await post<CloudSnapshot>('write', {
      token: session.token,
      revision: pending.revision,
      payload: pending.payload,
    })
    if (saved.revision !== pending.revision + 1 || saved.payload !== pending.payload)
      throw new Error('Recovery backup write could not be verified')
    const read = await post<CloudSnapshot>('read', { token: session.token })
    if (!read || read.revision !== saved.revision || read.payload !== pending.payload)
      throw new Error('Recovery backup read could not be verified')
    const verified = await decryptRecoveryBackup(JSON.parse(read.payload), session.key)
    localStorage.setItem(revisionKey(session.header.binding.vaultId), String(read.revision))
    session.revision = read.revision
    session.file = verified
    session.fingerprint = pending.fingerprint
    session.pending = undefined
  }
  if (Date.now() >= Date.parse(session.expiresAt)) throw new Error('Unlock with the original passkey to resume backup')
  return session.file!
}
