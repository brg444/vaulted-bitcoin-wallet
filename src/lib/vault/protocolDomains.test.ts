import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { POLICY_VERSION, RUNTIME_SCHEMA_VERSION } from './constants'
import { LEDGER_NATIVE_TEMPLATE } from './program/ledgerNativeKeys'
import { SPENDING_ONLY_TEMPLATE, SPENDING_ENROLLMENT_SCHEMA } from './spendingEnrollment'
import pack from './contract-pack.json'
import mainnetPack from './contract-pack.mainnet.json'

describe('frozen wallet protocol domains', () => {
  it.each([pack, mainnetPack])('admits only shared Spending and optional Ledger in baseline v3', (release) => {
    expect(release.version).toBe(3)
    expect(release.databaseSchemaVersion).toBe(RUNTIME_SCHEMA_VERSION)
    expect(Object.keys(release.programs).sort()).toEqual([LEDGER_NATIVE_TEMPLATE, 'vault-board-v1', 'vault-policy-v1'])
    expect(Object.keys(release.enrollmentProfiles)).toEqual([SPENDING_ONLY_TEMPLATE])
    expect(release.enrollmentProfiles[SPENDING_ONLY_TEMPLATE].schema).toBe(SPENDING_ENROLLMENT_SCHEMA)
    const savings = release.programs[LEDGER_NATIVE_TEMPLATE]
    expect(savings.policy).toBe(POLICY_VERSION)
    expect(savings.schema).toBe('arkade-vault/ledger-savings-enrollment-v1')
    expect(savings.template).toBe(LEDGER_NATIVE_TEMPLATE)
    expect(savings.enrollable).toBe(true)
    expect(savings.admissionDefault).toBe(false)
    expect(savings.formats).toEqual({ runtimeSchema: 12, recoveryBinding: 6, recoveryKit: 4, recoveryHeader: 2 })
    expect(release.formats).toEqual({
      recoveryKit: { [SPENDING_ONLY_TEMPLATE]: 5, [LEDGER_NATIVE_TEMPLATE]: 4 },
      mapBackup: 3,
    })
    expect(release.domains.vaultRecord).toBe('arkade-vault/vault-record/v2')
    expect(release.domains.recoveryBinding).toBe('arkade-vault/recovery-binding/v4')
    expect(release.domains.ledgerRecoveryBinding).toBe('arkade-vault/recovery-binding/v6')
    expect(release.domains).not.toHaveProperty('recoverySession')
    expect(release.domains).not.toHaveProperty('connectorRecoveryBinding')
  })

  it.each([
    ['vtxo/testdata/renewal-context-v1.json', '75abc40808225f78b3e38a9dd0937f75c45ced819341a3b2881eb3f9488eefbf'],
    ['vtxo/testdata/renewal-set-v1.json', '7f1eb0af4b7b68c346677c840c95c512d0069c841602a3d24a9459b799c1ec47'],
    ['contract-pack.json', '2e0fe83070119b52946bef904fdde59787bb8de489b336e77f8a955abf9560e3'],
    ['contract-pack.mainnet.json', 'e629e269c1acf735d794f95e1c8ee10691bdddaffe8906606085368db7438618'],
  ])('pins the exact release bytes for %s', (name, digest) => {
    expect(
      createHash('sha256')
        .update(readFileSync(resolve(import.meta.dirname, name)))
        .digest('hex'),
    ).toBe(digest)
  })

  it('lists vault-policy-v1 as 3-key collaborative spend beside Savings', () => {
    const listed = pack.programs['vault-policy-v1']
    expect(listed.status).toBe('listed')
    expect(listed.module).toBe('vtxo')
    expect(listed.template).toBe('vault-policy-v1-collaborative-3key')
    expect(listed.spend.leaf).toBe('user-and-vtxo-vault-cosigner-and-arkd')
    expect(listed.spend.note).toContain('VaultCosigner independently enforces the Vault Program')
    expect(listed.notes).toContain('3-key [user, VTXO VaultCosigner, Arkade Operator]')
  })

  it('pins client HKDF domains in source', () => {
    const enroll = readFileSync(resolve(import.meta.dirname, 'tenantEnrollment.ts'), 'utf8')
    expect(enroll).toContain('arkade-2fa-vault/prf/v1')
    expect(enroll).toContain('arkade-2fa-vault/kek/v1')
    expect(enroll).toContain('arkade-2fa-vault/direct-p256/v1')
    const binding = readFileSync(resolve(import.meta.dirname, 'passkeyBinding.ts'), 'utf8')
    expect(binding).toContain('arkade-vault/recovery-binding/v4')
    expect(binding).toContain('arkade-2fa-vault/passkey-proof/v1')
  })

  it('does not publish enrollment ownership-proof contracts', () => {
    expect('enrollmentPop' in pack.domains).toBe(false)
    expect('recoveryPopTag' in pack.programs[LEDGER_NATIVE_TEMPLATE]).toBe(false)
  })

  it('pins a distinct mainnet Contract Pack with Operator delays', () => {
    expect(mainnetPack.programs['vault-policy-v1'].exit.delay).toBe('605184')
    expect(mainnetPack.programs['vault-board-v1'].exit.delay).toBe('7776256')
    expect(mainnetPack.programs['vault-policy-v1'].delegate.origin).toBe('https://delegate.arkade.money')
    expect(mainnetPack.programs['vault-policy-v1'].delegate.pinnedPublicDelegate).toBe(
      '026d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6',
    )
    expect(pack.programs['vault-policy-v1'].exit.delay).toBe('4608')
    expect(mainnetPack.programs['vault-policy-v1'].policySchema.bounds.absoluteFeeCapSats).toEqual({
      min: 20000,
      max: 20000,
    })
    expect(mainnetPack.programs['vault-policy-v1'].policySchema.bounds.feerateCapSatPerV).toEqual({
      min: 25,
      max: 25,
    })
    expect(pack.programs['vault-policy-v1'].policySchema.bounds.absoluteFeeCapSats).toEqual({ min: 5000, max: 5000 })
  })
})
