import { describe, it, expect } from 'vitest'
import { Transaction, type VirtualCoin } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { delegationFixture } from './testdata/delegation'
import vectors from './testdata/contracts.json'
import type { LightDescriptor } from './contract'
import { testOwner } from './testdata/helpers'
import {
  prepareGuardianDelegation,
  validateGuardianSchedule,
  delegationScheduleBody,
  delegationDigest,
} from './delegationRequest'
const now = Date.now()
describe('native Guardian delegation SDK preparation', () => {
  it('binds exact owner authorization to a known output, fee and future bounded window', async () => {
    const { d, coin, info, capability } = delegationFixture()
    const plan = await prepareGuardianDelegation(d, coin, info, capability, testOwner, now, 'aa'.repeat(16))
    expect(plan.txid).toBe(coin.txid)
    expect(plan.receiverSats).toBe(coin.value)
    expect(plan.request.expiresAt).toBeLessThanOrEqual(plan.validAt + 86400)
    expect(JSON.parse(plan.request.intent.message).expire_at).toBe(plan.request.expiresAt)
    expect(JSON.parse(plan.request.deleteIntent.message)).toEqual({ type: 'delete', expire_at: 0 })
    const cleanup = validateGuardianSchedule(plan.request, d).deletion
    expect(cleanup.inputsLength).toBe(2)
    expect(cleanup.getOutput(0)).toMatchObject({ amount: 0n, script: hex.decode('6a') })
    expect(validateGuardianSchedule(plan.request, d).forfeit.inputsLength).toBe(1)
    expect(testOwner.some((x) => x !== 0)).toBe(true)
    expect(() => validateGuardianSchedule({ ...plan.request, expiresAt: plan.request.expiresAt + 1 }, d)).toThrow(
      'authorization changed',
    )
  })
})
it('rejects a different cleanup input even with a freshly valid outer owner signature', async () => {
  const f = delegationFixture()
  const original = await prepareGuardianDelegation(f.d, f.coin, f.info, f.capability, testOwner, now)
  const other = await prepareGuardianDelegation(
    f.d,
    { ...f.coin, txid: 'ff'.repeat(32) },
    f.info,
    f.capability,
    testOwner,
    now,
  )
  const request = { ...original.request, deleteIntent: other.request.deleteIntent }
  request.ownerSignature = hex.encode(
    schnorr.sign(delegationDigest('schedule', delegationScheduleBody(request)), testOwner),
  )
  expect(() => validateGuardianSchedule(request, f.d)).toThrow('cleanup input changed')
  const monetary = Transaction.fromPSBT(base64.decode(original.request.deleteIntent.proof))
  monetary.updateOutput(0, { amount: 1n }, true)
  request.deleteIntent = { ...original.request.deleteIntent, proof: base64.encode(monetary.toPSBT()) }
  request.ownerSignature = hex.encode(
    schnorr.sign(delegationDigest('schedule', delegationScheduleBody(request)), testOwner),
  )
  expect(() => validateGuardianSchedule(request, f.d)).toThrow('cleanup authorization changed')
})

for (const vector of vectors) {
  it(`accepts committed preconfirmed change on ${vector.descriptor.network}`, async () => {
    const { d, coin, info, capability } = delegationFixture(vector.descriptor as LightDescriptor)
    coin.isPreconfirmed = true
    const plan = await prepareGuardianDelegation(d, coin, info, capability, testOwner, now)
    expect(validateGuardianSchedule(plan.request, d).txid).toBe(coin.txid)
  })
}
it('rejects genuinely uncommitted outputs, unknown expiry, terminal spends and assets', async () => {
  for (const patch of [
    { commitmentTxIds: [] },
    { expiresAt: undefined },
    { isSpent: true },
    { isSwept: true },
    { isUnrolled: true },
    { assets: [{ assetId: 'aa', amount: 1 }] },
  ]) {
    const f = delegationFixture()
    await expect(
      prepareGuardianDelegation(f.d, { ...f.coin, ...patch } as VirtualCoin, f.info, f.capability, testOwner, now),
    ).rejects.toThrow('cannot yet be delegated')
  }
})
it('refuses the pinned SDK output fee omission before a schedule can be submitted', async () => {
  const f = delegationFixture()
  f.info.fees.intentFee.offchainInput = '100.0'
  f.info.fees.intentFee.offchainOutput = '50.0'
  await expect(prepareGuardianDelegation(f.d, f.coin, f.info, f.capability, testOwner, now)).rejects.toThrow(
    'does not cover the Operator fee',
  )
  f.info.fees.intentFee.offchainOutput = '0.0'
  const plan = await prepareGuardianDelegation(f.d, f.coin, f.info, f.capability, testOwner, now)
  expect(plan.valueSats - plan.receiverSats).toBe(100)
})
it('rejects changed delegate authority, destination, rate cap and expired scheduling window', async () => {
  const f = delegationFixture()
  await expect(
    prepareGuardianDelegation(f.d, f.coin, f.info, { ...f.capability, pubkey: '02' + '00'.repeat(32) }, testOwner, now),
  ).rejects.toThrow('capability')
  await expect(
    prepareGuardianDelegation(f.d, f.coin, f.info, { ...f.capability, delegateAddress: 'other' }, testOwner, now),
  ).rejects.toThrow('capability')
  await expect(
    prepareGuardianDelegation(
      f.d,
      f.coin,
      { ...f.info, fees: { ...f.info.fees, txFeeRate: '99999' } },
      f.capability,
      testOwner,
      now,
    ),
  ).rejects.toThrow('fees exceed')
  await expect(
    prepareGuardianDelegation(
      f.d,
      { ...f.coin, expiresAt: new Date(now + 1000) },
      f.info,
      f.capability,
      testOwner,
      now,
    ),
  ).rejects.toThrow('cannot yet')
})
