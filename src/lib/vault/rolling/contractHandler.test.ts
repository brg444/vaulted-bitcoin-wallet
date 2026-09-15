import { describe, expect, it } from 'vitest'
import { bytesToHex } from '../hex'
import vectors from './testdata/rolling-allowance-v1.json'
import { RollingAllowanceContractHandler as handler, registerRollingAllowanceContractHandler } from './contractHandler'
import { type RollingContractParameters } from './contract'

const params: RollingContractParameters = {
  policy: vectors.policy,
  tier: 'light',
  exitDelaySeconds: vectors.descriptor.ExitDelaySeconds,
  user: vectors.descriptor.User,
  guardian: vectors.descriptor.Guardian,
  emulator: vectors.descriptor.Emulator,
  operator: vectors.descriptor.Operator,
}

describe('rolling SDK contract persistence', () => {
  it('preserves the complete contract across repository reload', () => {
    const stored = handler.serializeParams(params)
    expect(handler.deserializeParams(stored)).toEqual(params)
    expect(bytesToHex(handler.createScript(stored).pkScript)).toBe(vectors.scripts.pkScript)
    registerRollingAllowanceContractHandler()
    registerRollingAllowanceContractHandler()
  })
  it('rejects missing, unknown and noncanonical persisted fields', () => {
    const stored = handler.serializeParams(params)
    for (const changed of [
      {},
      { ...stored, extra: 'value' },
      { descriptor: `${stored.descriptor} ` },
      { descriptor: stored.descriptor.replace('"budget":10000', '"budget":null') },
      { descriptor: stored.descriptor.replace('"tier":"light"', '"tier":"light","other":true') },
    ])
      expect(() => handler.deserializeParams(changed as Record<string, string>)).toThrow()
  })
  it('excludes allowance-controlled coins from generic SDK paths', () => {
    expect(handler.isGenericallySpendable?.({} as never)).toBe(false)
    expect(handler.selectPath({} as never, {} as never, {} as never)).toBe(null)
    expect(handler.getAllSpendingPaths({} as never, {} as never, {} as never)).toEqual([])
  })
})
