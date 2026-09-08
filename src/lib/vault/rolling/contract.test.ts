import { describe, expect, it } from 'vitest'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { bytesToHex } from '../hex'
import vectors from './testdata/rolling-allowance-v1.json'
import { compileRollingPrograms } from './compiler'
import { RollingAllowanceScript, type RollingContractParameters } from './contract'

const params: RollingContractParameters = {
  policy: vectors.policy,
  tier: 'light',
  exitDelaySeconds: vectors.descriptor.ExitDelaySeconds,
  user: vectors.descriptor.User,
  guardian: vectors.descriptor.Guardian,
  emulator: vectors.descriptor.Emulator,
  operator: vectors.descriptor.Operator,
}

describe('rolling allowance contract', () => {
  it('independently compiles the runtime bytecode', () => {
    const programs = compileRollingPrograms(params.policy)
    for (const name of ['spend', 'credit', 'renew', 'cleanup'] as const)
      expect(bytesToHex(programs[name])).toBe(vectors.scripts[name])
  })

  it('matches the complete Go taproot tree and each recovery proof', () => {
    const script = new RollingAllowanceScript(params)
    expect(`5120${bytesToHex(script.tweakedPublicKey)}`).toBe(vectors.scripts.pkScript)
    for (const name of ['spend', 'credit', 'renew', 'cleanup', 'exit'] as const) {
      const leaf = script[name]()
      expect(bytesToHex(leaf[1].slice(0, -1))).toBe(vectors.scripts[`${name}Leaf`])
      expect(bytesToHex(TaprootControlBlock.encode(leaf[0]))).toBe(vectors.scripts[`${name}Control`])
    }
  })

  it('rejects weakened recovery roles and malformed policy context', () => {
    for (const changed of [
      { ...params, guardian: params.user },
      { ...params, policy: { ...params.policy, receiptKey: params.policy.delegatePubkey.slice(2) } },
      { ...params, exitDelaySeconds: 511 },
      { ...params, tier: 'standard' as const },
      { ...params, tier: 'advanced' as const },
      { ...params, hardware: params.guardian },
      { ...params, policy: { ...params.policy, receiptKey: params.user.slice(2) } },
      { ...params, policy: { ...params.policy, checkpointExit: `${params.policy.checkpointExit}00` } },
    ])
      expect(() => new RollingAllowanceScript(changed)).toThrow()
  })
})
