import { bech32 } from '@scure/base'
import { validateLightningAddress, LNURL_ORIGIN } from './lnurl'
import { parseStatusJson } from './status'
import { describe, expect, it } from 'vitest'
import vector from './vtxo/testdata/shared-spending-enrollment.json'
import {
  requireSpendingEnrollmentStatus,
  spendingEnrollmentHash,
  validateSpendingEnrollment,
} from './spendingEnrollment'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'
import { vaultPolicyV1ScriptFromStatus } from './vtxo/spend'
import { pinFromEnrolledStatus, requireStatusMatchesPin } from './pin'
import { buildRecoveryKit, inspectRecoveryKit, parseRecoveryKit } from './program/kit'
import { buildSpendingRecoveryDescriptor } from './program/spendingRecoveryDescriptor'

describe('fresh Light shared Spending contract', () => {
  it('matches the Go enrollment hash, Spending script and boarding address', () => {
    const status = sharedSpendingStatus()
    expect(spendingEnrollmentHash(vector.descriptor)).toBe(vector.hash)
    expect(requireSpendingEnrollmentStatus(status)).toEqual(vector.descriptor)
    expect(vaultPolicyV1ScriptFromStatus(status).params.exitMode).toBe('device')
    expect(requireStatusMatchesPin(status, pinFromEnrolledStatus(status))).toEqual(status)
    const kit = buildRecoveryKit(buildSpendingRecoveryDescriptor(vector.descriptor))
    expect(parseRecoveryKit(JSON.parse(JSON.stringify(kit)))).toEqual(kit)
    expect(inspectRecoveryKit(kit).trees.map((tree) => tree.role)).toEqual(['spending', 'boarding'])
  })
  it('accepts the runtime wire status with omitted Savings fields through the common status reader', () => {
    const status = sharedSpendingStatus()
    const wire = { ...status, savingsAddress: undefined, savingsScript: undefined }
    const parsed = parseStatusJson(JSON.stringify(wire), status.vaultId)
    expect(parsed.savingsAddress).toBe('')
    expect(parsed.savingsScript).toBe('')
    expect(requireStatusMatchesPin(parsed, pinFromEnrolledStatus(parsed))).toEqual(parsed)
    expect(() => parseStatusJson(JSON.stringify({ ...wire, spendingDescriptor: undefined }), status.vaultId)).toThrow()
    expect(() => parseStatusJson(JSON.stringify({ ...wire, templateVersion: 'savings-v1' }), status.vaultId)).toThrow()
  })
  it.each([
    'exitMode',
    'exitDelay',
    'phonePub',
    'cosignerPub',
    'operatorPub',
    'delegatePub',
    'script',
    'address',
    'protectionTier',
    'phoneDirectP256',
  ])('rejects changed %s', (field) => {
    const changed = { ...vector.descriptor, [field]: 'changed' }
    expect(() => validateSpendingEnrollment(changed)).toThrow()
  })
  it('rejects absent mode, injected hardware, changed policy and changed boarding', () => {
    const withoutMode = Object.fromEntries(Object.entries(vector.descriptor).filter(([key]) => key !== 'exitMode'))
    expect(() => validateSpendingEnrollment(withoutMode)).toThrow()
    expect(() =>
      validateSpendingEnrollment({ ...vector.descriptor, hardwarePub: vector.descriptor.phonePub }),
    ).toThrow()
    expect(() =>
      validateSpendingEnrollment({
        ...vector.descriptor,
        spendingPolicy: { ...vector.descriptor.spendingPolicy, txRecipientCapSats: 1000 },
      }),
    ).toThrow()
    expect(() =>
      validateSpendingEnrollment({
        ...vector.descriptor,
        boarding: { ...vector.descriptor.boarding, recoveryPhonePub: vector.descriptor.cosignerPub },
      }),
    ).toThrow()
  })
  it('binds a Lightning address to the full shared Spending enrollment', () => {
    const status = sharedSpendingStatus()
    const name = 'alex'
    const address = {
      id: 'v1212121212121212',
      name,
      address: `${name}@ln.getvaulted.xyz`,
      active: true,
      readToken: 'ab'.repeat(32),
      maxFeeSats: 25,
      lnurl: bech32
        .encode('lnurl', bech32.toWords(new TextEncoder().encode(`${LNURL_ORIGIN}/.well-known/lnurlp/${name}`)), 1023)
        .toUpperCase(),
      binding: {
        vaultId: status.vaultId,
        network: status.network,
        templateVersion: status.templateVersion,
        protectionTier: status.protectionTier,
        policyVersion: status.policyVersion,
        descriptorHash: vector.hash,
        spendingPolicyDigest: status.spendingPolicyDigest,
        spendingAddress: status.spendingArkAddress,
        spendingScript: status.spendingArkScript,
        claimPublicKey: status.phoneBip340Pub,
      },
    } as Parameters<typeof validateLightningAddress>[0]
    expect(validateLightningAddress(address, status)).toEqual(address)
    for (const descriptorHash of [undefined, '00'.repeat(32)])
      expect(() =>
        validateLightningAddress(
          { ...address, binding: { ...address.binding, descriptorHash } } as typeof address,
          status,
        ),
      ).toThrow()
    expect(() => validateLightningAddress(address, { ...status, spendingDescriptor: undefined })).toThrow()
  })
  it('does not admit Savings or a substituted status binding', () => {
    const status = sharedSpendingStatus()
    for (const changed of [
      { ...status, savingsAddress: status.vtxoBoardingAddress! },
      { ...status, externalOwnerWalletPub: status.phoneBip340Pub },
      { ...status, vtxoBoardingDescriptorHash: '00'.repeat(32) },
    ])
      expect(() => requireSpendingEnrollmentStatus(changed)).toThrow()
  })
})
