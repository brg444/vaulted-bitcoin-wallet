import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe.each(['mutinynet', 'mainnet'] as const)('emergency Recovery Kit compatibility on %s', (network) => {
  it.each(['standard', 'advanced'] as const)('preserves the %s kit and its recovery trees', async (protectionTier) => {
    vi.stubEnv('VITE_VAULT_RELEASE_NETWORK', network)
    vi.resetModules()
    const { ledgerRecoveryFixture } = await import('../recovery/testdata/ledger')
    const { parseRecoveryKit, inspectRecoveryKit } = await import('./kit')
    const { extractRecoveryKitJson } = await import('../recovery/fileImport')
    const { kit } = await ledgerRecoveryFixture(protectionTier === 'advanced', network)

    const file = new TextEncoder().encode(JSON.stringify(kit))
    const recovered = parseRecoveryKit(JSON.parse(extractRecoveryKitJson(file)))
    expect(recovered).toEqual(kit)
    expect(inspectRecoveryKit(recovered).trees).toEqual(inspectRecoveryKit(kit).trees)
    expect(recovered.version).toBe(4)
    expect('unlock' in recovered).toBe(false)
    expect(() => parseRecoveryKit({ ...recovered, descriptorHash: '00'.repeat(32) })).toThrow(/binding/)
  })
})
