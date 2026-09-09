// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { WalletPolicy } from '@ledgerhq/ledger-bitcoin'
import { ledgerWalletPolicyId, validateLedgerSavingsContract, ledgerRecoveryFamily } from './ledgerEnrollment'
import { buildLedgerNativeFamily } from './ledgerNativeFamily'
import type { LedgerSavingsKeyContext } from './ledgerNativeKeys'
import { defaultSpendingPolicy } from '../spendingPolicy'
import vectors from './ledger-key-vectors.json'
import enrollmentVectors from './ledger-enrollment-vectors.json'
import { hashLedgerSavingsEnrollment, type LedgerSavingsEnrollmentDescriptor } from './ledgerRecoveryDescriptor'

describe('portable Ledger registration binding', () => {
  it('matches the official policy ID for every complete Savings, pending and quarantine tree', () => {
    for (const vector of vectors) {
      const context = vector.input as LedgerSavingsKeyContext
      const family = buildLedgerNativeFamily(context, defaultSpendingPolicy(context.network))
      const policies = [
        family.walletPolicy,
        ...Object.values(family.recovery).flatMap((r) => [r.pending.walletPolicy, r.quarantine.walletPolicy]),
      ]
      for (const p of policies)
        expect(ledgerWalletPolicyId(p)).toBe(
          new WalletPolicy(p.name, p.descriptorTemplate, p.keysInfo).getId().toString('hex'),
        )
      const contract = { context, spendingPolicy: defaultSpendingPolicy(context.network) }
      expect(validateLedgerSavingsContract(contract)).toEqual(contract)
      expect(() => validateLedgerSavingsContract({ ...contract, context: { ...context, extra: 1 } })).toThrow()
    }
  }, 20000)
  it('uses the complete contract as a bounded public cache key and returns independent copies', () => {
    const a = enrollmentVectors[0].descriptor.savings as Parameters<typeof ledgerRecoveryFamily>[0]
    const expected = ledgerRecoveryFamily(a)
    const original = expected.receive.script.slice()
    expected.receive.script.fill(0)
    expected.walletPolicy.keysInfo[1] = 'changed'
    expect(ledgerRecoveryFamily(a).receive.script).toEqual(original)
    expect(ledgerRecoveryFamily(a).walletPolicy.keysInfo[1]).not.toBe('changed')
    const changed = structuredClone(a)
    changed.context.hardware = structuredClone(enrollmentVectors[1].descriptor.savings.context.recovery!)
    expect(ledgerRecoveryFamily(changed).receive.address).not.toBe(ledgerRecoveryFamily(a).receive.address)
    expect(ledgerRecoveryFamily(a).receive.script).toEqual(original)
    expect(() => validateLedgerSavingsContract({ ...a, extra: true })).toThrow()
  })
  it('matches the shared runtime enrollment encoding for both networks and tiers', () => {
    for (const v of enrollmentVectors)
      expect(hashLedgerSavingsEnrollment(v.descriptor as LedgerSavingsEnrollmentDescriptor)).toBe(v.descriptorHash)
  })
})
