/** Expected Guardian release facts shared by `verify-deployment.mjs` and its
 * regression tests. Values mirror `src/lib/vault/constants.ts` and the enrolled
 * template, kept as plain data so the Node verifier can consume them. The
 * signing origin is a canonical HTTPS URL supplied by the caller, and the RP ID
 * is the bare hostname, so the verifier targets one deliberate release rather
 * than accepting either origin. */

export const RELEASE_SCHEMA_VERSION = 12
export const RELEASE_TEMPLATE = 'vaulted-spending-v1'
export const RELEASE_POLICY_VERSION = 'vault-spending-policy-v1'

export function canonicalSigningOrigin(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('expected signing origin must be an absolute HTTPS URL')
  }
  if (url.protocol !== 'https:') throw new Error('expected signing origin must use HTTPS')
  if (url.username || url.password) throw new Error('expected signing origin must not carry credentials')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('expected signing origin must be a bare origin without path, query, or fragment')
  return url.origin
}

export function canonicalRpId(value) {
  const host = String(value || '').trim()
  if (!host) throw new Error('expected RP ID is required')
  if (host.includes('://') || /[/?#@]/.test(host)) throw new Error('expected RP ID must be a bare hostname')
  return host
}

export function assertGuardianRelease({ ready, status, network, expectedOrigin, expectedRpId }) {
  if (!network) throw new Error('expected release network is required')
  const origin = canonicalSigningOrigin(expectedOrigin)
  const rpId = expectedRpId ? canonicalRpId(expectedRpId) : new URL(origin).hostname

  if (!ready || typeof ready !== 'object') throw new Error('Guardian readiness is missing')
  if (ready.ok !== true) throw new Error('Guardian is not ready')
  if (ready.network !== network) throw new Error(`Guardian readiness network mismatch: ${ready.network}`)
  if (ready.schema !== RELEASE_SCHEMA_VERSION) throw new Error(`Guardian readiness schema mismatch: ${ready.schema}`)
  if (ready.enrollTemplate !== RELEASE_TEMPLATE)
    throw new Error(`Guardian readiness template mismatch: ${ready.enrollTemplate}`)

  if (!status || typeof status !== 'object') throw new Error('Guardian status is missing')
  if (status.network !== network) throw new Error(`Guardian status network mismatch: ${status.network}`)
  if (status.schema !== undefined && status.schema !== RELEASE_SCHEMA_VERSION)
    throw new Error(`Guardian status schema mismatch: ${status.schema}`)
  if (status.templateVersion !== RELEASE_TEMPLATE)
    throw new Error(`Guardian template mismatch: ${status.templateVersion}`)
  if (status.policyVersion !== RELEASE_POLICY_VERSION)
    throw new Error(`Guardian policy mismatch: ${status.policyVersion}`)
  if (status.clientOrigin !== origin) throw new Error(`Guardian signing origin mismatch: ${status.clientOrigin}`)
  if (status.rpId !== rpId) throw new Error(`Guardian RP ID mismatch: ${status.rpId}`)

  return {
    network,
    origin,
    rpId,
    schema: RELEASE_SCHEMA_VERSION,
    template: RELEASE_TEMPLATE,
    policy: RELEASE_POLICY_VERSION,
  }
}
