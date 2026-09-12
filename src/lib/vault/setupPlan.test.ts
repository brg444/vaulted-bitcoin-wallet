import { ledgerSpendingPublicKey } from './ledgerSetup'
import vectors from './program/ledger-key-vectors.json'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FORBIDDEN_PUBLIC_KEY_2G,
  FORBIDDEN_PUBLIC_KEY_G,
  emptySetupPlan,
  loadSetupPlan,
  parseCompressedPub,
  planReady,
  sameRole,
  saveSetupPlan,
  SETUP_STORE_KEY,
} from './setupPlan'
import { FIXTURE_IDENTITIES } from './program/fixtures'

const context = vectors.find((v) => v.input.network === 'mutinynet' && v.input.recovery)!.input
const ledger = { hardware: context.hardware }
const hardwarePub = ledgerSpendingPublicKey(context.hardware, 'mutinynet')
const recoveryPub = ledgerSpendingPublicKey(context.recovery!, 'mutinynet')

afterEach(() => localStorage.clear())

describe('vault setup plan', () => {
  it('accepts hardware without recovery, and rejects the same key as recovery', () => {
    expect(parseCompressedPub(FIXTURE_IDENTITIES.hardwarePub)).toBe(FIXTURE_IDENTITIES.hardwarePub)
    expect(sameRole(FORBIDDEN_PUBLIC_KEY_2G, FORBIDDEN_PUBLIC_KEY_G)).toBe(false)
    const noRecovery = {
      ...emptySetupPlan(),
      acceptedDesign: true,
      hardwarePub,
      ledger,
    }
    expect(planReady(noRecovery)).toBe(true)
    const same = {
      ...noRecovery,
      recoveryPub: hardwarePub,
    }
    expect(planReady(same)).toBe(false)
    const plan = {
      ...noRecovery,
      protectionTier: 'advanced' as const,
      recoveryPub,
      ledger: { ...ledger, recovery: context.recovery! },
    }
    expect(planReady(plan)).toBe(true)
  })

  it('rejects a plan with no hardware key', () => {
    const plan = {
      ...emptySetupPlan(),
      acceptedDesign: true,
    }
    expect(planReady(plan)).toBe(false)
  })

  it('rejects a truncated key', () => {
    expect(() => parseCompressedPub('02c6047f')).toThrow(/33-byte/)
  })

  it('keeps the public generator points distinct from ordinary fixture keys', () => {
    expect(FORBIDDEN_PUBLIC_KEY_G).not.toBe(FIXTURE_IDENTITIES.hardwarePub)
    expect(FORBIDDEN_PUBLIC_KEY_2G).not.toBe(FIXTURE_IDENTITIES.hardwarePub)
  })

  it('round-trips the complete configurable policy shape', () => {
    const plan = {
      ...emptySetupPlan(),
      hardwarePub,
      ledger,
      acceptedDesign: true,
    }
    saveSetupPlan(plan)
    expect(loadSetupPlan()).toEqual(plan)
  })

  it('does not migrate a setup plan that predates configurable fee policy', () => {
    localStorage.setItem(
      SETUP_STORE_KEY,
      JSON.stringify({
        hardwarePub,
        ledger,
        recoveryPub: '',
        txCapSats: 50_000,
        dailyLimitSats: 100_000,
        acceptedDesign: true,
        complete: true,
      }),
    )
    expect(loadSetupPlan()).toBeNull()
  })

  it('requires the selected protection tier to match recovery-key presence', () => {
    const base = { ...emptySetupPlan(), acceptedDesign: true, hardwarePub, ledger }
    expect(planReady({ ...base, protectionTier: 'advanced' })).toBe(false)
    expect(planReady({ ...base, protectionTier: 'standard', recoveryPub: FIXTURE_IDENTITIES.recoveryPub })).toBe(false)
    expect(
      planReady({
        ...base,
        protectionTier: 'advanced',
        recoveryPub,
        ledger: { ...ledger, recovery: context.recovery! },
      }),
    ).toBe(true)
  })

  it('does not migrate a setup plan that predates protection tiers', () => {
    const legacy: Partial<ReturnType<typeof emptySetupPlan>> = {
      ...emptySetupPlan(),
      hardwarePub,
      ledger,
      acceptedDesign: true,
      complete: true,
    }
    delete legacy.protectionTier
    localStorage.setItem(SETUP_STORE_KEY, JSON.stringify(legacy))
    expect(loadSetupPlan()).toBeNull()
  })
})

describe('retired setup rejection', () => {
  it.each([{}, { connector: {} }, { connector: { descriptor: 'retired' } }])(
    'rejects raw hardware and connector setup without importing it: %o',
    (extra) => {
      const plan = { ...emptySetupPlan(), acceptedDesign: true, hardwarePub, ...extra }
      saveSetupPlan(plan)
      expect(loadSetupPlan()).toBeNull()
      expect(planReady(plan)).toBe(false)
    },
  )
  it('rejects a substituted Ledger Spending key', () => {
    const plan = { ...emptySetupPlan(), acceptedDesign: true, hardwarePub: FIXTURE_IDENTITIES.hardwarePub, ledger }
    saveSetupPlan(plan)
    expect(loadSetupPlan()).toBeNull()
    expect(planReady(plan)).toBe(false)
  })
})
