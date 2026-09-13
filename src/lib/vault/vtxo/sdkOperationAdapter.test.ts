import { buildOffchainTx, CSVMultisigTapscript, Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { describe, expect, it, vi } from 'vitest'
import golden from './testdata/vault-policy-v1-tree.json'
import { VaultPolicyV1Script } from './script'
import {
  submitExactVaultSdkOperation,
  VaultSdkOperationTimeoutError,
  type SubmitExactVaultSdkOperationParams,
  type VaultSdkOperationCallbacks,
  type VaultSdkOperationValidation,
} from './sdkOperationAdapter'

function fixture() {
  const script = new VaultPolicyV1Script({
    userPub: hex.decode(golden.fixtures.userPub),
    vtxoVaultCosignerPub: hex.decode(golden.fixtures.vtxoVaultCosignerPub),
    arkdServerPub: hex.decode(golden.fixtures.arkdServerPub),
    delegatePub: hex.decode(golden.fixtures.delegatePub),
    exitDelay: 4608n,
    exitDelayUnit: 'seconds',
    exitDevicePub: hex.decode(golden.fixtures.exitDevicePub),
    exitHardwarePub: hex.decode(golden.fixtures.exitHardwarePub),
  })
  const inputs = [
    {
      txid: '11'.repeat(32),
      vout: 0,
      value: 12_000,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    },
    {
      txid: '22'.repeat(32),
      vout: 1,
      value: 8_000,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    },
  ]
  const outputs = [{ script: script.pkScript, amount: 19_000n }]
  const serverUnrollScript = CSVMultisigTapscript.decode(
    CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: 4096n },
      pubkeys: [hex.decode(golden.fixtures.arkdServerPub)],
    }).script,
  )
  const reference = buildOffchainTx(inputs, outputs, serverUnrollScript)
  return { inputs, outputs, serverUnrollScript, reference }
}

function encode(tx: Transaction): string {
  return base64.encode(tx.toPSBT())
}

function passingHarness(overrides: Partial<VaultSdkOperationCallbacks> = {}) {
  const current = fixture()
  const dispose = vi.fn()
  const validation: VaultSdkOperationValidation = {
    assertArkTransaction: vi.fn(),
    assertCheckpointTransaction: vi.fn((tx, expected) => {
      expect(tx.id).toBe(expected.id)
    }),
  }
  const callbacks: VaultSdkOperationCallbacks = {
    authorizeArk: vi.fn(async ({ unsignedArkPsbt }) => ({ authorizedArkPsbt: unsignedArkPsbt })),
    submitOperator: vi.fn(async ({ authorizedArkPsbt, unsignedCheckpointPsbts }) => ({
      arkTxid: current.reference.arkTx.id,
      finalArkTx: authorizedArkPsbt,
      // The current Operator may return checkpoints in a different order.
      signedCheckpointTxs: [...unsignedCheckpointPsbts].reverse(),
    })),
    authorizeCheckpoints: vi.fn(async ({ operatorCheckpointPsbts }) => ({
      authorizedCheckpointPsbts: operatorCheckpointPsbts,
    })),
    finalize: vi.fn(async () => undefined),
    dispose,
    ...overrides,
  }
  const params: SubmitExactVaultSdkOperationParams = {
    ...current,
    validation,
    callbacks,
    timeoutMs: 5_000,
  }
  return { ...current, validation, callbacks, dispose, params }
}

