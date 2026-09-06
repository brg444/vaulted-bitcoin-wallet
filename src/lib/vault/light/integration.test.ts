import { getNetwork } from '@arkade-os/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { isVaultBitcoinAddress } from '../bitcoin'
import { requireStatusIdentity } from '../status'
import { spendingScriptFromStatus, vaultPolicyV1ScriptFromStatus } from '../vtxo/spend'
import { bindStatusToLocalPin } from '../pin'
import { lightStatusMatchesDescriptor, requireLightStatus } from './status'
import { lightObserverIdentity, storeLightWorkerDescriptor, loadLightWorkerDescriptor } from './workerIdentity'
import { vaultWalletNamespace } from '../vtxo/walletWorkerNames'
import { LightContractHandler } from './contractHandler'
import { LightScript, buildLightDescriptor } from './contract'
import {
  LIGHT_STAGE_STORE,
  LightEnrollmentExpiredError,
  clearExpiredLightEnrollment,
  finishLightEnrollment,
  type PendingLightEnrollment,
  loadPendingLightEnrollment,
  validateLightEnrollment,
  verifyLightRecoverySecret,
  verifySavedLightRecoveryFile,
} from './enrollment'
import { validateWatchedSavingsAddress, saveWatchedSavings, loadWatchedSavings } from './watchSavings'
import { lightTestEnrollment, lightTestStatus, testDescriptor, testSecret } from './testdata/helpers'
import 'fake-indexeddb/auto'

