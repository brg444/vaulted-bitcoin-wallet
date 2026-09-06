import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { p256 } from '@noble/curves/nist.js'
import { hex } from '@scure/base'
import { buildLightDescriptor, defaultLightPolicy } from '../light/contract'
import { delegationFixture } from '../light/testdata/delegation'
import type { VaultStatus } from '../types'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'
import { spendingDelegationAddress, validateSpendingSchedule } from './renewalRequest'
import { validateSpendingRenewalSet } from './renewalSet'
import { authorizeSpendingRenewals, clearSpendingRenewalReads } from './guardianRenewal'
import { loadSpendingRenewals } from './renewalStore'
import { setupSpendingRenewals } from './renewalCeremony'
import * as spending from './spend'
import vectors from './testdata/renewal-context-v1.json'

const mocks = vi.hoisted(() => ({ ancestry: vi.fn() }))
vi.mock('./renewalRecovery', async (original) => ({
  ...(await original<typeof import('./renewalRecovery')>()),
  requireSpendingRenewalAncestry: mocks.ancestry,
}))
vi.mock('./recoveryArchive', async (original) => ({
  ...(await original<typeof import('./recoveryArchive')>()),
  loadVaultRecoveryArchive: vi.fn(async () => null),
}))
vi.mock('../program/kitBackup', async (original) => ({
  ...(await original<typeof import('../program/kitBackup')>()),
  kitFromFacts: vi.fn(() => ({})),
}))

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, run: () => Promise<unknown>) => run() },
  })
  mocks.ancestry.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function environment(raw: unknown) {
  const status = structuredClone(raw) as VaultStatus,
    scalar = new Uint8Array(32).fill(7)
  status.phoneDirectP256 = hex.encode(p256.getPublicKey(scalar, true))
  status.rpId = location.hostname
  status.clientOrigin = location.origin
  clearSpendingRenewalReads(status.vaultId)
  const context = guardianRenewalContext(status)
  const f = delegationFixture(
    buildLightDescriptor({
      ...context,
      exitDelaySeconds: status.vtxoExitDelay!,
      spendingPolicy: defaultLightPolicy(context.network),
    }),
  )
  const coins = [f.coin, { ...f.coin, txid: '33'.repeat(32) }].map((coin) => ({
    ...coin,
    script: context.scriptPubKey,
  }))
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(f.info)
  vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: coins })
  let schedules = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (url.endsWith('/info')) {
        expect(body).toEqual({ vaultId: status.vaultId })
        return Response.json({
          ...f.capability,
          program: context.program,
          descriptorHash: guardianRenewalContextDigest(status),
          maxPlans: 50,
          delegateAddress: spendingDelegationAddress(status),
        })
      }
      if (url.endsWith('/list')) return Response.json({ version: 1, operations: [], nextCursor: '' })
      if (!url.endsWith('/schedule')) throw new Error('Unexpected request')
      schedules++
      validateSpendingRenewalSet(body, status)
      expect((await loadSpendingRenewals(status)).sets[body.setId]).toEqual(body)
      return Response.json({
        setId: body.setId,
        operations: body.plans.map((plan: (typeof body.plans)[number]) => {
          const facts = validateSpendingSchedule(
            { program: body.program, descriptorHash: body.descriptorHash, vaultId: body.vaultId, ...plan },
            status,
          )
          return {
            version: 1,
            program: body.program,
            descriptorHash: body.descriptorHash,
            operationId: plan.operationId,
            state: 'armed',
            validAt: facts.message.valid_at,
            expiresAt: plan.expiresAt,
            txid: facts.txid,
            vout: facts.vout,
            inputValueSats: facts.valueSats,
            receiverSats: facts.receiverSats,
          }
        }),
      })
    }),
  )
  const auth = {
    phoneSecret: new Uint8Array(32).fill(1),
    scalar,
    assertion: { credentialId: '01', clientDataJSON: '00', authenticatorData: '00', signature: '00' },
  }
  return {
    coins,
    status,
    auth,
    schedules: () => schedules,
    enrollment: {
      vaultId: status.vaultId,
      credId: '01',
      phoneDirectP256: status.phoneDirectP256,
      phoneBip340Pub: status.phoneBip340Pub,
    } as EnrollmentSecrets,
  }
}

describe('automatic renewal authorization ceremony boundaries', () => {
  it('requests a fresh setup ceremony for uncovered outputs without sending after dismissal', async () => {
    const f = environment(vectors[1].status)
    const get = vi.fn(async () => {
      throw new Error('Setup dismissed')
    })
    Object.assign(navigator, { credentials: { get } })
    await setupSpendingRenewals(f.status, f.enrollment)
    expect(get).toHaveBeenCalledOnce()
    expect(f.schedules()).toBe(0)
    expect((await loadSpendingRenewals(f.status)).error).toBe('Setup dismissed')
  })
  it('does not open another passkey ceremony when every output is reserved for a payment', async () => {
    const f = environment(vectors[1].status)
    vi.spyOn(spending, 'listPersistedVtxoSpends').mockReturnValue([
      {
        vaultId: f.status.vaultId,
        operationId: 'ab'.repeat(16),
        bundleDigest: 'cd'.repeat(32),
        destAddress: f.status.spendingArkAddress!,
        amountSats: 1000,
        arkTxid: 'ef'.repeat(32),
        stage: 'reserved',
        reservedInputs: f.coins.map((coin) => ({
          txid: coin.txid,
          vout: coin.vout,
          valueSats: coin.value,
          scriptHex: coin.script!,
        })),
      },
    ])
    const get = vi.fn(async () => {
      throw new Error('An unnecessary passkey prompt was opened')
    })
    Object.assign(navigator, { credentials: { get } })
    await setupSpendingRenewals(f.status, f.enrollment)
    expect(get).not.toHaveBeenCalled()
    expect((await loadSpendingRenewals(f.status)).error).toBeUndefined()
    expect(f.schedules()).toBe(0)
  })
  it.each(vectors.filter((v) => v.context.protectionTier !== 'light'))(
    'submits one bounded set for $name',
    async (vector) => {
      const f = environment(vector.status)
      const result = await authorizeSpendingRenewals(f.status, f.enrollment, f.auth)
      expect(result?.error).toBeUndefined()
      expect(f.schedules()).toBe(1)
      expect(Object.values(result!.operations).map((s) => s.status?.state)).toEqual(['armed', 'armed'])
      expect(f.auth.phoneSecret.some((b) => b !== 0)).toBe(true)
    },
  )
  it('does not schedule new authority using a consumed recovery-login assertion', async () => {
    const f = environment(vectors[1].status)
    const result = await authorizeSpendingRenewals(f.status, f.enrollment, f.auth, false)
    expect(result?.error).toBeUndefined()
    expect(f.schedules()).toBe(0)
    expect(mocks.ancestry).not.toHaveBeenCalled()
    expect(result?.operations).toEqual({})
  })
  it('stops new authorizations when the wallet locks during ancestry verification', async () => {
    const f = environment(vectors[1].status)
    mocks.ancestry.mockImplementation(async () => clearSpendingRenewalReads(f.status.vaultId))
    const result = await authorizeSpendingRenewals(f.status, f.enrollment, f.auth)
    expect(f.schedules()).toBe(0)
    expect(result?.sets).toEqual({})
  })
})
