import { Transaction } from '@arkade-os/sdk'
import { p256 } from '@noble/curves/nist.js'
import { base64, hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import setVector from './testdata/renewal-set-v1.json'
import type { VaultStatus } from '../types'
import { buildLightDescriptor, defaultLightPolicy } from '../light/contract'
import { delegationFixture } from '../light/testdata/delegation'
import { guardianRenewalContext, guardianRenewalContextDigest } from './renewalContext'
import { prepareSpendingDelegation, spendingDelegationAddress, validateSpendingSchedule } from './renewalRequest'
import {
  signSpendingRenewalSet,
  spendingRenewalSetBody,
  spendingRenewalSetDigest,
  validateSpendingRenewalSet,
} from './renewalSet'
import vectors from './testdata/renewal-context-v1.json'

const owner = new Uint8Array(32).fill(1),
  scalar = new Uint8Array(32).fill(7)
const now = Date.UTC(2026, 8, 7)
async function fixture(raw: unknown) {
  const status = structuredClone(raw) as VaultStatus
  status.phoneDirectP256 = hex.encode(p256.getPublicKey(scalar, true))
  const context = guardianRenewalContext(status)
  const descriptor = buildLightDescriptor({
    ...context,
    exitDelaySeconds: status.vtxoExitDelay!,
    spendingPolicy: defaultLightPolicy(context.network),
  })
  const f = delegationFixture(descriptor, now)
  const coin = { ...f.coin, script: context.scriptPubKey }
  const capability = {
    ...f.capability,
    program: context.program,
    descriptorHash: guardianRenewalContextDigest(status),
    maxPlans: 50 as const,
    delegateAddress: spendingDelegationAddress(status),
  }
  const plan = await prepareSpendingDelegation(status, coin, f.info, capability, owner, now, '12'.repeat(16))
  const auth = {
    phoneSecret: owner,
    scalar,
    assertion: {
      credentialId: 'abcd',
      clientDataJSON: '00',
      authenticatorData: '00',
      signature: '00',
    },
  }
  return { status, context, coin, capability, info: f.info, plan, auth }
}

describe('bounded all-program renewal sets using the installed SDK', () => {
  it('verifies the fixed cross-language set signature and digest', () => {
    expect(hex.encode(spendingRenewalSetDigest(setVector.set))).toBe(setVector.digest)
    expect(spendingRenewalSetBody(setVector.set)).toEqual(setVector.body)
    expect(validateSpendingRenewalSet(setVector.set, setVector.status as VaultStatus)).toEqual(setVector.set)
  })
  it.each(vectors)('prepares finite same-script authority for $name', async (vector) => {
    const f = await fixture(vector.status)
    const facts = validateSpendingSchedule(f.plan.request, f.status)
    expect(facts.message.expire_at).toBeGreaterThan(facts.message.valid_at!)
    expect(facts.message.expire_at).toBeLessThanOrEqual(Math.floor(f.coin.expiresAt!.getTime() / 1000) - 60)
    expect(hex.encode(facts.proof.getOutput(0).script!)).toBe(f.context.scriptPubKey)
    expect(facts.receiverSats).toBe(f.coin.value)
    const set = signSpendingRenewalSet(f.status, [f.plan.request], f.auth, '34'.repeat(16))
    expect(validateSpendingRenewalSet(set, f.status)).toBe(set)
    const changed = structuredClone(set)
    changed.plans[0].expiresAt++
    expect(() => validateSpendingRenewalSet(changed, f.status)).toThrow()
    expect(owner.some((b) => b !== 0)).toBe(true)
  })

  it('rejects repeated inputs, cross-program authority, and changed ordered sets', async () => {
    const f = await fixture(vectors[1].status)
    const second = await prepareSpendingDelegation(
      f.status,
      { ...f.coin, txid: '44'.repeat(32) },
      f.info,
      f.capability,
      owner,
      now,
      '56'.repeat(16),
    )
    const set = signSpendingRenewalSet(f.status, [f.plan.request, second.request], f.auth, '78'.repeat(16))
    const reordered = structuredClone(set)
    reordered.plans.reverse()
    expect(() => validateSpendingRenewalSet(reordered, f.status)).toThrow()
    const duplicate = structuredClone(set)
    duplicate.plans = [duplicate.plans[0], duplicate.plans[0]]
    expect(() => validateSpendingRenewalSet(duplicate, f.status)).toThrow(/repeats/)
    const cross = structuredClone(set)
    cross.program = 'vault-light-policy-v1'
    expect(() => validateSpendingRenewalSet(cross, f.status)).toThrow()
    const proof = Transaction.fromPSBT(base64.decode(f.plan.request.intent.proof))
    expect(proof.getInput(1).tapLeafScript).toHaveLength(1)
  })
})
