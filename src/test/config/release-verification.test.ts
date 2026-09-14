import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertGuardianRelease,
  RELEASE_POLICY_VERSION,
  RELEASE_SCHEMA_VERSION,
  RELEASE_TEMPLATE,
} from '../../../scripts/release-verification.mjs'

const RC_ORIGIN = 'https://rc.getvaulted.xyz'
const RC_RP_ID = 'rc.getvaulted.xyz'

function ready(overrides: Record<string, unknown> = {}) {
  return { ok: true, schema: 12, network: 'mainnet', enrollTemplate: 'vaulted-spending-v1', ...overrides }
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    network: 'mainnet',
    schema: 12,
    templateVersion: 'vaulted-spending-v1',
    policyVersion: 'vault-spending-policy-v1',
    clientOrigin: RC_ORIGIN,
    rpId: RC_RP_ID,
    ...overrides,
  }
}

function verify(overrides: { ready?: Record<string, unknown>; status?: Record<string, unknown> } = {}) {
  return assertGuardianRelease({
    ready: ready(overrides.ready),
    status: status(overrides.status),
    network: 'mainnet',
    expectedOrigin: RC_ORIGIN,
  } as never)
}

describe('Deployment Guardian release verification', () => {
  it('accepts the RC canonical signing origin and returns the binding', () => {
    expect(verify()).toMatchObject({ network: 'mainnet', origin: RC_ORIGIN, rpId: RC_RP_ID, schema: 12 })
  })

  it('keeps verifier constants bound to the current wallet source', () => {
    const constants = readFileSync(resolve(process.cwd(), 'src/lib/vault/constants.ts'), 'utf8')
    expect(constants).toContain(`RUNTIME_SCHEMA_VERSION = ${RELEASE_SCHEMA_VERSION}`)
    expect(constants).toContain(`POLICY_VERSION = '${RELEASE_POLICY_VERSION}'`)
    const enrollment = readFileSync(resolve(process.cwd(), 'src/lib/vault/spendingEnrollment.ts'), 'utf8')
    expect(enrollment).toContain(`SPENDING_ONLY_TEMPLATE = '${RELEASE_TEMPLATE}'`)
  })

  it('rejects the schema11 old-template Guardian that served the legacy release', () => {
    expect(() =>
      assertGuardianRelease({
        ready: ready({ schema: 11, enrollTemplate: 'phone-hww-recovery-savings-v1' }),
        status: status({ schema: 11, templateVersion: 'phone-hww-recovery-savings-v1' }),
        network: 'mainnet',
        expectedOrigin: RC_ORIGIN,
      } as never),
    ).toThrow(/readiness schema mismatch/)
  })

  it.each([
    ['an app signing origin', status({ clientOrigin: 'https://app.getvaulted.xyz' }), /signing origin mismatch/],
    ['an app RP ID', status({ rpId: 'app.getvaulted.xyz' }), /RP ID mismatch/],
    ['a mutinynet network', status({ network: 'mutinynet' }), /status network mismatch/],
    ['a changed policy', status({ policyVersion: 'vault-spending-policy-v2' }), /policy mismatch/],
    ['a changed template', status({ templateVersion: 'phone-ledger-guardian-savings-v1' }), /template mismatch/],
    ['a changed status schema', status({ schema: 11 }), /status schema mismatch/],
  ])('rejects %s against the RC expectation', (_label, statusFacts, expected) => {
    expect(() =>
      assertGuardianRelease({
        ready: ready(),
        status: statusFacts,
        network: 'mainnet',
        expectedOrigin: RC_ORIGIN,
      } as never),
    ).toThrow(expected)
  })

  it.each([
    ['a readiness network', ready({ network: 'mutinynet' }), /readiness network mismatch/],
    [
      'a readiness template',
      ready({ enrollTemplate: 'phone-ledger-guardian-savings-v1' }),
      /readiness template mismatch/,
    ],
    ['a readiness schema', ready({ schema: 11 }), /readiness schema mismatch/],
  ])('rejects %s mismatch', (_label, readyFacts, expected) => {
    expect(() =>
      assertGuardianRelease({
        ready: readyFacts,
        status: status(),
        network: 'mainnet',
        expectedOrigin: RC_ORIGIN,
      } as never),
    ).toThrow(expected)
  })

  it.each([
    ['a bare hostname', 'rc.getvaulted.xyz', /absolute HTTPS URL/],
    ['a non-HTTPS URL', 'http://rc.getvaulted.xyz', /must use HTTPS/],
    ['a URL with a path', 'https://rc.getvaulted.xyz/app', /bare origin/],
    ['a URL with credentials', 'https://user@rc.getvaulted.xyz', /credentials/],
  ])('rejects %s as the expected signing origin', (_label, origin, expected) => {
    expect(() =>
      assertGuardianRelease({ ready: ready(), status: status(), network: 'mainnet', expectedOrigin: origin } as never),
    ).toThrow(expected)
  })

  it('requires an explicit expected signing origin', () => {
    expect(() =>
      assertGuardianRelease({ ready: ready(), status: status(), network: 'mainnet', expectedOrigin: '' } as never),
    ).toThrow(/absolute HTTPS URL/)
  })
})