beforeEach(() => localStorage.clear())
describe('Light integrated identity boundaries', () => {
  it('reconstructs its receiving script while legacy pinning and Savings contracts reject it', () => {
    const wire = lightTestStatus()
    const st = requireStatusIdentity(wire, wire.vaultId)
    expect(st.lightDescriptor).toEqual(testDescriptor)
    expect(hex.encode(spendingScriptFromStatus(st).pkScript)).toBe(testDescriptor.scriptPubKey)
    expect(() => vaultPolicyV1ScriptFromStatus(st)).toThrow('Light')
    expect(() => bindStatusToLocalPin(st)).toThrow()
  })
  it.each([
    { protectionTier: 'standard' },
    { templateVersion: 'arkade-vault-v1' },
    { policyVersion: 'v1' },
    { savingsAddress: 'tb1pother' },
    { externalOwnerWalletPub: `02${'11'.repeat(32)}` },
    { vtxoDelegatePub: `02${'22'.repeat(32)}` },
    { periodRemaining: 1 },
    { periodSpent: -1 },
    { txCap: 99999 },
    { vtxoExitDelay: 2048 },
    { lightDescriptorHash: '00'.repeat(32) },
    { spendingArkScript: '5120' + '11'.repeat(32) },
    { phoneBip340Pub: `03${testDescriptor.ownerPub}` },
  ])('rejects substituted status %j', (patch) => {
    expect(() => requireLightStatus({ ...lightTestStatus(), ...patch } as never)).toThrow()
  })
  it('requires the saved descriptor, not just a valid server descriptor', () => {
    const other = buildLightDescriptor({ ...testDescriptor, vaultId: 'bb'.repeat(32) })
    expect(() => lightStatusMatchesDescriptor(lightTestStatus() as never, other)).toThrow('changed')
  })
  it('worker identity cannot sign and public storage survives a reload', async () => {
    const identity = lightObserverIdentity(testDescriptor)
    expect(hex.encode(await identity.xOnlyPublicKey())).toBe(testDescriptor.ownerPub)
    expect(() => identity.sign({} as never)).toThrow('foreground')
    expect(() => identity.signMessage(new Uint8Array(), 'schnorr')).toThrow('foreground')
    expect(() => identity.signerSession()).toThrow('foreground')
    await storeLightWorkerDescriptor(testDescriptor)
    expect(await loadLightWorkerDescriptor(vaultWalletNamespace(testDescriptor.vaultId))).toEqual(testDescriptor)
    expect(await loadLightWorkerDescriptor('ff'.repeat(16))).toBeNull()
  })
  it('enumerates only owner emergency exit when cooperation is explicitly unavailable', () => {
    const script = new LightScript(testDescriptor)
    const context = { collaborative: false, currentTime: 0, walletPubKey: testDescriptor.ownerPub }
    expect(LightContractHandler.getAllSpendingPaths(script, {} as never, context)).toEqual([
      { leaf: script.exit(), sequence: (1 << 22) + 4608 / 512 },
    ])
    expect(LightContractHandler.getAllSpendingPaths(script, {} as never, { ...context, collaborative: true })).toEqual(
      [],
    )
    expect(
      LightContractHandler.getAllSpendingPaths(script, {} as never, {
        ...context,
        walletPubKey: testDescriptor.cosignerPub,
      }),
    ).toEqual([])
    expect(LightContractHandler.getSpendablePaths(script, {} as never, context)).toEqual([])
  })
})
describe('Light backup and watch-only Savings', () => {
  it('verifies the saved file and secret independently and excludes admission fields', async () => {
    const enrollment = await lightTestEnrollment()
    const valid = verifySavedLightRecoveryFile({ ...enrollment, token: 'secret-admission-token' }, enrollment)
    expect(JSON.stringify(valid)).not.toContain('secret-admission-token')
    const nested = validateLightEnrollment({
      ...enrollment,
      enrollment: { ...enrollment.enrollment, unexpectedSecret: 'never-export' },
    })
    expect(JSON.stringify(nested)).not.toContain('never-export')
    expect(() =>
      validateLightEnrollment({
        ...enrollment,
        enrollment: { ...enrollment.enrollment, webauthnP256: `02${'ff'.repeat(32)}` },
      }),
    ).toThrow('invalid')
    await expect(verifyLightRecoverySecret(enrollment, hex.encode(testSecret))).resolves.toBeUndefined()
    await expect(verifyLightRecoverySecret(enrollment, '09'.repeat(32))).rejects.toThrow()
    const other = await lightTestEnrollment()
    expect(() => verifySavedLightRecoveryFile(other, enrollment)).toThrow('this setup')
    expect(() =>
      validateLightEnrollment({ ...enrollment, enrollment: { ...enrollment.enrollment, vaultId: 'bb'.repeat(32) } }),
    ).toThrow()
  })
  it('resumes pending setup with encrypted material and the same descriptor', async () => {
    const enrollment = await lightTestEnrollment()
    const pending = {
      ...enrollment,
      token: 'one-use',
      request: { vaultId: testDescriptor.vaultId, descriptorHash: lightTestStatus().lightDescriptorHash },
    }
    localStorage.setItem(LIGHT_STAGE_STORE, JSON.stringify(pending))
    expect(loadPendingLightEnrollment()?.descriptor).toEqual(testDescriptor)
    pending.request.descriptorHash = '00'.repeat(32)
    localStorage.setItem(LIGHT_STAGE_STORE, JSON.stringify(pending))
    expect(() => loadPendingLightEnrollment()).toThrow()
  })
  it('accepts only an address on the selected network and stores it separately from the Light descriptor', () => {
    const address = new LightScript(testDescriptor).onchainAddress(getNetwork('mutinynet'))
    expect(isVaultBitcoinAddress(address, 'mutinynet')).toBe(true)
    const watched = { address, network: 'mutinynet' as const, label: 'My savings' }
    saveWatchedSavings(testDescriptor.vaultId, watched, 'mutinynet')
    expect(loadWatchedSavings(testDescriptor.vaultId, 'mutinynet')).toEqual(watched)
    expect(() => validateWatchedSavingsAddress(watched, 'mainnet')).toThrow()
    expect(() => validateWatchedSavingsAddress({ ...watched, address: 'xprv123' }, 'mutinynet')).toThrow()
    expect(testDescriptor).not.toHaveProperty('savingsAddress')
  })
})

describe('Light enrollment expiry recovery', () => {
  it('preserves the saved setup on failed requests and requires an explicit reset after confirmed expiry', async () => {
    const record = await lightTestEnrollment()
    const pending = {
      ...record,
      token: 'one-use',
      request: { vaultId: record.descriptor.vaultId },
    } as PendingLightEnrollment
    localStorage.setItem(LIGHT_STAGE_STORE, JSON.stringify(pending))
    try {
      for (const response of [
        new Response('unavailable', { status: 503 }),
        new Response('{"error":"rejected"}', { status: 400 }),
      ]) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => response),
        )
        await expect(finishLightEnrollment(pending, hex.encode(testSecret))).rejects.not.toBeInstanceOf(
          LightEnrollmentExpiredError,
        )
        expect(localStorage.getItem(LIGHT_STAGE_STORE)).not.toBeNull()
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'light_enrollment_expired' }, { status: 410 })),
      )
      await expect(finishLightEnrollment(pending, hex.encode(testSecret))).rejects.toBeInstanceOf(
        LightEnrollmentExpiredError,
      )
      expect(localStorage.getItem(LIGHT_STAGE_STORE)).not.toBeNull()
      clearExpiredLightEnrollment()
      expect(localStorage.getItem(LIGHT_STAGE_STORE)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
