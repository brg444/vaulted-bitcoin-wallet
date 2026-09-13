import { LEDGER_NATIVE_TEMPLATE } from '../program/ledgerNativeKeys'
import { ArkAddress } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import expectedVectors from './testdata/renewal-context-v1.json'
import { sharedSpendingStatusForNetwork } from './testdata/sharedSpending'
import { networkPins } from '../networkPins'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../spendingPolicy'
import type { VaultStatus } from '../types'
import { VaultPolicyV1Script } from './script'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'

const pub = (n: number) => schnorr.getPublicKey(new Uint8Array(32).fill(n))
const fixtures = (['mainnet', 'mutinynet'] as const).flatMap((network) => {
  const pins = networkPins(network)
  const light = sharedSpendingStatusForNetwork(network, {
    phoneSecret: new Uint8Array(32).fill(1),
    cosignerSecret: new Uint8Array(32).fill(2),
  })
  return [
    light,
    ...(['standard', 'advanced'] as const).flatMap((tier) =>
      [LEDGER_NATIVE_TEMPLATE].map((templateVersion) => {
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
  it.each([
    'vaulted-light-v1',
    'phone-hww-recovery-savings-v1',
    'phone-connector-recovery-savings-v1',
    'phone-connector-recovery-savings-v2',
  ])('rejects the retired renewal program %s', (templateVersion) => {
    expect(() => guardianRenewalContext({ ...fixtures[1], templateVersion } as unknown as VaultStatus)).toThrow(
      'Unsupported renewal program',
    )
  })

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

  it('requires the exact current Spending enrollment identity', () => {
    expect(() => guardianRenewalContext({ ...fixtures[0], vaultId: 'cd'.repeat(16) })).toThrow()
  })

  it('rejects tier, policy, and unnamed program substitutions', () => {
    const status = fixtures[1]
    expect(() => guardianRenewalContext({ ...status, protectionTier: 'advanced' } as unknown as VaultStatus)).toThrow()
    expect(() => guardianRenewalContext({ ...status, spendingPolicyDigest: '00'.repeat(32) })).toThrow()
    expect(() =>
      guardianRenewalContext({ ...status, templateVersion: 'future-program' } as unknown as VaultStatus),
    ).toThrow()
    expect(guardianRenewalContextDigest(fixtures[1])).not.toBe(guardianRenewalContextDigest(fixtures[2]))
  })

  it.each(expectedVectors)('Ledger Spending preserves the existing $name context bytes and digest', (vector) => {
    const status = vector.status as VaultStatus
    expect(guardianRenewalContext(status)).toEqual(vector.context)
    expect(guardianRenewalContextDigest(status)).toBe(vector.descriptorHash)
    expect(() => guardianRenewalContext({ ...status, spendingArkScript: '5120' + '11'.repeat(32) })).toThrow()
    expect(() => guardianRenewalContext({ ...status, spendingPolicyDigest: '00'.repeat(32) })).toThrow()
  })

  it('matches the cross-language vectors', () => {
    const vectors = fixtures
      .filter((status) => status.protectionTier !== 'light')
      .map((status) => ({
        name: `${status.network}-${status.protectionTier}-${status.templateVersion}`,
        status,
        context: guardianRenewalContext(status),
        descriptorHash: guardianRenewalContextDigest(status),
      }))
    expect(vectors).toEqual(expectedVectors)
    expect(vectors).toHaveLength(4)
  })
})
