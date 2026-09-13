import { describe, expect, it } from 'vitest'
import type { VaultStatus } from '../types'
import { ledgerRecoveryFacts, sharedSpendingRecoveryFixture } from '../recovery/testdata/helpers'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../spendingPolicy'
import { buildMapBackup, kitFromFacts, parseMapBackup } from './kitBackup'

describe('retained map backup', () => {
  it('stores only the public committed Recovery Kit', () => {
    const { kit } = ledgerRecoveryFacts()
    const backup = buildMapBackup(kit, '2026-08-18T00:00:00.000Z')
    expect(backup.name).toBe('arkade-vault-map')
    expect(backup.version).toBe(3)
    expect(JSON.stringify(backup)).not.toMatch(/mnemonic|privateKey|secret/)
    expect(parseMapBackup(backup).kit).toEqual(kit)
  })
  it.each(['mainnet', 'mutinynet'] as const)(
    'rebuilds complete Standard and Advanced Ledger facts on %s',
    (network) => {
      for (const advanced of [false, true]) {
        const { kit, status } = ledgerRecoveryFacts(advanced, network)
        expect(kitFromFacts({ status })).toEqual(kit)
        expect(Boolean(kit.descriptor.keys.recovery)).toBe(advanced)
        for (const patch of [
          { ledgerSavings: undefined },
          { savingsAddress: 'tb1pstale' },
          { savingsScript: '5120' + '00'.repeat(32) },
          { spendingPolicyDigest: '00'.repeat(32) },
          { spendingPolicy: undefined },
        ])
          expect(kitFromFacts({ status: { ...status, ...patch } as unknown as VaultStatus })).toBeNull()
        expect(kitFromFacts({ status, hardwarePub: status.phoneBip340Pub })).toBeNull()
      }
    },
  )
  it('preserves the committed custom policy', () => {
    const selected = { ...defaultSpendingPolicy(), txRecipientCapSats: 75000, periodAllowanceSats: 300000 }
    const { kit, status } = ledgerRecoveryFacts(true, 'mutinynet', { spendingPolicy: selected })
    expect(kitFromFacts({ status })).toEqual(kit)
    expect(kit.spendingPolicyDigest).toBe(spendingPolicyDigest(selected))
  })
  it('rebuilds shared Spending and rejects every retired template without fallback', () => {
    const { kit, status } = sharedSpendingRecoveryFixture()
    expect(kitFromFacts({ status })).toEqual(kit)
    for (const templateVersion of [
      'phone-hww-recovery-savings-v1',
      'vaulted-light-v1',
      'phone-connector-recovery-savings-v1',
      'phone-connector-recovery-savings-v2',
      '',
    ])
      expect(
        kitFromFacts({ status: { ...ledgerRecoveryFacts().status, templateVersion } as unknown as VaultStatus }),
      ).toBeNull()
    expect(kitFromFacts({})).toBeNull()
  })
})
