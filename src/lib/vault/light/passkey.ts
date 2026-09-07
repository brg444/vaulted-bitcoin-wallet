import { hex } from '@scure/base'
import { PRF_SALT } from '../prfEnvelope'
import { allowPasskey, passkeyGetOptions, prfExtension, prfFrom } from '../webauthn'
import { validateLightEnrollment, type LightEnrollment } from './enrollment'
import { unlockLightOwnerKey } from './keyBackup'

/** Local WebAuthn unwrap: no Vaulted service or Operator request. */
export async function unlockLightWithPasskey(record: LightEnrollment): Promise<Uint8Array> {
  const valid = validateLightEnrollment(record)
  const id = Uint8Array.from(hex.decode(valid.enrollment.credId))
  const credential = (await navigator.credentials.get({
    publicKey: passkeyGetOptions({
      rpId: location.hostname,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [allowPasskey(id)],
      userVerification: 'required',
      extensions: prfExtension(PRF_SALT, id),
    }),
  })) as PublicKeyCredential | null
  if (!credential || hex.encode(new Uint8Array(credential.rawId)) !== valid.enrollment.credId)
    throw new Error('Use the original passkey for this wallet')
  const prf = prfFrom(credential)
  if (!prf || prf.length !== 32) throw new Error('This passkey provider cannot unlock this backup')
  try {
    return await unlockLightOwnerKey(valid.enrollment.lightKeyBackup, prf, 'passkey-prf', valid.descriptor)
  } finally {
    prf.fill(0)
  }
}
