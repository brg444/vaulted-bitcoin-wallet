import { describe, expect, it } from 'vitest'
import { buildVaultProgramDescriptor } from './descriptor'
import { PROGRAM_FIXTURE } from './fixtures'
import { buildRecoveryKit, inspectRecoveryKit, parseRecoveryKit } from './kit'

describe('Recovery Kit', () => {
  it('rebuilds the descriptor and lists the seven Savings trees', () => {
    const kit = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
    const report = inspectRecoveryKit(kit)
    expect(report.hash).toBe(kit.descriptorHash)
    expect(kit.version).toBe(3)
    expect(kit.protectionTier).toBe('advanced')
    expect(report.trees).toHaveLength(7)
    expect(report.trees.some((tree) => tree.role === 'savings')).toBe(true)
    expect(report.trees.some((tree) => tree.role.includes('daily'))).toBe(false)
    expect(report.trees.some((tree) => tree.delay === 288)).toBe(true)
    expect(report.warnings.some((line) => /phone and hardware keys without either service/.test(line))).toBe(true)
    expect(parseRecoveryKit(JSON.parse(JSON.stringify(kit))).descriptorHash).toBe(kit.descriptorHash)
  })

  it('rejects a tampered hash', () => {
    const kit = buildRecoveryKit(buildVaultProgramDescriptor(PROGRAM_FIXTURE))
    expect(() => parseRecoveryKit({ ...kit, descriptorHash: '00'.repeat(32) })).toThrow(/hash/)
    expect(() => parseRecoveryKit({ ...kit, protectionTier: 'standard' })).toThrow(/protection tier/)
    expect(() => parseRecoveryKit({ ...kit, version: 2 })).toThrow(/version/)
    expect(() => parseRecoveryKit({ name: 'emergency-exit', version: 1, descriptor: kit.descriptor })).toThrow(
      /Recovery Kit/,
    )
  })

  it('inspects and restores a Standard kit without a recovery claimant', () => {
    const descriptor = buildVaultProgramDescriptor({
      ...PROGRAM_FIXTURE,
      protectionTier: 'standard',
      recoveryPub: undefined,
    })
    const kit = buildRecoveryKit(descriptor)
    const report = inspectRecoveryKit(parseRecoveryKit(JSON.parse(JSON.stringify(kit))))

    expect(kit.protectionTier).toBe('standard')
    expect(report.trees).toHaveLength(5)
    expect(report.trees.some((tree) => tree.role.includes('recovery'))).toBe(false)
  })
})
