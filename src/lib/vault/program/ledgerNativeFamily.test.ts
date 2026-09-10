import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../spendingPolicy'
import { buildLedgerNativeFamily } from './ledgerNativeFamily'
import {
  ledgerAccountKey,
  ledgerBip32Versions,
  ledgerRecoveryChild,
  ledgerRecoveryInternalParent,
  ledgerSavingsChild,
  ledgerSavingsGuardianParent,
  ledgerGuardianInitiateChild,
  ledgerGuardianClawbackChild,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'
import vectors from './ledger-family-vectors.json'
import { PROGRAM_CSV, familyClaimants } from './constants'
import { checksigScript } from '../savingsTree'
import { scalarSecret } from './fixtures'
import { tapLeafForScript } from './spend'

describe('complete Ledger native recovery family', () => {
  for (const vector of vectors) {
    const context = vector.input as LedgerSavingsKeyContext
    it(`reconstructs ${context.network} ${context.recovery ? 'advanced' : 'standard'} with Guardian recovery authority`, () => {
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
      expect(family).not.toHaveProperty('programs')
      expect(family.walletPolicy.keysInfo).toHaveLength(context.recovery ? 5 : 4)
      const guardianParent = ledgerSavingsGuardianParent(context)
      for (const [change, normal] of [
        [0, family.receive],
        [1, family.change],
      ] as const) {
        expect(normal.admin).toEqual(
          checksigScript(
            ['phone', 'hardware'].map((role) =>
              ledgerSavingsChild(
                ledgerAccountKey(context[role as 'phone' | 'hardware'], context.network),
                change,
              ).publicKey!.slice(1),
            ),
          ),
        )
        normal.initiate.forEach((script, i) => {
          const claimant = familyClaimants(Boolean(context.recovery))[i]
          const account = ledgerAccountKey(context[claimant]!, context.network)
          const user = ledgerSavingsChild(account, claimant === 'recovery' ? change : 2 + change)
          const guardian = ledgerGuardianInitiateChild(context, guardianParent, claimant, change)
          expect(script).toEqual(checksigScript([user.publicKey!.slice(1), guardian.publicKey!.slice(1)]))
          expect(script.length).toBe(68)
        })
      }
      expect(Object.keys(family.recovery)).toEqual(
        context.recovery ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware'],
      )
      for (const recovery of Object.values(family.recovery)) {
        const expected = vector.recovery[recovery.claimant as keyof typeof vector.recovery]!
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
        expect(recovery.pending.walletPolicy.keysInfo).toHaveLength(context.recovery ? 5 : 4)
        expect(recovery).not.toHaveProperty('initiateProgram')
        expect(recovery).not.toHaveProperty('clawbackProgram')
        const guardianParent = ledgerSavingsGuardianParent(context)
        recovery.pending.clawbacks.forEach((script, index) => {
          const guardian = recovery.guardians[index]
          expect(script).toEqual(
            checksigScript([
              ledgerRecoveryChild(ledgerAccountKey(context[guardian]!, context.network), 'clawback').publicKey!.slice(
                1,
              ),
              ledgerGuardianClawbackChild(context, guardianParent, recovery.claimant, guardian).publicKey!.slice(1),
            ]),
          )
          expect(script.length).toBe(68)
        })
        expect(recovery.pending.cancel).toEqual(
          checksigScript(
            recovery.guardians.map((guardian) =>
              ledgerRecoveryChild(ledgerAccountKey(context[guardian]!, context.network), 'cancel').publicKey!.slice(1),
            ),
          ),
        )
        expect(recovery.quarantine.admin).toEqual(
          checksigScript(
            recovery.guardians.map((guardian) =>
              ledgerRecoveryChild(ledgerAccountKey(context[guardian]!, context.network), 'quarantine').publicKey!.slice(
                1,
              ),
            ),
          ),
        )
      }
    })
  }
  for (const vector of vectors) {
    const context = vector.input as LedgerSavingsKeyContext
    it(`requires a user and permits phone-plus-Guardian destination choice on ${context.network} ${context.recovery ? 'advanced' : 'standard'}`, () => {
      const family = buildLedgerNativeFamily(context, defaultSpendingPolicy(context.network))
      const versions = ledgerBip32Versions(context.network)
      const phone = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x43), versions).derive(
        `m/86'/${context.network === 'mainnet' ? 0 : 1}'/0'`,
      )
      const guardian = new HDKey({
        privateKey: scalarSecret(14),
        chainCode: ledgerSavingsGuardianParent(context).chainCode!,
        versions,
      })
      // This destination deliberately bypasses the pending output. Bitcoin
      // authority permits it when both user and Guardian keys are compromised;
      // the honest Guardian's destination check belongs to the runtime.
      const destination = family.recovery.phone!.quarantine.script
      expect(destination).not.toEqual(family.recovery.phone!.pending.script)
      for (const [change, tree] of [
        [0, family.receive],
        [1, family.change],
      ] as const) {
        const build = () => {
          const tx = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
          tx.addInput({
            txid: '11'.repeat(32),
            index: 0,
            sequence: 0xfffffffd,
            witnessUtxo: { script: tree.script, amount: 100000n },
            tapInternalKey: tree.tapInternalKey,
            tapLeafScript: [tapLeafForScript(tree.tapLeafScript, tree.initiate[0])],
          })
          tx.addOutput({ script: destination, amount: 99000n })
          return tx
        }
        const guardianSecret = ledgerGuardianInitiateChild(context, guardian, 'phone', change).privateKey!
        const alone = build()
        alone.signIdx(guardianSecret, 0)
        expect(() => alone.finalize()).toThrow()
        const both = build()
        both.signIdx(ledgerSavingsChild(phone, 2 + change).privateKey!, 0)
        both.signIdx(guardianSecret, 0)
        both.finalize()
        expect(both.extract().length).toBeGreaterThan(0)
        expect(both.getInput(0).finalScriptWitness).toHaveLength(4)
        expect(both.outputsLength).toBe(1)
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
