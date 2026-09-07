import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildVaultProgramDescriptor,
  hashVaultProgramDescriptor,
  type VaultProgramDescriptor,
  type VaultProgramDescriptorInput,
} from './descriptor'
import { PROGRAM_FIXTURE } from './fixtures'
import { requiredGuardianExitSigners } from './guardianExit'
import { clawbackWitnessBytes, initiateWitnessBytes } from './script'

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, 'savings-vectors.json'), 'utf8')) as {
  name: string
  recovery: boolean
  protectionTier: VaultProgramDescriptorInput['protectionTier']
  savings: { address: string; script: string }
  descriptorHash: string
  pending: Record<string, { address: string; script: string }>
  quarantine: Record<string, { address: string; script: string }>
}[]

describe('frozen Savings program vectors', () => {
  it('pins cancel signers and transition witness sizes', () => {
    expect(requiredGuardianExitSigners('phone', true)).toEqual(['hardware', 'recovery'])
    expect(requiredGuardianExitSigners('hardware', false)).toEqual(['phone'])
    expect(initiateWitnessBytes('phone', true)).toBe(399)
    expect(initiateWitnessBytes('hardware', false)).toBe(367)
    expect(clawbackWitnessBytes(true, true)).toBe(431)
  })

  it.each(vectors)('matches $name', (vector) => {
    const descriptor = buildVaultProgramDescriptor({
      ...PROGRAM_FIXTURE,
      protectionTier: vector.protectionTier,
      recoveryPub: vector.recovery ? PROGRAM_FIXTURE.recoveryPub : undefined,
    })
    expect(descriptor.savings).toEqual(vector.savings)
    expect(hashVaultProgramDescriptor(descriptor)).toBe(vector.descriptorHash)
    for (const [key, tree] of Object.entries(vector.pending)) {
      expect(descriptor.pending[key as keyof typeof descriptor.pending]).toMatchObject(tree)
    }
    for (const [key, tree] of Object.entries(vector.quarantine)) {
      expect(descriptor.quarantine[key as keyof typeof descriptor.quarantine]).toMatchObject(tree)
    }
  })
})

const customVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'savings-custom-policy-vectors.json'), 'utf8'),
) as {
  name: string
  input: Pick<VaultProgramDescriptorInput, 'network' | 'protectionTier' | 'spendingPolicy'>
  descriptor: VaultProgramDescriptor
  descriptorHash: string
}[]

describe('Guardian custom-policy Savings conformance', () => {
  it('covers both protection tiers on both release networks', () => {
    expect(customVectors.map((vector) => `${vector.input.network}/${vector.input.protectionTier}`).sort()).toEqual([
      'mainnet/advanced',
      'mainnet/standard',
      'mutinynet/advanced',
      'mutinynet/standard',
    ])
  })

  it.each(customVectors)('independently reconstructs $name and binds its custom cap', (vector) => {
    const input = {
      ...PROGRAM_FIXTURE,
      ...vector.input,
      recoveryPub: vector.input.protectionTier === 'advanced' ? PROGRAM_FIXTURE.recoveryPub : undefined,
    }
    const descriptor = buildVaultProgramDescriptor(input)
    expect(descriptor).toEqual(vector.descriptor)
    expect(hashVaultProgramDescriptor(descriptor)).toBe(vector.descriptorHash)
    const changed = buildVaultProgramDescriptor({
      ...input,
      spendingPolicy: {
        ...input.spendingPolicy!,
        txRecipientCapSats: input.spendingPolicy!.txRecipientCapSats - 1,
      },
    })
    expect(changed.policy.digest).not.toBe(descriptor.policy.digest)
    expect(hashVaultProgramDescriptor(changed)).not.toBe(vector.descriptorHash)
  })
})
