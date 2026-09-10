import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseBuild } from '../../../scripts/release-build'

vi.mock('vite', () => ({ loadEnv: () => ({}) }))

afterEach(() => vi.unstubAllEnvs())

describe('mainnet release feature configuration', () => {
  it.each(['', 'false'])('keeps the canonical UI when shell feature flags are %j', async (value) => {
    vi.stubEnv('VITE_VAULT_RELEASE_NETWORK', 'mainnet')
    vi.stubEnv('VAULT_RELEASE_NETWORK', 'mainnet')
    vi.stubEnv('VERCEL', '')
    for (const flag of ['VITE_VAULT_LIGHTNING_SEND', 'VITE_VAULT_LIGHTNING_RECEIVE', 'VITE_VAULT_LNURL']) {
      vi.stubEnv(flag, value)
    }
    vi.stubEnv('VITE_VAULT_LIGHTNING_RECEIVE_VAULT', 'an-old-wallet')
    const plugin = releaseBuild()
    const config = plugin.config as (config: object, env: object) => { define: Record<string, string> }
    const result = config({}, { command: 'build', mode: 'production' })
    expect(result.define['import.meta.env.VITE_VAULT_LIGHTNING_RECEIVE']).toBe('"true"')
    expect(result.define['import.meta.env.VITE_VAULT_LNURL']).toBe('"true"')
    expect(result.define['import.meta.env.VITE_VAULT_LIGHTNING_SEND']).toBe('"true"')
    expect(result.define['import.meta.env.VITE_VAULT_LIGHT_ONLY_ENROLLMENT']).toBe('"true"')
    expect(result.define['import.meta.env.VITE_VAULT_LIGHTNING_RECEIVE_VAULT']).toBe('undefined')
  })
})
