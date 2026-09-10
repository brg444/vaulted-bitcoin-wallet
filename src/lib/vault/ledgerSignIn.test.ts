import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ledgerRecoveryFixture, ledgerFixturePRF } from './recovery/testdata/ledger'
import { bindingFor } from '../../test/ledgerAccessFixture'
import { recoveryBindingDigest, ledgerAccessBackup } from './passkeyBinding'
import { deriveDirectP256, signDirectP256 } from './ceremony/directauth'
import { scalarSecret } from './program/fixtures'
import { signInWithPasskey, enablePasskeyLogin } from './signIn'

const api = vi.hoisted(() => ({
  status: vi.fn(),
  challenge: vi.fn(),
  recover: vi.fn(),
  binding: vi.fn(),
  install: vi.fn(),
  provision: vi.fn(),
}))
vi.mock('./cosignerClient', () => ({
  vaultCosignerClient: {
    enrollment: { status: api.status, recover: api.recover, binding: api.binding, install: api.install },
    recovery: { challenge: api.challenge },
  },
}))
vi.mock('./vtxo/board', async (original) => ({
  ...(await original<typeof import('./vtxo/board')>()),
  provisionBoardingKey: api.provision,
}))
beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function setup(advanced = false) {
  const fixture = await ledgerRecoveryFixture(advanced)
  const { status, enrollment } = fixture
  Object.assign(status, { clientOrigin: location.origin, rpId: location.hostname, passkeyLoginAvailable: true })
  const binding = bindingFor(enrollment, status)
  const digest = recoveryBindingDigest(binding)
  const direct = await deriveDirectP256(ledgerFixturePRF)
  const recovered = {
    binding,
    bindingDigest: hex.encode(digest),
    bindingDirectSig: hex.encode(signDirectP256(direct.scalar, digest)),
    bindingPhoneSig: hex.encode(schnorr.sign(digest, scalarSecret(3))),
    envelopeNonce: enrollment.nonce,
    envelopeCiphertext: enrollment.ciphertext,
    ledgerSavings: ledgerAccessBackup(enrollment),
  }
  direct.scalar.fill(0)
  api.status.mockResolvedValue(status)
  api.challenge.mockResolvedValue({
    challengeId: '12'.repeat(16),
    challenge: 'cd'.repeat(32),
    allowCredentialId: enrollment.credId,
  })
  api.recover.mockResolvedValue(recovered)
  api.binding.mockResolvedValue({ binding, bindingDigest: recovered.bindingDigest })
  api.install.mockResolvedValue({ ok: true })
  const get = vi.fn(async () => ({
    rawId: hex.decode(enrollment.credId).buffer,
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
    },
    getClientExtensionResults: () => ({ prf: { results: { first: ledgerFixturePRF.slice().buffer } } }),
  }))
  vi.stubGlobal('navigator', { credentials: { get } })
  return { ...fixture, recovered, get }
}

it.each([false, true])(
  'installs and recovers the complete Ledger enrollment through signed v6 access (advanced=%s)',
  async (advanced) => {
    const { enrollment, status, get } = await setup(advanced)
    await enablePasskeyLogin(enrollment)
    expect(api.install).toHaveBeenCalledOnce()
    expect(api.install.mock.calls[0][0].ledgerSavings).toEqual(ledgerAccessBackup(enrollment))
    let retainedPhone: Uint8Array | undefined
    const sync = vi.fn(async (_status, auth, canAuthorizeNew, restored) => {
      expect(canAuthorizeNew).toBe(false)
      expect(restored.ledgerSavings).toEqual(enrollment.ledgerSavings)
      expect(auth.phoneSecret).toEqual(scalarSecret(3))
      retainedPhone = auth.phoneSecret
    })
    const result = await signInWithPasskey(status.vaultId, sync)
    expect(result.enrollment).toEqual(enrollment)
    expect(api.provision).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledOnce()
    expect(retainedPhone!.every((byte) => byte === 0)).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
  },
  60000,
)

it('rejects a stripped or changed Ledger backup before restoring Spending or invoking the session callback', async () => {
  const { status, recovered } = await setup()
  const sync = vi.fn()
  for (const ledgerSavings of [
    undefined,
    {
      ...recovered.ledgerSavings!,
      phoneSeedBackup: { ...recovered.ledgerSavings!.phoneSeedBackup, ciphertext: '00'.repeat(48) },
    },
  ]) {
    api.recover.mockResolvedValue({ ...recovered, ledgerSavings })
    await expect(signInWithPasskey(status.vaultId, sync)).rejects.toThrow(/Ledger backup/)
  }
  expect(api.provision).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
}, 60000)
