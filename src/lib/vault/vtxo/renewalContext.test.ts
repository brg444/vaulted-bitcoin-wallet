import { ArkAddress } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import expectedVectors from './testdata/renewal-context-v1.json'
import { buildLightDescriptor, defaultLightPolicy } from '../light/contract'
import { lightTestStatus } from '../light/testdata/helpers'
import { requireLightStatus } from '../light/status'
import { networkPins } from '../networkPins'
import { CONNECTOR_TEMPLATE } from '../program/connector'
import { SAVINGS_TEMPLATE } from '../program/constants'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../spendingPolicy'
import type { VaultStatus } from '../types'
import { VaultPolicyV1Script } from './script'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'

const pub = (n: number) => schnorr.getPublicKey(new Uint8Array(32).fill(n))
const fixtures = (['mainnet', 'mutinynet'] as const).flatMap((network) => {
  const pins = networkPins(network)
  const light = requireLightStatus(
    lightTestStatus(
      buildLightDescriptor({
        network,
        vaultId: 'ab'.repeat(32),
        ownerPub: hex.encode(pub(1)),
        cosignerPub: hex.encode(pub(2)),
        operatorPub: pins.operatorSignerPub.slice(2),
        exitDelaySeconds: pins.policyExitDelay,
        spendingPolicy: defaultLightPolicy(network),
      }),
    ),
  )
  return [
    light,
    ...(['standard', 'advanced'] as const).flatMap((tier) =>
      [SAVINGS_TEMPLATE, CONNECTOR_TEMPLATE].map((templateVersion) => {
        const policy = { ...defaultSpendingPolicy(network), txRecipientCapSats: 12000, periodAllowanceSats: 35000 }
        const script = new VaultPolicyV1Script({
          network,
          userPub: pub(1),
          vtxoVaultCosignerPub: pub(2),
          arkdServerPub: hex.decode(pins.operatorSignerPub.slice(2)),
          delegatePub: hex.decode(pins.delegatePub.slice(2)),
          exitDevicePub: pub(1),
          exitHardwarePub: pub(3),
          ...(tier === 'advanced' ? { exitRecoveryPub: pub(4) } : {}),
          exitDelay: BigInt(pins.policyExitDelay),
          exitDelayUnit: 'seconds',
        })
        return {
          enrolled: true,
          network,
          vaultId: 'cd'.repeat(32),
          templateVersion,
          protectionTier: tier,
          phoneBip340Pub: `02${hex.encode(pub(1))}`,
          vtxoVaultCosignerPub: `02${hex.encode(pub(2))}`,
          externalOwnerWalletPub: `02${hex.encode(pub(3))}`,
          ...(tier === 'advanced' ? { recoveryKeyPub: `02${hex.encode(pub(4))}` } : {}),
          vtxoDelegatePub: pins.delegatePub,
          vtxoExitDelay: pins.policyExitDelay,
          vtxoExitDelayUnit: 'seconds',
          spendingArkAddress: new ArkAddress(
            script.params.arkdServerPub,
            script.tweakedPublicKey,
            pins.arkHrp,
          ).encode(),
          spendingArkScript: hex.encode(script.pkScript),
          spendingPolicy: policy,
          spendingPolicyDigest: spendingPolicyDigest(policy, network),
          periodAllowance: policy.periodAllowanceSats,
          txCap: policy.txRecipientCapSats,
          absoluteFeeCap: policy.absoluteFeeCapSats,
          feerateCapSatVb: policy.feerateCapSatPerV,
        } as VaultStatus
      }),
    ),
  ]
})

describe('shared Spending renewal identity', () => {
  it.each(fixtures)('binds $network $protectionTier $templateVersion to the complete original tree', (status) => {
    const context = guardianRenewalContext(status)
    expect(context.scriptPubKey).toBe(status.spendingArkScript)
    expect(context.program).toBe(status.spendingPolicy!.program)
    expect(context.protectionTier).toBe(status.protectionTier)
    expect(guardianRenewalContextDigest({ ...status, passkeyLoginAvailable: !status.passkeyLoginAvailable })).toBe(
      guardianRenewalContextDigest(status),
    )
    const changed = structuredClone(status)
    changed.spendingArkScript = '5120' + '11'.repeat(32)
    expect(() => guardianRenewalContext(changed)).toThrow()
  })

  it.each(fixtures.filter((status) => status.protectionTier !== 'light'))(
    'accepts actual enrollment IDs for $network $protectionTier $templateVersion',
    (status) => {
      const vaultId = '85d3dbe6dc97a42859b28dde49400985'
      const enrolled = { ...status, vaultId }
      expect(guardianRenewalContext(enrolled).vaultId).toBe(vaultId)
      expect(guardianRenewalContext(enrolled).scriptPubKey).toBe(status.spendingArkScript)
      expect(guardianRenewalContextDigest(enrolled)).not.toBe(guardianRenewalContextDigest(status))
      for (const invalid of ['', ' ' + vaultId, vaultId + '\n', '\u0085' + vaultId]) {
        expect(() => guardianRenewalContext({ ...status, vaultId: invalid })).toThrow('identity is invalid')
      }
    },
  )

  it.each(['existing-tenant-vault', '550e8400-e29b-41d4-a716-446655440000', 'vault-é', '\uFEFFvault'])(
    'preserves opaque enrolled Vault identity %s',
    (vaultId) => {
      expect(guardianRenewalContext({ ...fixtures[1], vaultId }).vaultId).toBe(vaultId)
    },
  )

  it('retains the distinct Light descriptor ID contract', () => {
    expect(() => guardianRenewalContext({ ...fixtures[0], vaultId: 'ab'.repeat(16) })).toThrow()
  })

  it('rejects tier, policy, and unnamed program substitutions', () => {
    const status = fixtures[1]
    expect(() => guardianRenewalContext({ ...status, protectionTier: 'advanced' })).toThrow()
    expect(() => guardianRenewalContext({ ...status, spendingPolicyDigest: '00'.repeat(32) })).toThrow()
    expect(() => guardianRenewalContext({ ...status, templateVersion: 'future-program' })).toThrow()
    expect(guardianRenewalContextDigest(fixtures[1])).not.toBe(guardianRenewalContextDigest(fixtures[3]))
  })

  it('matches the cross-language vectors', () => {
    const vectors = fixtures.map((status) => ({
      name: `${status.network}-${status.protectionTier}-${status.templateVersion}`,
      status,
      context: guardianRenewalContext(status),
      descriptorHash: guardianRenewalContextDigest(status),
    }))
    expect(vectors).toEqual(expectedVectors)
    expect(vectors).toHaveLength(10)
  })
})
