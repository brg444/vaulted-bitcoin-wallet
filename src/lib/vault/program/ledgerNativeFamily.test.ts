import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../spendingPolicy'
import { buildLedgerNativeFamily } from './ledgerNativeFamily'
import {
  ledgerAccountKey,
  ledgerRecoveryChild,
  ledgerRecoveryInternalParent,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'
import vectors from './ledger-family-vectors.json'
import { PROGRAM_CSV } from './constants'

describe('complete Ledger native recovery family', () => {
  for (const vector of vectors) {
    const context = vector.input as LedgerSavingsKeyContext
    it(`reconstructs ${context.network} ${context.recovery ? 'advanced' : 'standard'} with unchanged recovery rights`, () => {
      const family = buildLedgerNativeFamily(context, defaultSpendingPolicy(context.network))
      expect(family.receive.address).not.toBe(family.change.address)
      expect(family.walletPolicy).toEqual(vector.walletPolicy)
      for (const [actual, expected] of [
        [family.receive, vector.receive],
        [family.change, vector.change],
      ] as const) {
        expect(actual.address).toBe(expected.address)
        expect(hex.encode(actual.script)).toBe(expected.script)
        expect([actual.admin, ...actual.initiate].map((script) => hex.encode(script))).toEqual(expected.scripts)
      }
      expect(Object.keys(family.recovery)).toEqual(
        context.recovery ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware'],
      )
      for (const recovery of Object.values(family.recovery)) {
        const expected = vector.recovery[recovery.claimant as keyof typeof vector.recovery]!
        expect(hex.encode(recovery.initiateProgram)).toBe(expected.initiateProgram)
        expect(hex.encode(recovery.clawbackProgram)).toBe(expected.clawbackProgram)
        for (const [actual, want] of [
          [recovery.pending, expected.pending],
          [recovery.quarantine, expected.quarantine],
        ] as const) {
          expect(actual.address).toBe(want.address)
          expect(hex.encode(actual.script)).toBe(want.script)
          expect(actual.walletPolicy).toEqual(want.walletPolicy)
        }
        expect(
          [recovery.pending.claim, ...recovery.pending.clawbacks, recovery.pending.cancel].map((s) => hex.encode(s)),
        ).toEqual(expected.pending.scripts)
        expect(hex.encode(recovery.quarantine.admin)).toBe(expected.quarantine.scripts[0])
        expect(recovery.delay).toBe(PROGRAM_CSV[recovery.claimant])
        expect(recovery.guardians).not.toContain(recovery.claimant)
        expect(recovery.pending.tapLeafScript).toHaveLength(context.recovery ? 4 : 3)
        expect(recovery.quarantine.tapLeafScript).toHaveLength(1)
        expect(recovery.pending.clawbacks).toHaveLength(context.recovery ? 2 : 1)
        expect(recovery.pending.cancel.length).toBe(recovery.guardians.length * 34)
        const claimant = ledgerRecoveryChild(ledgerAccountKey(context[recovery.claimant]!, context.network), 'claim')
        expect(hex.encode(recovery.pending.claim)).toContain(hex.encode(claimant.publicKey!.slice(1)))
        expect(recovery.pending.claim.at(-1)).toBe(0xb2)
        expect(recovery.pending.walletPolicy.descriptorTemplate).toContain(`older(${recovery.delay})`)
        expect(recovery.quarantine.walletPolicy.keysInfo).toHaveLength(recovery.guardians.length + 1)
        expect(recovery.pending.walletPolicy.keysInfo).toHaveLength(context.recovery ? 6 : 5)
        expect(hex.encode(recovery.initiateProgram)).toContain(hex.encode(recovery.pending.script.slice(2)))
        expect(hex.encode(recovery.clawbackProgram)).toContain(hex.encode(recovery.quarantine.script.slice(2)))
        // Normal payments have no transition packet, reserve or anchor. These
        // programs belong only to the explicitly initiated recovery flow.
        expect(family.programs[recovery.claimant]).toBe(hex.encode(recovery.initiateProgram))
      }
    })
  }
  const context = vectors[0].input as LedgerSavingsKeyContext
  it('rejects a policy from a different network or a changed enrollment', () => {
    const policy = defaultSpendingPolicy(context.network)
    expect(() => buildLedgerNativeFamily(context, defaultSpendingPolicy('mainnet'))).toThrow()
    expect(() => buildLedgerNativeFamily({ ...context, policyDigest: '00'.repeat(32) }, policy)).toThrow()
    const updated = { ...policy, txRecipientCapSats: policy.txRecipientCapSats - 1 }
    const rebound = { ...context, policyDigest: spendingPolicyDigest(updated, context.network) }
    expect(buildLedgerNativeFamily(rebound, updated).receive.address).not.toBe(
      buildLedgerNativeFamily(context, policy).receive.address,
    )
  })
  it('separates recovery stages, claimants and user branches', () => {
    const keys = ['phone', 'hardware'].flatMap((claimant) =>
      ['pending', 'quarantine'].map(
        (stage) =>
          ledgerRecoveryInternalParent(context, claimant as 'phone' | 'hardware', stage as 'pending' | 'quarantine')
            .publicExtendedKey,
      ),
    )
    expect(new Set(keys).size).toBe(4)
    const account = ledgerAccountKey(context.hardware, context.network)
    const children = (['claim', 'clawback', 'cancel', 'quarantine'] as const).map((role) =>
      hex.encode(ledgerRecoveryChild(account, role).publicKey!),
    )
    expect(new Set(children).size).toBe(4)
    expect(() => ledgerRecoveryChild(account, 'unknown' as 'claim')).toThrow()
    expect(() => ledgerRecoveryInternalParent(context, 'recovery', 'pending')).toThrow()
  })
})
