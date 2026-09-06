import { hex } from '@scure/base'
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js'
import { describe, expect, it } from 'vitest'
import { defaultSpendingPolicy, validateSpendingPolicy } from '../spendingPolicy'
import { VaultPolicyV1ContractHandler } from '../vtxo/contractHandler'
import {
  buildLightDescriptor,
  defaultLightPolicy,
  LightScript,
  lightDescriptorDigest,
  validateLightDescriptor,
  validateLightPolicy,
  type LightDescriptor,
} from './contract'
import { LightContractHandler } from './contractHandler'
import vectors from './testdata/contracts.json'

const fixtures = vectors.map((vector) => ({ ...vector, descriptor: vector.descriptor as LightDescriptor }))

describe('Light candidate contract', () => {
  it.each(fixtures)('matches independently generated runtime vectors for $descriptor.network', (vector) => {
    const descriptor = validateLightDescriptor(vector.descriptor)
    const script = new LightScript(descriptor)
    expect(lightDescriptorDigest(descriptor)).toBe(vector.descriptorDigest)
    expect(script.spendScript).toBe(vector.spendScript)
    expect(script.exitScript).toBe(vector.exitScript)
    expect(hex.encode(script.tweakedPublicKey)).toBe(vector.tapKey)
    expect(hex.encode(TaprootControlBlock.encode(script.forfeit()[0]))).toBe(vector.spendControlBlock)
    expect(hex.encode(TaprootControlBlock.encode(script.exit()[0]))).toBe(vector.exitControlBlock)
    expect(hex.encode(script.pkScript)).toBe(descriptor.scriptPubKey)
    expect(LightContractHandler.createScript(LightContractHandler.serializeParams(script.params)).pkScript).toEqual(
      script.pkScript,
    )
  })

  it.each(['standard', 'advanced', 'vault-policy-v1', ''])('rejects another profile/program identity %s', (value) => {
    const d = fixtures[0].descriptor
    expect(() => validateLightDescriptor({ ...d, profile: value })).toThrow()
    expect(() => validateLightDescriptor({ ...d, program: value })).toThrow()
  })

  it('rejects policy substitutions and tampered descriptors', () => {
    const d = fixtures[0].descriptor
    for (const patch of [
      { network: 'mainnet' },
      { network: 'bitcoin' },
      { exitDelaySeconds: 2048 },
      { operatorPub: d.cosignerPub },
      { ownerPub: d.cosignerPub },
      { ownerPub: 'ff'.repeat(32) },
      { scriptPubKey: '00' },
      { spendingPolicyDigest: '00'.repeat(32) },
      { hardwarePub: d.ownerPub },
      { spendingPolicy: { ...d.spendingPolicy, txRecipientCapSats: 25000 } },
    ]) {
      expect(() => validateLightDescriptor({ ...d, ...patch })).toThrow()
    }
    expect(() => validateLightPolicy(defaultSpendingPolicy('mutinynet'), 'mutinynet')).toThrow()
    expect(() => validateSpendingPolicy(d.spendingPolicy, 'mutinynet')).toThrow()
  })

  it('binds the exact policy and vault identity into the descriptor digest', () => {
    const d = fixtures[0].descriptor
    const changed = buildLightDescriptor({ ...d, spendingPolicy: { ...d.spendingPolicy, txRecipientCapSats: 25000 } })
    expect(lightDescriptorDigest(changed)).not.toBe(lightDescriptorDigest(d))
    expect(changed.scriptPubKey).toBe(d.scriptPubKey) // Enrollment must bind the policy to its scoped signer.
    expect(lightDescriptorDigest(buildLightDescriptor({ ...d, vaultId: 'bb'.repeat(32) }))).not.toBe(
      lightDescriptorDigest(d),
    )
  })

  it('uses the network fee caps and bounds the rolling allowance', () => {
    for (const network of ['mutinynet', 'mainnet'] as const) {
      const policy = defaultLightPolicy(network)
      expect(validateLightPolicy(policy, network)).toEqual(policy)
      for (const patch of [
        { txRecipientCapSats: 329 },
        { txRecipientCapSats: 1.5 },
        { txRecipientCapSats: Number.MAX_SAFE_INTEGER + 1 },
        { periodAllowanceSats: policy.txRecipientCapSats - 1 },
        { absoluteFeeCapSats: 0 },
        { feerateCapSatPerV: 100 },
        { period: 'calendar-day' },
        { extra: true },
      ]) {
        expect(() => validateLightPolicy({ ...policy, ...patch }, network)).toThrow()
      }
    }
  })

  it('keeps Light out of generic SDK selection and existing contract reload', () => {
    const script = new LightScript(fixtures[0].descriptor)
    expect(LightContractHandler.isGenericallySpendable?.({} as never)).toBe(false)
    expect(LightContractHandler.selectPath(script, {} as never, {} as never)).toBeNull()
    expect(LightContractHandler.getSpendablePaths(script, {} as never, {} as never)).toEqual([])
    expect(LightContractHandler.getAllSpendingPaths(script, {} as never, {} as never)).toEqual([])
    const serialized = LightContractHandler.serializeParams(script.params)
    expect(() => VaultPolicyV1ContractHandler.createScript(serialized)).toThrow()
    const patches: Record<string, string>[] = [
      { network: '' },
      { exitDelaySeconds: '04608' },
      { hardwarePub: script.params.ownerPub },
    ]
    for (const patch of patches) {
      expect(() => LightContractHandler.createScript({ ...serialized, ...patch })).toThrow()
    }
  })
})
