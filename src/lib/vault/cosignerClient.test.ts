import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION } from './constants'
import { vaultCosignerClient, type VaultEnrollmentRequest, type VaultSessionAssertion } from './cosignerClient'
import { SAVINGS_TEMPLATE } from './program/constants'
import { CURRENT_SPENDING_POLICY_CAPABILITIES, defaultSpendingPolicy, spendingPolicyDigest } from './spendingPolicy'

const spendingPolicy = defaultSpendingPolicy()
const policyDigest = spendingPolicyDigest(spendingPolicy)

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

const session: VaultSessionAssertion = {
  challengeId: 'challenge-a',
  credentialId: '11'.repeat(16),
  clientDataJSON: '22',
  authenticatorData: '33',
  signature: '44',
  directProof: '55',
}

const enrollment: VaultEnrollmentRequest = {
  protectionTier: 'standard',
  handle: 'handle-a',
  userHandle: 'vault a',
  clientDataJSON: '11',
  authenticatorData: '22',
  attestationObject: '33',
  credentialId: '44',
  webauthnP256: '02' + '55'.repeat(32),
  phoneDirectP256: '02' + '66'.repeat(32),
  phoneBip340Pub: '02' + '77'.repeat(32),
  vaultId: 'vault a',
  externalOwnerWalletXOnly: '88'.repeat(32),
  spendingPolicy,
  spendingPolicyDigest: policyDigest,
}

