import { describe, expect, it } from 'vitest'
import { buildConnectorEnrollmentPreview } from './connectorEnroll'
import { validateSpendingPolicy } from '../spendingPolicy'
import type { BoardingDescriptor } from '../types'
import crossVectors from './connector-enrollment-vectors.json'

function narrowBoarding(value: unknown): BoardingDescriptor {
  const b = value as Record<string, unknown>
  if (
    b.schema !== 'arkade-vault/board-v1' ||
    b.program !== 'vault-board-v1' ||
    b.template !== 'vault-board-v1-boarding-vault-and-operator' ||
    (b.network !== 'mainnet' && b.network !== 'mutinynet') ||
    typeof b.boardingPub !== 'string' ||
    typeof b.recoveryPhonePub !== 'string' ||
    typeof b.vaultBoardCosignerPub !== 'string' ||
    typeof b.operatorPub !== 'string' ||
    typeof b.exitDelay !== 'number' ||
    b.exitDelayUnit !== 'seconds' ||
    typeof b.script !== 'string' ||
    typeof b.address !== 'string'
  )
    throw new Error('vector boarding shape')
  return b as unknown as BoardingDescriptor
}

// Cross-language qualification vectors generated from actual runtime
// previewConnectorEnrollmentDescriptor output (see /tmp source note in the
// integration report). input feeds buildConnectorEnrollmentPreview directly;
// proposed.descriptorHash is the authoritative runtime result and must never
// be edited to match the wallet.
describe('connector enrollment cross-language vectors', () => {
  for (const vector of crossVectors) {
    it(`${vector.name} reproduces the runtime composite hash`, () => {
      const input = vector.input
      if (input.network !== 'mainnet' && input.network !== 'mutinynet') throw new Error('vector network')
      if (input.protectionTier !== 'standard' && input.protectionTier !== 'advanced') throw new Error('vector tier')
      if (input.origin.connectorType !== 'p2wpkh' && input.origin.connectorType !== 'p2tr')
        throw new Error('vector type')
      if (input.boarding.network !== input.network) throw new Error('vector boarding network')
      const spendingPolicy = validateSpendingPolicy(input.spendingPolicy, input.network)
      const boarding = narrowBoarding(input.boarding)
      const preview = buildConnectorEnrollmentPreview({
        vaultId: input.vaultId,
        network: input.network,
        protectionTier: input.protectionTier,
        phonePub: input.phonePub,
        phoneDirectP256: input.phoneDirectP256,
        ...(input.recoveryPub ? { recoveryPub: input.recoveryPub } : {}),
        vaultCosignerBase: input.vaultCosignerBase,
        arkadeCosignerBase: input.arkadeCosignerBase,
        arkadeOrigin: input.arkadeOrigin,
        arkadeVersion: input.arkadeVersion,
        spendingPolicy,
        origin: {
          connectorPub: input.origin.connectorPub,
          connectorType: input.origin.connectorType,
          connectorFingerprint: input.origin.connectorFingerprint,
          connectorPath: [...input.origin.connectorPath],
        },
        boarding,
      })
      expect(preview.digest).toBe(vector.proposed.descriptor.connector.enrollmentDigest)
      expect(preview.compositeHash).toBe(vector.proposed.descriptorHash)
    })
  }

  it('a same-length boarding-field mutation changes the composite hash', () => {
    const vector = crossVectors[0]
    const input = vector.input
    if (input.network !== 'mainnet' && input.network !== 'mutinynet') throw new Error('vector network')
    if (input.origin.connectorType !== 'p2wpkh' && input.origin.connectorType !== 'p2tr') throw new Error('vector type')
    const network = input.network
    const connectorType = input.origin.connectorType
    const spendingPolicy = validateSpendingPolicy(input.spendingPolicy, network)
    const baseBoarding = narrowBoarding(input.boarding)
    const build = (boardingAddress: string) =>
      buildConnectorEnrollmentPreview({
        vaultId: input.vaultId,
        network,
        protectionTier: 'standard',
        phonePub: input.phonePub,
        phoneDirectP256: input.phoneDirectP256,
        vaultCosignerBase: input.vaultCosignerBase,
        arkadeCosignerBase: input.arkadeCosignerBase,
        arkadeOrigin: input.arkadeOrigin,
        arkadeVersion: input.arkadeVersion,
        spendingPolicy,
        origin: {
          connectorPub: input.origin.connectorPub,
          connectorType,
          connectorFingerprint: input.origin.connectorFingerprint,
          connectorPath: [...input.origin.connectorPath],
        },
        boarding: { ...baseBoarding, address: boardingAddress },
      }).compositeHash
    const original = input.boarding.address
    const last = original[original.length - 1]
    const mutated = `${original.slice(0, -1)}${last === '0' ? '1' : '0'}`
    expect(mutated.length).toBe(original.length)
    expect(build(mutated)).not.toBe(build(original))
  })
})
