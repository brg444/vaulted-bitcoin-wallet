import { buildOffchainTx, signAndSubmitOffchainTx, Transaction } from '@arkade-os/sdk'
import { base64 } from '@scure/base'

type ThinSignerParameters = Parameters<typeof signAndSubmitOffchainTx>[0]
type SubmitResponse = {
  arkTxid: string
  finalArkTx: string
  signedCheckpointTxs: string[]
}

export type VaultSdkArkStage = 'unsigned' | 'vault-authorized' | 'operator-signed'
export type VaultSdkCheckpointStage = 'unsigned' | 'operator-signed' | 'vault-authorized'

export interface VaultSdkOperationValidation {
  /**
   * Validate the full PSBT shape and exact signer set for this stage.
   * Transaction ids alone commit the economic transaction, but not PSBT tapleaf metadata.
   */
  assertArkTransaction(tx: Transaction, stage: VaultSdkArkStage): void
  assertCheckpointTransaction(tx: Transaction, expectedUnsigned: Transaction, stage: VaultSdkCheckpointStage): void
}

export interface VaultSdkOperationCallbacks {
  /** Existing passkey + VaultCosigner authorization, including durable operation state. */
  authorizeArk(args: {
    unsignedArkPsbt: string
    unsignedCheckpointPsbts: string[]
    signal: AbortSignal
  }): Promise<{ authorizedArkPsbt: string }>

  /** Existing current-Operator submission and ambiguous-response recovery. */
  submitOperator(args: {
    authorizedArkPsbt: string
    unsignedCheckpointPsbts: string[]
    signal: AbortSignal
  }): Promise<SubmitResponse>

  /** Sign the exact checkpoint set with the already-unlocked spending key, then VaultCosigner. */
  authorizeCheckpoints(args: {
    operatorCheckpointPsbts: string[]
    signal: AbortSignal
  }): Promise<{ authorizedCheckpointPsbts: string[] }>

  /** Existing current-Operator finalize plus vault-service receipt persistence. */
  finalize(args: { arkTxid: string; authorizedCheckpointPsbts: string[]; signal: AbortSignal }): Promise<void>

  /**
   * Dispose operation-scoped signing material and listeners. Must be idempotent
   * and report its own diagnostics; cleanup failure never makes a finalized send retryable.
   */
  dispose?(): void | Promise<void>
}

export type SubmitExactVaultSdkOperationParams = Pick<
  ThinSignerParameters,
  'inputs' | 'outputs' | 'serverUnrollScript' | 'verifyServerSignatures'
> & {
  validation: VaultSdkOperationValidation
  callbacks: VaultSdkOperationCallbacks
  /** Bounds one operation. Every callback receives the same abort signal. */
  timeoutMs: number
  signal?: AbortSignal
}

export class VaultSdkOperationTimeoutError extends Error {
  constructor() {
    super('Vault transaction authorization timed out')
    this.name = 'VaultSdkOperationTimeoutError'
  }
}

function decodePsbt(raw: string, context: string): Transaction {
  try {
    return Transaction.fromPSBT(base64.decode(raw))
  } catch {
    throw new Error(`${context} is not a valid PSBT`)
  }
}

function exactTransaction(tx: Transaction, expectedTxid: string, context: string) {
  if (tx.id !== expectedTxid) {
    throw new Error(`${context} changed the reserved transaction`)
  }
}

