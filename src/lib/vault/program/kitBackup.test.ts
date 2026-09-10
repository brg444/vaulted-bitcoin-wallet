import { requireSavingsRecoveryKit, buildRecoveryKit } from './kit'
import { describe, expect, it } from 'vitest'
import type { VaultStatus } from '../types'
import { defaultSpendingPolicy, spendingPolicyDigest, spendingPolicyFromLimits } from '../spendingPolicy'
import { buildVaultProgramDescriptor } from './descriptor'
import { PROGRAM_FIXTURE } from './fixtures'
import { buildMapBackup, kitFromFacts, parseMapBackup } from './kitBackup'

function descriptor(recovery = true) {
  return buildVaultProgramDescriptor({
    ...PROGRAM_FIXTURE,
    protectionTier: recovery ? 'advanced' : 'standard',
    recoveryPub: recovery ? PROGRAM_FIXTURE.recoveryPub : undefined,
  })
}

function statusFromDescriptor(committed: ReturnType<typeof descriptor>): VaultStatus {
  const spendingPolicy = spendingPolicyFromLimits({
    txRecipientCapSats: committed.policy.recipientCapSats,
    periodAllowanceSats: committed.policy.periodAllowanceSats,
    absoluteFeeCapSats: committed.policy.absoluteFeeCapSats,
    feerateCapSatPerV: committed.policy.feerateCapSatVb,
  })
  return {
    enrolled: true,
    network: committed.network,
    clientOrigin: 'https://vault.example',
    rpId: 'vault.example',
    vaultId: committed.vaultId,
    templateVersion: committed.templateVersion,
    policyVersion: committed.policyVersion,
    protectionTier: committed.protectionTier,
    externalOwnerWalletPub: committed.keys.hardware,
    vaultCosignerBasePub: committed.keys.vaultCosignerBase,
    arkadeCosignerBasePub: committed.keys.arkadeCosignerBase,
    arkadeCosignerOrigin: committed.arkadeCosigner.origin,
    arkadeCosignerVersion: committed.arkadeCosigner.version,
    savingsAddress: committed.savings.address,
    savingsScript: committed.savings.script,
    periodAllowance: committed.policy.periodAllowanceSats,
    periodSpent: 0,
    periodRemaining: committed.policy.periodAllowanceSats,
    txCap: committed.policy.recipientCapSats,
    absoluteFeeCap: committed.policy.absoluteFeeCapSats,
    feerateCapSatVb: committed.policy.feerateCapSatVb,
    spendingPolicy,
    spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
    phoneBip340Pub: committed.keys.phoneBip340,
    phoneDirectP256: committed.keys.phoneDirectP256,
    recoveryPub: committed.keys.recovery,
  }
}

describe('Savings map backup', () => {
  it('stores only the public committed Recovery Kit', () => {
    const kit = buildRecoveryKit(descriptor())
    const backup = buildMapBackup(kit, '2026-08-18T00:00:00.000Z')
    expect(backup.name).toBe('arkade-vault-map')
    expect(backup.version).toBe(3)
    expect(JSON.stringify(backup)).not.toMatch(/mnemonic|privateKey|secret/)
    expect(parseMapBackup(backup).kit.descriptorHash).toBe(kit.descriptorHash)
  })

  it('rebuilds only from complete signer-pinned status facts', () => {
    const committed = descriptor()
    const status = statusFromDescriptor(committed)
    expect(kitFromFacts({ status })?.descriptorHash).toBe(buildRecoveryKit(committed).descriptorHash)
    expect(kitFromFacts({ status: { ...status, arkadeCosignerOrigin: undefined } })).toBeNull()
    expect(kitFromFacts({ status: { ...status, savingsAddress: 'tb1pstale' } })).toBeNull()
    expect(kitFromFacts({ status: { ...status, savingsScript: '5120' + '00'.repeat(32) } })).toBeNull()
    expect(kitFromFacts({ status: { ...status, spendingPolicyDigest: '00'.repeat(32) } })).toBeNull()
  })

  it('persists a usable no-recovery Savings kit', () => {
    const committed = descriptor(false)
    const rebuilt = requireSavingsRecoveryKit(kitFromFacts({ status: statusFromDescriptor(committed) })!)
    expect(rebuilt?.descriptor.keys.recovery).toBeUndefined()
    expect(rebuilt?.descriptor.savings.address).toBe(committed.savings.address)
  })

  it('rebuilds the exact custom policy instead of substituting the default policy', () => {
    const selected = {
      ...defaultSpendingPolicy(),
      txRecipientCapSats: 75_000,
      periodAllowanceSats: 300_000,
    }
    const committed = buildVaultProgramDescriptor({ ...PROGRAM_FIXTURE, spendingPolicy: selected })
    const rebuilt = requireSavingsRecoveryKit(kitFromFacts({ status: statusFromDescriptor(committed) })!)

    expect(rebuilt?.spendingPolicyDigest).toBe(spendingPolicyDigest(selected))
    expect(rebuilt?.descriptorHash).toBe(buildRecoveryKit(committed).descriptorHash)
  })

  it('does not reconstruct a legacy status without the immutable policy', () => {
    const committed = descriptor()
    const status = statusFromDescriptor(committed)
    delete status.spendingPolicy
    delete status.spendingPolicyDigest
    expect(kitFromFacts({ status })).toBeNull()
  })
})