describe('exact Vault SDK operation adapter', () => {
  it('runs the SDK thin-signer path over one exact reserved bundle and disposes once', async () => {
    const harness = passingHarness()

    await expect(submitExactVaultSdkOperation(harness.params)).resolves.toBe(harness.reference.arkTx.id)

    expect(harness.callbacks.authorizeArk).toHaveBeenCalledTimes(1)
    expect(harness.callbacks.submitOperator).toHaveBeenCalledTimes(1)
    expect(harness.callbacks.authorizeCheckpoints).toHaveBeenCalledTimes(1)
    expect(harness.callbacks.finalize).toHaveBeenCalledTimes(1)
    expect(harness.dispose).toHaveBeenCalledTimes(1)

    const authorized = vi.mocked(harness.callbacks.authorizeCheckpoints).mock.calls[0][0]
    expect(authorized.operatorCheckpointPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)).toEqual(
      harness.reference.checkpoints.map((tx) => tx.id),
    )
    const finalized = vi.mocked(harness.callbacks.finalize).mock.calls[0][0]
    expect(finalized.authorizedCheckpointPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)).toEqual(
      harness.reference.checkpoints.map((tx) => tx.id),
    )
  })

  it('requires the SDK helper rebuild to match the independently built reserved transaction', async () => {
    const harness = passingHarness()

    await submitExactVaultSdkOperation(harness.params)

    const authorizeArgs = vi.mocked(harness.callbacks.authorizeArk).mock.calls[0][0]
    expect(Transaction.fromPSBT(base64.decode(authorizeArgs.unsignedArkPsbt)).id).toBe(harness.reference.arkTx.id)
    expect(authorizeArgs.unsignedCheckpointPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)).id)).toEqual(
      harness.reference.checkpoints.map((checkpoint) => checkpoint.id),
    )
  })

  it('rejects an Ark transaction changed by Vault authorization before Operator submission', async () => {
    const harness = passingHarness()
    const changed = buildOffchainTx(
      harness.inputs,
      [{ script: harness.outputs[0].script, amount: harness.outputs[0].amount + 1n }],
      harness.serverUnrollScript,
    )
    harness.callbacks.authorizeArk = vi.fn(async () => ({ authorizedArkPsbt: encode(changed.arkTx) }))

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toThrow(/changed the reserved transaction/)
    expect(harness.callbacks.submitOperator).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate or missing Operator checkpoints before checkpoint authorization', async () => {
    const harness = passingHarness()
    harness.callbacks.submitOperator = vi.fn(async ({ authorizedArkPsbt, unsignedCheckpointPsbts }) => ({
      arkTxid: harness.reference.arkTx.id,
      finalArkTx: authorizedArkPsbt,
      signedCheckpointTxs: [unsignedCheckpointPsbts[0], unsignedCheckpointPsbts[0]],
    }))

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toThrow(/duplicate/)
    expect(harness.callbacks.authorizeCheckpoints).not.toHaveBeenCalled()
    expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails closed if only part of the Operator checkpoint set passes validation', async () => {
    const harness = passingHarness()
    let operatorCheckpointsSeen = 0
    harness.validation.assertCheckpointTransaction = vi.fn((tx, expected, stage) => {
      expect(tx.id).toBe(expected.id)
      if (stage === 'operator-signed' && ++operatorCheckpointsSeen === 2) {
        throw new Error('invalid Operator checkpoint signature')
      }
    })

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toThrow(/invalid Operator checkpoint signature/)
    expect(harness.callbacks.authorizeCheckpoints).not.toHaveBeenCalled()
    expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('requires Vault authorization to return the complete exact checkpoint set', async () => {
    const harness = passingHarness()
    harness.callbacks.authorizeCheckpoints = vi.fn(async ({ operatorCheckpointPsbts }) => ({
      authorizedCheckpointPsbts: operatorCheckpointPsbts.slice(0, 1),
    }))

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toThrow(/checkpoint count changed/)
    expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects a checkpoint transaction mutation before Operator finalization', async () => {
    const harness = passingHarness()
    const otherUnroll = CSVMultisigTapscript.decode(
      CSVMultisigTapscript.encode({
        timelock: { type: 'seconds', value: 8192n },
        pubkeys: [hex.decode(golden.fixtures.arkdServerPub)],
      }).script,
    )
    const changed = buildOffchainTx(harness.inputs, harness.outputs, otherUnroll)
    harness.callbacks.authorizeCheckpoints = vi.fn(async ({ operatorCheckpointPsbts }) => ({
      authorizedCheckpointPsbts: [encode(changed.checkpoints[0]), ...operatorCheckpointPsbts.slice(1)],
    }))

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toThrow(/not in the reserved set/)
    expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('aborts one bounded operation and still disposes operation-scoped resources', async () => {
    const harness = passingHarness()
    harness.params.timeoutMs = 10
    harness.callbacks.authorizeArk = vi.fn(
      async ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toBeInstanceOf(VaultSdkOperationTimeoutError)
    expect(harness.callbacks.submitOperator).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('aborts while checkpoint authorization is incomplete and never finalizes', async () => {
    const harness = passingHarness()
    harness.params.timeoutMs = 10
    harness.callbacks.authorizeCheckpoints = vi.fn(
      async ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )

    await expect(submitExactVaultSdkOperation(harness.params)).rejects.toBeInstanceOf(VaultSdkOperationTimeoutError)
    expect(harness.callbacks.authorizeCheckpoints).toHaveBeenCalledTimes(1)
    expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    expect(harness.dispose).toHaveBeenCalledTimes(1)
  })

  it('preserves a primary lifecycle failure when disposal also fails', async () => {
    const cleanupError = new Error('cleanup failed')
    const harness = passingHarness({ dispose: vi.fn(async () => Promise.reject(cleanupError)) })
    harness.callbacks.submitOperator = vi.fn(async ({ authorizedArkPsbt, unsignedCheckpointPsbts }) => ({
      arkTxid: harness.reference.arkTx.id,
      finalArkTx: authorizedArkPsbt,
      signedCheckpointTxs: [unsignedCheckpointPsbts[0], unsignedCheckpointPsbts[0]],
    }))

    let thrown: (Error & { cleanupError?: unknown }) | undefined
    try {
      await submitExactVaultSdkOperation(harness.params)
    } catch (error) {
      thrown = error as Error & { cleanupError?: unknown }
    }
    expect(thrown?.message).toMatch(/duplicate/)
    expect(thrown?.cleanupError).toBe(cleanupError)
  })

  it('does not turn a finalized payment into a retry when disposal reports an error', async () => {
    const harness = passingHarness({ dispose: vi.fn(async () => Promise.reject(new Error('cleanup failed'))) })

    await expect(submitExactVaultSdkOperation(harness.params)).resolves.toBe(harness.reference.arkTx.id)
    expect(harness.callbacks.finalize).toHaveBeenCalledTimes(1)
  })

  it.each(['authorizeArk', 'submitOperator', 'authorizeCheckpoints', 'finalize'] as const)(
    'drains %s after account cancellation before disposing and refuses the next phase',
    async (phase) => {
      const harness = passingHarness()
      const abort = new AbortController()
      const cancellation = new Error('Account locked')
      harness.params.signal = abort.signal
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const original = harness.callbacks[phase]
      harness.callbacks[phase] = vi.fn(async (args) => {
        await gate
        return Reflect.apply(original, harness.callbacks, [args])
      }) as never
      const result = submitExactVaultSdkOperation(harness.params)
      const rejected = expect(result).rejects.toBe(cancellation)
      await vi.waitFor(() => expect(harness.callbacks[phase]).toHaveBeenCalledOnce())
      abort.abort(cancellation)
      await Promise.resolve()
      expect(harness.dispose).not.toHaveBeenCalled()
      release()
      await rejected
      expect(harness.dispose).toHaveBeenCalledOnce()
      if (phase === 'authorizeArk') expect(harness.callbacks.submitOperator).not.toHaveBeenCalled()
      if (phase === 'submitOperator') expect(harness.callbacks.authorizeCheckpoints).not.toHaveBeenCalled()
      if (phase === 'authorizeCheckpoints') expect(harness.callbacks.finalize).not.toHaveBeenCalled()
    },
  )

  it('does not time out after exact finalization has begun', async () => {
    const harness = passingHarness()
    harness.params.timeoutMs = 10
    harness.callbacks.finalize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    await expect(submitExactVaultSdkOperation(harness.params)).resolves.toBe(harness.reference.arkTx.id)
    expect(harness.callbacks.finalize).toHaveBeenCalledTimes(1)
  })

  it('runs mandatory PSBT validators before each external lifecycle boundary', async () => {
    const harness = passingHarness()
    const phases: string[] = []
    harness.validation.assertArkTransaction = vi.fn((_tx, stage) => phases.push(`ark:${stage}`))
    harness.validation.assertCheckpointTransaction = vi.fn((_tx, _expected, stage) =>
      phases.push(`checkpoint:${stage}`),
    )

    await submitExactVaultSdkOperation(harness.params)

    expect(phases).toContain('ark:unsigned')
    expect(phases).toContain('ark:vault-authorized')
    expect(phases).toContain('ark:operator-signed')
    expect(phases).toContain('checkpoint:unsigned')
    expect(phases).toContain('checkpoint:operator-signed')
    expect(phases).toContain('checkpoint:vault-authorized')
  })
})
