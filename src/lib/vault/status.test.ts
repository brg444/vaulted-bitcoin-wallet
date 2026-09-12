import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION } from './constants'
import { pinEnrolledStatus } from './pin'
import { SPENDING_ONLY_TEMPLATE } from './spendingEnrollment'
import {
  fetchPublicStatus,
  fetchVaultReadiness,
  fetchVaultStatus,
  parseStatusJson,
  pingVaultService,
  requireStatusIdentity,
  VaultReadinessResponseError,
  vaultStatusPath,
} from './status'
import type { VaultStatusWire } from './types'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from './spendingPolicy'
import { ledgerRecoveryFixture } from './recovery/testdata/ledger'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'

let standard: CompatibleStatusWire
let advanced: CompatibleStatusWire
let VAULT_ID: string

beforeAll(async () => {
  standard = (await ledgerRecoveryFixture(false)).status as CompatibleStatusWire
  advanced = (await ledgerRecoveryFixture(true)).status as CompatibleStatusWire
  advanced.recoveryKeyPub = advanced.recoveryPub
  VAULT_ID = standard.vaultId
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

type CompatibleStatusWire = VaultStatusWire & { recoveryPub?: string }

function sampleStatus(over: Partial<CompatibleStatusWire> = {}): CompatibleStatusWire {
  return { ...structuredClone(standard), ...over }
}

describe('status identity binding', () => {
  it('requires the selected vault id and refuses a wrong-vault response', () => {
    expect(requireStatusIdentity(sampleStatus(), VAULT_ID).vaultId).toBe(VAULT_ID)
    expect(() => requireStatusIdentity(sampleStatus(), 'tenant-b')).toThrow(/vault id/)
    expect(() => requireStatusIdentity(sampleStatus(), '')).toThrow(/vault id required/)
  })

  it('binds serialized status and the request path to an explicit vault', () => {
    const raw = JSON.stringify(sampleStatus())
    expect(parseStatusJson(raw, VAULT_ID).vaultId).toBe(VAULT_ID)
    expect(() => parseStatusJson(raw, 'tenant-b')).toThrow(/vault id/)
    expect(vaultStatusPath('tenant-b')).toBe('/v1/status?vault=tenant-b')
    expect(() => vaultStatusPath('')).toThrow(/vault id required/)
  })

  it('accepts retained Ledger and shared Spending identities', () => {
    expect(requireStatusIdentity(sampleStatus(), VAULT_ID).templateVersion).toBe(LEDGER_NATIVE_TEMPLATE)
    const spending = sharedSpendingStatus() as CompatibleStatusWire
    expect(requireStatusIdentity(spending, spending.vaultId)).toMatchObject({
      templateVersion: 'vaulted-spending-v1',
      savingsAddress: '',
      savingsScript: '',
    })
  })

  it.each([false, true])('validates mainnet policy against its enrolled bounds, advanced=%s', async (advanced) => {
    const status = (await ledgerRecoveryFixture(advanced, 'mainnet')).status as CompatibleStatusWire
    expect(requireStatusIdentity(status, status.vaultId).spendingPolicyDigest).toBe(status.spendingPolicyDigest)
  })

  it.each([
    'vaulted-light-v1',
    'phone-hww-recovery-savings-v1',
    'phone-connector-recovery-savings-v1',
    'phone-connector-recovery-savings-v2',
    'unknown',
  ])('rejects retired or unknown account identity %s', (templateVersion) => {
    expect(() => requireStatusIdentity(sampleStatus({ templateVersion }), VAULT_ID)).toThrow(/template version/)
  })

  it.each(['connectorEnrollment', 'lightDescriptor', 'lightDescriptorHash'])(
    'rejects retired %s metadata on a retained account',
    (field) => {
      expect(() => requireStatusIdentity({ ...sampleStatus(), [field]: {} }, VAULT_ID)).toThrow(/retired account/)
    },
  )

  it('rejects an unsupported network name', () => {
    expect(() => requireStatusIdentity(sampleStatus({ network: 'bitcoin' }), VAULT_ID)).toThrow(
      /unsupported Vault network/,
    )
  })

  it('requires the Savings descriptor but no retired Daily account', () => {
    expect(() => requireStatusIdentity(sampleStatus({ savingsScript: '' }), VAULT_ID)).toThrow(/Savings descriptor/)
    expect(requireStatusIdentity(sampleStatus(), VAULT_ID)).not.toHaveProperty('operationalAddress')
  })

  it('normalizes the server recoveryKeyPub field and rejects conflicting aliases', () => {
    const recovery = advanced.recoveryKeyPub!
    const wire = { ...structuredClone(advanced), recoveryPub: undefined }
    expect(requireStatusIdentity(wire, wire.vaultId)).toMatchObject({
      recoveryPub: recovery,
      recoveryKeyPub: recovery,
    })
    expect(() => requireStatusIdentity({ ...wire, recoveryPub: `03${'cc'.repeat(32)}` }, VAULT_ID)).toThrow(
      /recovery key fields/,
    )
  })

  it('requires the protection tier to match recovery-key presence', () => {
    const recovery = `02${'bb'.repeat(32)}`
    expect(() => requireStatusIdentity(sampleStatus({ protectionTier: 'advanced' }), VAULT_ID)).toThrow(/Advanced/)
    expect(() => requireStatusIdentity(sampleStatus({ recoveryKeyPub: recovery }), VAULT_ID)).toThrow(/Standard/)
    expect(() => requireStatusIdentity({ ...sampleStatus(), protectionTier: undefined } as never, VAULT_ID)).toThrow(
      /protection tier/,
    )
  })

  it('fails closed when a pinned enrolled vault is reported as unenrolled', async () => {
    pinEnrolledStatus(requireStatusIdentity(sampleStatus(), VAULT_ID))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(sampleStatus({ enrolled: false })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    await expect(fetchVaultStatus(undefined, VAULT_ID)).rejects.toThrow(/not enrolled/)
  })
})

describe('pingVaultService', () => {
  it.each(['mainnet', 'mutinynet'])('accepts the shared Spending handshake in the %s release', async (network) => {
    vi.stubEnv('VITE_VAULT_RELEASE_NETWORK', network)
    const { fetchPublicStatus: fetchStatus } = await import('./status')
    const { CURRENT_SPENDING_POLICY_CAPABILITIES: capabilities } = await import('./spendingPolicy')
    const current = {
      network,
      clientOrigin: 'https://vault.example',
      rpId: 'vault.example',
      templateVersion: SPENDING_ONLY_TEMPLATE,
      policyVersion: POLICY_VERSION,
      enrollmentMode: 'token',
      spendingPolicyCapabilities: capabilities,
      supportedSetups: ['light', 'standard', 'advanced'],
      ledgerSavingsCapability: { version: 1, templateVersion: LEDGER_NATIVE_TEMPLATE },
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(current), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchStatus()).resolves.toEqual(current)
    for (const templateVersion of [
      'vaulted-light-v1',
      'phone-hww-recovery-savings-v1',
      'phone-connector-recovery-savings-v1',
      'phone-connector-recovery-savings-v2',
      LEDGER_NATIVE_TEMPLATE,
      'unknown',
    ]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...current, templateVersion }), { status: 200 }))
      await expect(fetchStatus()).rejects.toThrow('template version is not this release')
    }
  })

  it('is online when public status answers this release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              network: 'mutinynet',
              clientOrigin: 'https://vault.example',
              rpId: 'vault.example',
              templateVersion: SPENDING_ONLY_TEMPLATE,
              policyVersion: POLICY_VERSION,
              enrollmentMode: 'invite',
              spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    await expect(pingVaultService()).resolves.toBe(true)
  })

  it('rejects public status with an unsupported network name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              network: 'bitcoin',
              clientOrigin: 'https://vault.example',
              rpId: 'vault.example',
              templateVersion: SPENDING_ONLY_TEMPLATE,
              policyVersion: POLICY_VERSION,
              enrollmentMode: 'invite',
              spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    await expect(fetchPublicStatus()).rejects.toThrow(/unsupported Vault network/)
    await expect(pingVaultService()).resolves.toBe(false)
  })

  it('is down when the service does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )
    await expect(pingVaultService()).resolves.toBe(false)
  })
})