function exactCheckpointSet(
  raws: readonly string[],
  expected: readonly Transaction[],
  stage: VaultSdkCheckpointStage,
  validation: VaultSdkOperationValidation,
): { ordered: Transaction[]; encoded: string[] } {
  if (raws.length !== expected.length) {
    throw new Error(`${stage} checkpoint count changed`)
  }
  const expectedByTxid = new Map(expected.map((tx) => [tx.id, tx]))
  if (expectedByTxid.size !== expected.length) throw new Error('reserved checkpoints contain duplicate txids')
  const actualByTxid = new Map<string, Transaction>()
  for (const raw of raws) {
    const tx = decodePsbt(raw, `${stage} checkpoint`)
    const unsigned = expectedByTxid.get(tx.id)
    if (!unsigned) throw new Error(`${stage} checkpoint is not in the reserved set`)
    if (actualByTxid.has(tx.id)) throw new Error(`${stage} checkpoints contain a duplicate`)
    validation.assertCheckpointTransaction(tx, unsigned, stage)
    actualByTxid.set(tx.id, tx)
  }
  return {
    ordered: expected.map((tx) => actualByTxid.get(tx.id)!),
    encoded: expected.map((tx) => base64.encode(actualByTxid.get(tx.id)!.toPSBT())),
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Vault transaction authorization was aborted')
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError(signal)
}

function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Submit one exact server-reserved Vault operation through the SDK thin-signer path.
 *
 * This deliberately does not create a Wallet or repositories. The persistent
 * ServiceWorkerReadonlyWallet remains the only ContractManager owner, and its
 * vault-policy-v1 handler remains non-generically-spendable. The callbacks adapt
 * the existing durable Vault authorization lifecycle; they are not a second state machine.
 */
export async function submitExactVaultSdkOperation(params: SubmitExactVaultSdkOperationParams): Promise<string> {
  if (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error('Vault SDK operation timeout must be a positive integer')
  }

  params.signal?.throwIfAborted()
  const reference = buildOffchainTx(params.inputs, params.outputs, params.serverUnrollScript)
  if (reference.checkpoints.length === 0) throw new Error('Vault operation requires at least one checkpoint')
  const expectedArkTxid = reference.arkTx.id
  const unsignedCheckpointPsbts = reference.checkpoints.map((tx) => base64.encode(tx.toPSBT()))
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(new VaultSdkOperationTimeoutError()), params.timeoutMs)
  const signal = controller.signal
  const abort = () => controller.abort(params.signal?.reason)
  params.signal?.addEventListener('abort', abort, { once: true })
  const active = new Set<Promise<unknown>>()
  const invoke = <T>(work: () => Promise<T>): Promise<T> => {
    const promise = work()
    active.add(promise)
    void promise.finally(() => active.delete(promise)).catch(() => undefined)
    return promise
  }

  let arkAuthorized = false
  let operatorSubmitted = false
  let finalized = false
  let checkpointAuthorization: Promise<{ byTxid: ReadonlyMap<string, Transaction>; encoded: string[] }> | undefined
  let resolveCheckpointAuthorization: (value: {
    byTxid: ReadonlyMap<string, Transaction>
    encoded: string[]
  }) => void = () => undefined
  let rejectCheckpointAuthorization: (reason?: unknown) => void = () => undefined
  const checkpointAuthorizationReady = new Promise<{
    byTxid: ReadonlyMap<string, Transaction>
    encoded: string[]
  }>((resolve, reject) => {
    resolveCheckpointAuthorization = resolve
    rejectCheckpointAuthorization = reject
  })
  void checkpointAuthorizationReady.catch(() => undefined)
  const operatorCheckpoints = new Map<string, string>()

  const fail = (error: unknown): never => {
    if (!signal.aborted) controller.abort(error instanceof Error ? error : new Error(String(error)))
    rejectCheckpointAuthorization(error)
    throw error
  }

  const authorizeCheckpointSet = async () => {
    try {
      throwIfAborted(signal)
      const orderedOperator = reference.checkpoints.map((tx) => operatorCheckpoints.get(tx.id)!)
      const result = await invoke(() =>
        params.callbacks.authorizeCheckpoints({
          operatorCheckpointPsbts: orderedOperator,
          signal,
        }),
      )
      throwIfAborted(signal)
      const authorized = exactCheckpointSet(
        result.authorizedCheckpointPsbts,
        reference.checkpoints,
        'vault-authorized',
        params.validation,
      )
      return {
        byTxid: new Map(authorized.ordered.map((tx) => [tx.id, tx])),
        encoded: authorized.encoded,
      }
    } catch (error) {
      return fail(error)
    }
  }

  const identity = {
    sign: async (tx: Transaction): Promise<Transaction> => {
      throwIfAborted(signal)
      if (!arkAuthorized) {
        exactTransaction(tx, expectedArkTxid, 'SDK Ark transaction')
        params.validation.assertArkTransaction(tx, 'unsigned')
        const result = await invoke(() =>
          params.callbacks.authorizeArk({
            unsignedArkPsbt: base64.encode(tx.toPSBT()),
            unsignedCheckpointPsbts,
            signal,
          }),
        )
        throwIfAborted(signal)
        const authorized = decodePsbt(result.authorizedArkPsbt, 'Vault-authorized Ark transaction')
        exactTransaction(authorized, expectedArkTxid, 'Vault authorization')
        params.validation.assertArkTransaction(authorized, 'vault-authorized')
        arkAuthorized = true
        return authorized
      }

      if (!operatorSubmitted) return fail(new Error('checkpoint signing started before Operator submission'))
      const unsigned = reference.checkpoints.find((checkpoint) => checkpoint.id === tx.id)
      if (!unsigned) return fail(new Error('SDK requested a checkpoint outside the reserved set'))
      if (operatorCheckpoints.has(tx.id)) return fail(new Error('SDK requested the same checkpoint twice'))
      params.validation.assertCheckpointTransaction(tx, unsigned, 'operator-signed')
      operatorCheckpoints.set(tx.id, base64.encode(tx.toPSBT()))
      if (operatorCheckpoints.size === reference.checkpoints.length) {
        checkpointAuthorization = authorizeCheckpointSet()
        checkpointAuthorization.then(resolveCheckpointAuthorization, rejectCheckpointAuthorization)
      }
      const authorized = await rejectOnAbort(checkpointAuthorizationReady, signal)
      const matching = authorized.byTxid.get(tx.id)
      if (!matching) return fail(new Error('Vault authorization omitted a reserved checkpoint'))
      return matching
    },
  }

  const provider = {
    submitTx: async (authorizedArkPsbt: string, checkpoints: string[]): Promise<SubmitResponse> => {
      try {
        throwIfAborted(signal)
        if (!arkAuthorized || operatorSubmitted) throw new Error('Operator submission is out of sequence')
        const authorizedArk = decodePsbt(authorizedArkPsbt, 'Vault-authorized Ark transaction')
        exactTransaction(authorizedArk, expectedArkTxid, 'Operator submission')
        params.validation.assertArkTransaction(authorizedArk, 'vault-authorized')
        exactCheckpointSet(checkpoints, reference.checkpoints, 'unsigned', params.validation)
        const response = await invoke(() =>
          params.callbacks.submitOperator({
            authorizedArkPsbt,
            unsignedCheckpointPsbts,
            signal,
          }),
        )
        throwIfAborted(signal)
        if (response.arkTxid !== expectedArkTxid) throw new Error('Operator returned the wrong Ark transaction id')
        const finalArk = decodePsbt(response.finalArkTx, 'Operator-signed Ark transaction')
        exactTransaction(finalArk, expectedArkTxid, 'Operator response')
        params.validation.assertArkTransaction(finalArk, 'operator-signed')
        exactCheckpointSet(response.signedCheckpointTxs, reference.checkpoints, 'operator-signed', params.validation)
        operatorSubmitted = true
        return response
      } catch (error) {
        return fail(error)
      }
    },
    finalizeTx: async (arkTxid: string, checkpointPsbts: string[]): Promise<void> => {
      try {
        throwIfAborted(signal)
        if (!operatorSubmitted || finalized || !checkpointAuthorization) {
          throw new Error('Operator finalization is out of sequence')
        }
        if (arkTxid !== expectedArkTxid) throw new Error('SDK finalized the wrong Ark transaction')
        const expectedAuthorized = await rejectOnAbort(checkpointAuthorization, signal)
        const actual = exactCheckpointSet(checkpointPsbts, reference.checkpoints, 'vault-authorized', params.validation)
        if (actual.encoded.some((raw, index) => raw !== expectedAuthorized.encoded[index])) {
          throw new Error('SDK changed a Vault-authorized checkpoint')
        }
        // The bounded interactive phase is over. From this point the existing
        // durable operation recovery owns slow/ambiguous network finalization;
        // reporting a timeout after finalization succeeded could invite retry.
        globalThis.clearTimeout(timeout)
        await invoke(() =>
          params.callbacks.finalize({
            arkTxid,
            authorizedCheckpointPsbts: actual.encoded,
            signal,
          }),
        )
        finalized = true
      } catch (error) {
        return fail(error)
      }
    },
  }

  let primaryError: unknown
  try {
    return await rejectOnAbort(
      signAndSubmitOffchainTx({
        identity,
        provider,
        inputs: params.inputs,
        outputs: params.outputs,
        serverUnrollScript: params.serverUnrollScript,
        verifyServerSignatures: params.verifyServerSignatures,
      }),
      signal,
    )
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    params.signal?.removeEventListener('abort', abort)
    if (!signal.aborted) controller.abort(new Error('Vault SDK operation disposed'))
    await Promise.allSettled([...active])
    try {
      await params.callbacks.dispose?.()
    } catch (cleanupError) {
      // A finalized payment stays successful: cleanup diagnostics belong to
      // the idempotent callback and must never invite a duplicate retry.
      if (primaryError instanceof Error) {
        Object.defineProperty(primaryError, 'cleanupError', {
          configurable: true,
          enumerable: false,
          value: cleanupError,
        })
      } else if (primaryError !== undefined) {
        throw new AggregateError([primaryError, cleanupError], 'Vault operation and cleanup both failed')
      }
    }
  }
}
