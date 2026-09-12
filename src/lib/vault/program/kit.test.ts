import { describe, expect, it } from 'vitest'
import { ledgerRecoveryFacts, sharedSpendingRecoveryFixture } from '../recovery/testdata/helpers'
import { buildRecoveryKit, inspectRecoveryKit, parseRecoveryKit } from './kit'

describe('retained Recovery Kits', () => {
  it.each(['mainnet', 'mutinynet'] as const)('rebuilds both Ledger protection levels on %s', (network) => {
    for (const advanced of [false, true]) {
      const { kit } = ledgerRecoveryFacts(advanced, network)
      expect(parseRecoveryKit(JSON.parse(JSON.stringify(kit)))).toEqual(kit)
      const report = inspectRecoveryKit(kit)
      expect(report.hash).toBe(kit.descriptorHash)
      expect(kit.version).toBe(4)
      expect(report.trees).toHaveLength(advanced ? 8 : 6)
      expect(report.trees.some((tree) => tree.role === 'savings-change')).toBe(true)
      expect(report.trees.some((tree) => tree.role.includes('recovery'))).toBe(advanced)
      expect(report.warnings.some((line) => /phone and hardware keys without either service/.test(line))).toBe(true)
    }
  })
  it('rejects changed bindings, cross-family versions and extra fields for every retained kit', () => {
    const kits = [ledgerRecoveryFacts().kit, sharedSpendingRecoveryFixture().kit]
    for (const kit of kits) {
      for (const patch of [
        { descriptorHash: '00'.repeat(32) },
        { protectionTier: 'unknown' },
        { spendingPolicyDigest: '00'.repeat(32) },
        { version: kit.version === 4 ? 5 : 4 },
        { unlock: {} },
      ])
        expect(() => parseRecoveryKit({ ...kit, ...patch })).toThrow()
    }
  })
  it('rejects historical direct-hardware, Light and connector kits without rebuilding them', () => {
    const descriptor = { schema: 'arkade-vault/savings-v1', templateVersion: 'phone-hww-recovery-savings-v1' }
    expect(() => buildRecoveryKit(descriptor as never)).toThrow('Unsupported Recovery Kit descriptor')
    for (const version of [1, 2, 3, 6])
      expect(() => parseRecoveryKit({ name: 'arkade-recovery-kit', version, descriptor })).toThrow('version')
    for (const name of ['arkade-connector-enrollment', 'vaulted-light-recovery', 'vaulted-light-backup'])
      expect(() => parseRecoveryKit({ name, version: 1, descriptor })).toThrow('Recovery Kit')
    expect(() => parseRecoveryKit({ name: 'arkade-recovery-kit', version: 4, descriptor })).toThrow(
      'Ledger recovery descriptor',
    )
  })
})