describe('Vault readiness', () => {
  const ready = {
    ok: true,
    schema: 12,
    network: 'mutinynet',
    enrollTemplate: SPENDING_ONLY_TEMPLATE,
    arkadeOrigin: 'https://mutinynet.arkade.sh',
    arkadeVersion: '0.4.65',
  }

  it('accepts the current typed readiness response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(ready), { status: 200 })),
    )
    await expect(fetchVaultReadiness()).resolves.toEqual({ state: 'ready', status: ready })
  })

  it.each(['mainnet', 'mutinynet'])('binds %s readiness to the current schema and shared Spending', async (network) => {
    vi.stubEnv('VITE_VAULT_RELEASE_NETWORK', network)
    const { fetchVaultReadiness: fetchReady } = await import('./status')
    const current = { ...ready, network }
    const fetch = vi.fn(async () => new Response(JSON.stringify(current), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchReady()).resolves.toEqual({ state: 'ready', status: current })
    for (const schema of [0, 9, 11, 13]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...current, schema }), { status: 200 }))
      await expect(fetchReady()).rejects.toThrow('readiness schema is not this release')
    }
    for (const enrollTemplate of [
      'vaulted-light-v1',
      'phone-hww-recovery-savings-v1',
      'phone-connector-recovery-savings-v1',
      'phone-connector-recovery-savings-v2',
      LEDGER_NATIVE_TEMPLATE,
    ]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...current, enrollTemplate }), { status: 200 }))
      await expect(fetchReady()).rejects.toThrow('readiness template is not this release')
    }
  })

  it('keeps a structured 503 error out of the display state', async () => {
    const unavailable = { ...ready, ok: false, error: 'ledger unavailable' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(unavailable), { status: 503 })),
    )
    await expect(fetchVaultReadiness()).resolves.toEqual({ state: 'unavailable', status: unavailable })
  })

  it('rejects a malformed readiness body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    )
    await expect(fetchVaultReadiness()).rejects.toBeInstanceOf(VaultReadinessResponseError)
  })

  it('aborts a readiness request that exceeds its timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          }),
      ),
    )
    await expect(fetchVaultReadiness(undefined, 1)).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('distinguishes a network failure from a structured unavailable response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchVaultReadiness()).rejects.toBeInstanceOf(TypeError)
  })
})