describe('VaultCosignerClient route compatibility', () => {
  it('sends only the operation identity when checking or releasing a renewal', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: 'confirmed' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const preparedInput = { vaultId: 'wallet', operationId: 'renewal', txid: '11'.repeat(32), vout: 1 }
    await vaultCosignerClient.lightRenewal.status(preparedInput)
    await vaultCosignerClient.lightRenewal.release(preparedInput)
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(JSON.parse(String(init.body))).toEqual({ vaultId: 'wallet', operationId: 'renewal' })
    }
  })

  it('groups the exact existing HTTP API into enrollment, recovery, and Spending capabilities', async () => {
    const operationWire = {
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      state: 'reserved',
      feeSats: 123,
      feePolicyDigest: '33'.repeat(32),
      changeSats: 456,
      changeVout: 1,
      changeScript: `5120${'44'.repeat(32)}`,
    }
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args
      const path = String(input)
      if (path === '/v1/status') {
        return new Response(
          JSON.stringify({
            network: 'mutinynet',
            clientOrigin: 'https://vault.example',
            rpId: 'vault.example',
            templateVersion: SAVINGS_TEMPLATE,
            policyVersion: POLICY_VERSION,
            protectionTier: 'standard',
            enrollmentMode: 'invite',
            spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
          }),
          { status: 200 },
        )
      }
      if (path === '/v1/status?vault=vault%20a') {
        return new Response(
          JSON.stringify({
            enrolled: false,
            network: 'mutinynet',
            clientOrigin: 'https://vault.example',
            rpId: 'vault.example',
            vaultId: 'vault a',
            templateVersion: SAVINGS_TEMPLATE,
            policyVersion: POLICY_VERSION,
            protectionTier: 'standard',
            arkadeCosignerOrigin: 'https://mutinynet.arkade.sh',
            arkadeCosignerVersion: '0.4.65',
            savingsAddress: 'tb1ptest',
            savingsScript: `5120${'aa'.repeat(32)}`,
            passkeyLoginAvailable: false,
            enrollmentMode: 'invite',
            periodAllowance: 100_000,
            periodSpent: 0,
            periodRemaining: 100_000,
            txCap: 50_000,
            absoluteFeeCap: 5_000,
            feerateCapSatVb: 10,
            spendingPolicy,
            spendingPolicyDigest: policyDigest,
            vtxoVaultCosignerPub: `02${'11'.repeat(32)}`,
            vtxoExitDelay: 4608,
            vtxoExitDelayUnit: 'seconds',
            spendingArkAddress: 'tark1spending',
            spendingArkScript: `5120${'22'.repeat(32)}`,
            vtxoDelegatePub: `02${'33'.repeat(32)}`,
            vtxoBoardingActive: true,
            vtxoBoardingProgram: 'vault-board-v1',
            vtxoBoardingAddress: 'tb1pboarding',
            vtxoBoardingScript: `5120${'44'.repeat(32)}`,
            vtxoBoardingExitDelay: 604672,
            vtxoBoardingExitDelayUnit: 'seconds',
          }),
          { status: 200 },
        )
      }
      if (path === '/v1/vtxo/operation?vaultId=vault%20a&operationId=operation%2F1') {
        return new Response(JSON.stringify(operationWire), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await vaultCosignerClient.enrollment.publicStatus()
    await vaultCosignerClient.enrollment.status('vault a')
    await vaultCosignerClient.enrollment.invite('invite-a')
    await vaultCosignerClient.enrollment.start('invite-a', {
      protectionTier: 'standard',
      spendingPolicy,
      spendingPolicyDigest: policyDigest,
    })
    await vaultCosignerClient.enrollment.propose('invite-a', enrollment)
    await vaultCosignerClient.enrollment.finish('invite-a', { ...enrollment, descriptorHash: 'aa'.repeat(32) })
    await vaultCosignerClient.enrollment.binding({
      vaultId: 'vault a',
      envelopeNonce: '11'.repeat(12),
      envelopeCiphertext: '22'.repeat(48),
    })
    await vaultCosignerClient.enrollment.install({
      vaultId: 'vault a',
      envelopeNonce: '11'.repeat(12),
      envelopeCiphertext: '22'.repeat(48),
      binding: '{}',
      bindingDirectSig: '33',
      bindingPhoneSig: '44',
      ...session,
    })
    await vaultCosignerClient.enrollment.recover({ vaultId: 'vault a', ...session })
    await vaultCosignerClient.recovery.challenge({ purpose: 'recover', vaultId: 'vault a' })
    await vaultCosignerClient.recovery.initiate({
      vaultId: 'vault a',
      purpose: 'initiate',
      psbt: 'cHNidP8=',
      ...session,
    })
    await vaultCosignerClient.recovery.clawback({
      vaultId: 'vault a',
      purpose: 'clawback',
      psbt: 'cHNidP8=',
      ...session,
    })
    await vaultCosignerClient.recovery.readMap('vault a')
    await vaultCosignerClient.recovery.writeMap({
      vaultId: 'vault a',
      payload: { name: 'arkade-vault-map' },
      ...session,
    })
    await vaultCosignerClient.spending.reserve({
      vaultId: 'vault a',
      operationId: '11'.repeat(16),
      purpose: 'spend',
      destAddress: 'tark1dest',
      amountSats: 12_000,
      phoneSignature: '22'.repeat(64),
    })
    await vaultCosignerClient.spending.authorize({
      vaultId: 'vault a',
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      unsignedArkPsbt: 'cHNidP8=',
      unsignedCheckpointPsbts: ['cHNidP8='],
      pendingProof: 'cHNidP8=',
      credentialId: session.credentialId,
      clientDataJSON: session.clientDataJSON,
      authenticatorData: session.authenticatorData,
      signature: session.signature,
      directSig: '33'.repeat(64),
    })
    await vaultCosignerClient.spending.authorizeCheckpoints({
      vaultId: 'vault a',
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      checkpointPsbts: ['cHNidP8='],
    })
    await vaultCosignerClient.spending.finalize({
      vaultId: 'vault a',
      operationId: '11'.repeat(16),
      bundleDigest: '22'.repeat(32),
      arkTxid: '33'.repeat(32),
    })
    await expect(vaultCosignerClient.spending.operation('vault a', 'operation/1')).resolves.toEqual(operationWire)

    expect(fetchMock.mock.calls.map(([path, init]) => `${(init as RequestInit).method} ${String(path)}`)).toEqual([
      'GET /v1/status',
      'GET /v1/status?vault=vault%20a',
      'GET /v1/invite',
      'POST /v1/enroll/start',
      'POST /v1/enroll/propose',
      'POST /v1/enroll/finish',
      'POST /v1/passkey/binding',
      'POST /v1/passkey/install',
      'POST /v1/passkey/recover',
      'POST /v1/passkey/challenge',
      'POST /v1/initiate',
      'POST /v1/clawback',
      'GET /v1/map?vault=vault%20a',
      'POST /v1/map',
      'POST /v1/vtxo/reserve',
      'POST /v1/vtxo/authorize',
      'POST /v1/vtxo/checkpoints/authorize',
      'POST /v1/vtxo/finalize',
      'GET /v1/vtxo/operation?vaultId=vault%20a&operationId=operation%2F1',
    ])

    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: { Accept: 'application/json', 'X-Vault-Enrollment-Token': 'invite-a' },
    })
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({ protectionTier: 'standard', spendingPolicy, spendingPolicyDigest: policyDigest }),
      headers: { 'X-Vault-Enrollment-Token': 'invite-a' },
    })
    expect(fetchMock.mock.calls[10]?.[1]).toMatchObject({
      body: JSON.stringify({ vaultId: 'vault a', purpose: 'initiate', psbt: 'cHNidP8=', ...session }),
    })
  })
})
