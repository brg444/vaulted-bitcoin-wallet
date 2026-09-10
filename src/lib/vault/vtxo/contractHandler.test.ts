import { SingleKey } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { networkPins } from '../networkPins'
import {
  VaultPolicyV1ContractHandler,
  registerVaultPolicyV1ContractHandler,
  vaultPolicyV1Contract,
} from './contractHandler'
import {
  VAULT_POLICY_V1_EXIT_DELAY,
  VAULT_POLICY_V1_EXIT_DELAY_UNIT,
  VaultPolicyV1Script,
  pinnedDelegateXOnly,
} from './script'

async function publicKey(secret: number) {
  return (
    await SingleKey.fromPrivateKey(hex.decode(secret.toString(16).padStart(64, '0'))).compressedPublicKey()
  ).slice(1)
}

describe('vault-policy-v1 SDK contract handler', () => {
  it('round-trips the exact script while keeping Vault funds out of generic SDK selection', async () => {
    const params = {
      userPub: await publicKey(1),
      vtxoVaultCosignerPub: await publicKey(2),
      arkdServerPub: await publicKey(3),
      delegatePub: pinnedDelegateXOnly(),
      exitDelay: VAULT_POLICY_V1_EXIT_DELAY,
      exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
      exitDevicePub: await publicKey(4),
      exitHardwarePub: await publicKey(5),
      exitRecoveryPub: await publicKey(6),
    }
    const expected = new VaultPolicyV1Script(params)
    const serialized = VaultPolicyV1ContractHandler.serializeParams(params)
    const restored = VaultPolicyV1ContractHandler.createScript(serialized)

    expect(hex.encode(restored.pkScript)).toBe(hex.encode(expected.pkScript))
    expect(
      VaultPolicyV1ContractHandler.isGenericallySpendable?.(vaultPolicyV1Contract(expected, 'tark1test') as never),
    ).toBe(false)
    expect(VaultPolicyV1ContractHandler.getSpendablePaths(restored, {} as never, {} as never)).toEqual([])
  })

  it('round-trips mainnet CSV instead of freezing Mutinynet 4608s', async () => {
    const pins = networkPins('mainnet')
    const params = {
      userPub: await publicKey(1),
      vtxoVaultCosignerPub: await publicKey(2),
      arkdServerPub: await publicKey(3),
      delegatePub: hex.decode(pins.delegatePub.slice(2)),
      exitDelay: BigInt(pins.policyExitDelay),
      exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
      network: 'mainnet' as const,
      exitDevicePub: await publicKey(4),
      exitHardwarePub: await publicKey(5),
      exitRecoveryPub: await publicKey(6),
    }
    const expected = new VaultPolicyV1Script(params)
    const serialized = VaultPolicyV1ContractHandler.serializeParams(expected.params)
    expect(serialized.network).toBe('mainnet')
    expect(serialized.exitDelay).toBe(String(pins.policyExitDelay))

    const restored = VaultPolicyV1ContractHandler.createScript(serialized)
    expect(hex.encode(restored.pkScript)).toBe(hex.encode(expected.pkScript))

    const withoutNetwork = { ...serialized }
    delete withoutNetwork.network
    const restoredWithoutNetwork = VaultPolicyV1ContractHandler.createScript(withoutNetwork)
    expect(hex.encode(restoredWithoutNetwork.pkScript)).toBe(hex.encode(expected.pkScript))
  })

  it('refuses a mainnet delay under an explicit Mutinynet freeze', async () => {
    expect(
      () =>
        new VaultPolicyV1Script({
          userPub: hex.decode('11'.repeat(32)),
          vtxoVaultCosignerPub: hex.decode('22'.repeat(32)),
          arkdServerPub: hex.decode('33'.repeat(32)),
          delegatePub: pinnedDelegateXOnly(),
          exitDelay: BigInt(networkPins('mainnet').policyExitDelay),
          exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
          network: 'mutinynet',
          exitDevicePub: hex.decode('44'.repeat(32)),
          exitHardwarePub: hex.decode('55'.repeat(32)),
        }),
    ).toThrow(/frozen at 4608/)
  })

  it('registers idempotently in page and worker realms', () => {
    expect(() => {
      registerVaultPolicyV1ContractHandler()
      registerVaultPolicyV1ContractHandler()
    }).not.toThrow()
  })
})

it('persists explicit device recovery through the shared Spending handler and fails closed on lost configuration', async () => {
  const owner = await publicKey(1)
  const params = {
    userPub: owner,
    vtxoVaultCosignerPub: await publicKey(2),
    arkdServerPub: await publicKey(3),
    delegatePub: pinnedDelegateXOnly(),
    exitDelay: VAULT_POLICY_V1_EXIT_DELAY,
    exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
    exitDevicePub: owner,
    exitMode: 'device' as const,
  }
  const script = new VaultPolicyV1Script(params)
  const protectedScript = new VaultPolicyV1Script({
    ...params,
    exitMode: 'hardware',
    exitHardwarePub: await publicKey(5),
  })
  expect(script.forfeitScript).toBe(protectedScript.forfeitScript)
  expect(script.delegateScript).toBe(protectedScript.delegateScript)
  expect(script.pkScript).not.toEqual(protectedScript.pkScript)
  const serialized = VaultPolicyV1ContractHandler.serializeParams(script.params)
  expect(serialized.exitMode).toBe('device')
  expect(serialized.exitHardwarePub).toBeUndefined()
  expect(VaultPolicyV1ContractHandler.createScript(serialized).pkScript).toEqual(script.pkScript)
  const lostMode = { ...serialized }
  delete lostMode.exitMode
  expect(() => VaultPolicyV1ContractHandler.createScript(lostMode)).toThrow(/exitHardwarePub/)
  expect(() => VaultPolicyV1ContractHandler.createScript({ ...serialized, exitMode: 'fallback' })).toThrow(
    /recovery mode/,
  )
  expect(() =>
    VaultPolicyV1ContractHandler.createScript({ ...serialized, exitHardwarePub: hex.encode(owner) }),
  ).toThrow(/only the enrolled/)
  expect(() =>
    VaultPolicyV1ContractHandler.createScript({ ...serialized, exitRecoveryPub: hex.encode(owner) }),
  ).toThrow(/only the enrolled/)
  expect(() =>
    VaultPolicyV1ContractHandler.createScript({
      ...serialized,
      exitDevicePub: hex.encode(params.vtxoVaultCosignerPub),
    }),
  ).toThrow(/only the enrolled/)
  expect(
    VaultPolicyV1ContractHandler.isGenericallySpendable?.(vaultPolicyV1Contract(script, 'tark1test') as never),
  ).toBe(false)
})
