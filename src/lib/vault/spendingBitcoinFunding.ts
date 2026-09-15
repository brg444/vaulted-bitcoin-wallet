import {
  ArkAddress,
  Batch,
  createSettlementSession,
  RestArkProvider,
  SingleKey,
  type TxTreeNode,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import { vaultAddressNetwork } from './bitcoin'
import { schnorr } from '@noble/curves/secp256k1.js'
import { consoleError, consoleLog } from '../logs'
import { BitcoinPaymentError, bitcoinPaymentCredentialError, bitcoinPaymentRejected } from './bitcoinPaymentError'

import { vaultLatency } from './latency'
import { traceBitcoinBatch } from './bitcoinBatchTrace'
import { chooseBitcoinInput, rememberBitcoinEligibility } from './bitcoinEligibility'
import { VaultRequestError, vaultGet, vaultPost } from './api'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { vaultPolicyV1ScriptFromStatus } from './vtxo/spendingTransaction'
import { createVtxoOperationId } from './vtxo/spendingJournal'
import { createVtxoSpendUnlocker, newVtxoSpendChallenge, vtxoSpendDirectSig, type VtxoSpendPasskey } from './vtxo/spend'
import { withVtxoSendLock } from './vtxo/lock'
import {
  installVaultSettlementEventSource,
  markVaultSettlementStreamParticipating,
  waitForVaultSettlementStream,
} from './vtxo/settlementEventSource'
import {
  flattenTree,
  serializeBitcoinForfeit,
  serializeBitcoinBatchTree,
  type BitcoinBatchFinalEvidence,
  type BitcoinPaymentResponse,
  type BitcoinRegisterRequest,
  type BitcoinOperationRequest,
} from './bitcoinBatchEvidence'
import type { VaultStatus } from './types'
import type { EnrollmentSecrets } from './tenantEnrollment'
import { networkPins, vaultOperatorOrigin } from './networkPins'
import { cancellableSdkCapability } from './sdkCapability'
import { readCommittedRecoveryCoverage, type CommittedRecoveryCoverage } from './recovery/committedCoverage'
import { fetchVaultWalletVtxoSnapshot, withVaultWalletState } from './vtxo/walletWorker'
import {
  bitcoinPlanOutputs,
  validateBitcoinOutputs,
  type BitcoinPaymentOutput,
  savingsSetupDigest as digest,
  validateSpendingBitcoinPlan,
  readSpendingBitcoin,
  saveBitcoinPayment,
  clearBitcoinPayment,
  validateBitcoinReceipt,
  type BitcoinPaymentJournal,
  type SpendingBitcoinPlan,
  type SpendingBitcoinPrepared,
} from './spendingBitcoinStore'
export { readSpendingBitcoin, type SpendingBitcoinPlan } from './spendingBitcoinStore'
const eligibilityScope = (status: VaultStatus) =>
  `${vaultOperatorOrigin(status.network)}:${status.vaultId}:${guardianRenewalContextDigest(status)}`
const terminal = (state: string) => ['released', 'cancelled', 'rejected'].includes(state)

const post = <T>(phase: string, body: unknown): Promise<T> => vaultPost(`/v1/vtxo/bitcoin/${phase}`, body)
// The shared Guardian batch response omits receiverVout when it is zero.
// Output identity and value are still checked against the retained signed tree.
export function normalizeBitcoinResponse(response: BitcoinPaymentResponse): BitcoinPaymentResponse {
  return response.receiverTxid && response.receiverVout === undefined ? { ...response, receiverVout: 0 } : response
}
const responsePost = (phase: string, body: unknown) =>
  post<BitcoinPaymentResponse>(phase, body).then(normalizeBitcoinResponse)
export const bitcoinPaymentClient = {
  prepare: (body: NonNullable<BitcoinPaymentJournal['prepareRequest']>) => {
    if (Object.hasOwn(body, 'reserveCount')) throw new Error('Unsupported Bitcoin payment request')
    validateBitcoinOutputs(body.outputs)
    return post<SpendingBitcoinPrepared>('prepare', body)
  },
  register: (body: BitcoinRegisterRequest) => responsePost('register', body),
  final: (body: BitcoinOperationRequest & { evidence: BitcoinBatchFinalEvidence }) => responsePost('final', body),
  status: (body: BitcoinOperationRequest) => responsePost('status', body),
  release: (body: BitcoinOperationRequest & { deleteIntent?: BitcoinPaymentJournal['deleteIntent'] }) =>
    responsePost('release', body),
}
export async function supportsSpendingBitcoin(status: VaultStatus) {
  const info = await vaultGet<{ version: number; maxInputs: number; descriptorHash: string }>(
    `/v1/vtxo/bitcoin/info?vaultId=${encodeURIComponent(status.vaultId)}`,
  )
  if (info.version !== 1 || info.maxInputs !== 1 || info.descriptorHash !== guardianRenewalContextDigest(status))
    throw new Error('Spending funding capability does not match this vault')
  return true
}
interface BitcoinCommandScope {
  operationId?: string
  signal?: AbortSignal
}
function requireBitcoinCommand(journal: BitcoinPaymentJournal | null, scope?: BitcoinCommandScope) {
  scope?.signal?.throwIfAborted()
  if (scope?.operationId !== undefined && journal?.operationId !== scope.operationId)
    throw new Error('The saved Bitcoin payment changed. Reopen its current details.')
}
export async function checkSpendingBitcoin(
  status: VaultStatus,
  scope?: BitcoinCommandScope,
): Promise<BitcoinPaymentResponse | null> {
  return withVtxoSendLock(status.vaultId, async () => {
    const journal = readSpendingBitcoin(status)
    requireBitcoinCommand(journal, scope)
    if (!journal) return null
    const body = { vaultId: journal.vaultId, operationId: journal.operationId }
    let result = await bitcoinPaymentClient.status(body)
    if (
      journal.stage === 'preparing' &&
      result.state === 'not_found' &&
      journal.prepareRequest!.expiresAt * 1000 <= Date.now() - 15000
    ) {
      clearBitcoinPayment(journal)
      return { state: 'cancelled' }
    }
    // A registered batch can fail before finalization without the SDK deleting
    // its intent. Use the saved owner proof after expiry; only Guardian's
    // durable release, never the local clock, makes the input spendable again.
    if (
      !journal.receipt?.commitmentTxid &&
      !result.commitmentTxid &&
      [
        'prepared',
        'register_authorized',
        'register_dispatched',
        'registered',
        'final_authorized',
        'delete_authorized',
        'delete_dispatched',
      ].includes(result.state) &&
      journal.prepareRequest!.expiresAt * 1000 <= Date.now() - 15000 &&
      (journal.deleteIntent || result.state === 'prepared' || result.state === 'register_authorized')
    ) {
      requireBitcoinCommand(readSpendingBitcoin(status), scope)
      result = await bitcoinPaymentClient.release({ ...body, deleteIntent: journal.deleteIntent })
    }
    retainBitcoinOutcome(status, result)
    return result
  })
}

/** Only the payment owner retires a confirmed journal, under its existing input lock. */
export async function acknowledgeSpendingBitcoinRecovery(
  status: VaultStatus,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
) {
  return withVtxoSendLock(status.vaultId, async () => {
    signal?.throwIfAborted()
    const journal = readSpendingBitcoin(status)
    if (!journal || journal.stage !== 'confirmed') return false
    const plan = journal.plan!.plan
    const receipt = journal.receipt!
    const outflow = bitcoinPlanOutputs(plan).reduce((sum, output) => sum + output.amountSats, 0) + plan.feeSats
    const snapshot = await fetchVaultWalletVtxoSnapshot(status)
    if (
      !snapshot.history.some(
        (row) =>
          row.account === 'spend' &&
          row.type === 'sent' &&
          row.txid === receipt.commitmentTxid &&
          row.amount === outflow,
      )
    )
      return false
    // Read durable evidence again after history observation. This also resumes
    // acknowledgment after a reload between recovery commit and notification.
    signal?.throwIfAborted()
    const coverage = await readCommittedRecoveryCoverage(status)
    if (
      !coverage ||
      (evidence &&
        (evidence.vaultId !== coverage.vaultId ||
          evidence.network !== coverage.network ||
          evidence.descriptorHash !== coverage.descriptorHash ||
          evidence.fileDigest !== coverage.fileDigest)) ||
      !coverage.outputs.some(
        (coin) =>
          coin.txid === receipt.receiverTxid &&
          coin.vout === receipt.receiverVout &&
          coin.value === plan.changeSats &&
          coin.script === status.spendingArkScript,
      )
    )
      return false
    // A stale observation cannot retire a replacement or rewritten operation.
    if (JSON.stringify(readSpendingBitcoin(status)) !== JSON.stringify(journal)) return false
    signal?.throwIfAborted()
    clearBitcoinPayment(journal)
    return true
  })
}
/** Explicit cancellation also works before the expiry cleanup runs. */
export async function cancelSpendingBitcoin(
  status: VaultStatus,
  scope?: BitcoinCommandScope,
): Promise<BitcoinPaymentResponse | null> {
  return withVtxoSendLock(status.vaultId, async () => {
    const journal = readSpendingBitcoin(status)
    requireBitcoinCommand(journal, scope)
    if (!journal) return null
    if (journal.final || journal.receipt?.commitmentTxid)
      throw new BitcoinPaymentError('pending', 'This payment has reached final submission. Check its status instead.')
    const result = await bitcoinPaymentClient.release({
      vaultId: journal.vaultId,
      operationId: journal.operationId,
      deleteIntent: journal.deleteIntent,
    })
    retainBitcoinOutcome(status, result)
    return result
  })
}
class SpendingBitcoinProvider extends RestArkProvider {
  finalEvidence?: Omit<BitcoinBatchFinalEvidence, 'ownerForfeitPsbt'>
  constructor(
    url: string,
    private journal: BitcoinPaymentJournal,
    private status: VaultStatus,
    private authorization: Pick<BitcoinRegisterRequest, 'assertion' | 'directSig'>,
    private signal: AbortSignal,
    private coinExpiresAt: Date,
  ) {
    super(url)
  }
  override async submitTreeNonces(...args: Parameters<RestArkProvider['submitTreeNonces']>): Promise<void> {
    this.signal.throwIfAborted()
    return super.submitTreeNonces(...args)
  }
  override async submitTreeSignatures(...args: Parameters<RestArkProvider['submitTreeSignatures']>): Promise<void> {
    this.signal.throwIfAborted()
    return super.submitTreeSignatures(...args)
  }
  override async submitSignedForfeitTxs(forfeits: string[], commitment?: string): Promise<void> {
    this.signal.throwIfAborted()
    if (forfeits.length !== 1 || commitment || !this.finalEvidence)
      throw new Error('Unexpected Bitcoin payment finalization')
    const saved = readSpendingBitcoin(this.status)
    if (!saved || saved.operationId !== this.journal.operationId) throw new Error('Bitcoin payment journal changed')
    this.journal = saved
    const evidence = { ...this.finalEvidence, ownerForfeitPsbt: serializeBitcoinForfeit(forfeits[0]) }
    this.journal = { ...this.journal, stage: 'finalizing', final: evidence }
    saveBitcoinPayment(this.journal)
    const result = await bitcoinPaymentClient.final({
      vaultId: this.journal.vaultId,
      operationId: this.journal.operationId,
      evidence,
    })
    if (!['submitted', 'confirmed'].includes(result.state))
      throw new Error('Payment outcome is still being checked. Keep this wallet open or check again later.')
    validateBitcoinReceipt(result, this.journal, this.status)
    this.journal = { ...this.journal, stage: 'submitted', receipt: result }
    saveBitcoinPayment(this.journal)
  }
  override async registerIntent(intent: Parameters<RestArkProvider['registerIntent']>[0]): Promise<string> {
    this.signal.throwIfAborted()
    await waitForVaultSettlementStream(`${this.journal.txid}:${this.journal.vout}`)
    this.signal.throwIfAborted()
    const saved = readSpendingBitcoin(this.status)
    if (!saved || saved.operationId !== this.journal.operationId || !saved.deleteIntent)
      throw new Error('Bitcoin payment cancellation proof is unavailable')
    this.journal = { ...saved, stage: 'registering' }
    saveBitcoinPayment(this.journal)
    const result = await bitcoinPaymentClient.register({
      vaultId: this.journal.vaultId,
      operationId: this.journal.operationId,
      psbt: intent.proof,
      message: JSON.stringify(intent.message),
      ...this.authorization,
    })
    retainBitcoinOutcome(this.status, result)
    if (terminal(result.state)) {
      const retryAt = rememberBitcoinEligibility(
        eligibilityScope(this.status),
        { ...this.journal, expiresAt: this.coinExpiresAt },
        result.reason,
      )
      throw bitcoinPaymentRejected(result.reason, retryAt)
    }
    if (result.state !== 'registered' || !result.intentId)
      throw new BitcoinPaymentError(
        'pending',
        'Payment registration is still being checked. Open the pending payment before trying again.',
      )
    this.journal = { ...this.journal, stage: 'registered' }
    saveBitcoinPayment(this.journal)
    return result.intentId
  }
  override getEventStream(signal?: AbortSignal, topics: string[] = []) {
    return super.getEventStream(signal ? AbortSignal.any([signal, this.signal]) : this.signal, topics)
  }
  override async deleteIntent(): Promise<void> {
    // SDK error cleanup cannot prove non-admission for a named Guardian operation.
    // Its generic intent repository is deliberately not installed on this signing view.
    // Keep the saved authorization until expiry cleanup or cancellation proves release.
  }
}

/** A subscription may replay a failure from a batch that never included our intent. */
export function scopeBitcoinBatchFailures(handler: Batch.Handler) {
  let participatingBatch: string | undefined
  const start = handler.onBatchStarted
  const failure = handler.onBatchFailed
  handler.onBatchStarted = async (event) => {
    const decision = await start(event)
    if (!decision.skip) participatingBatch = event.id
    return decision
  }
  handler.onBatchFailed = async (event) => {
    if (event.id !== participatingBatch) return
    if (failure) await failure(event)
    else throw new Error(event.reason)
  }
  return handler
}

export async function sendSpendingToBitcoin(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  outputs: BitcoinPaymentOutput[],
  approve: (plan: SpendingBitcoinPlan) => Promise<boolean>,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<BitcoinPaymentResponse> {
  signal?.throwIfAborted()
  outputs = validateBitcoinOutputs(outputs)
  const bound = status
  const context = guardianRenewalContext(status)
  if (outputs.reduce((sum, output) => sum + output.amountSats, 0) > context.spendingPolicy.txRecipientCapSats)
    throw new Error('This Bitcoin payment exceeds your per-payment limit')
  await vaultLatency.measure('bitcoin-setup', () => supportsSpendingBitcoin(status))
  signal?.throwIfAborted()
  if (enrollment.vaultId !== status.vaultId) throw new Error('Sign in again to send from Spending')
  progress('Waiting for exclusive Spending access')
  return withVtxoSendLock(status.vaultId, async () => {
    signal?.throwIfAborted()
    const prior = readSpendingBitcoin(status)
    if (prior) throw new Error('Check the pending Bitcoin payment before starting another')
    return withVaultWalletState(status, async ({ contracts }) => {
      signal?.throwIfAborted()
      const unlocker = createVtxoSpendUnlocker(enrollment, bound, newVtxoSpendChallenge(), undefined, signal)
      const abort = new AbortController()
      const cancel = () => abort.abort(signal?.reason)
      signal?.addEventListener('abort', cancel, { once: true })
      let timeout: ReturnType<typeof setTimeout> | undefined
      let stream: AsyncIterableIterator<import('@arkade-os/sdk').SettlementEvent> | undefined
      const visibility = () => consoleLog(`Bitcoin payment page: ${document.visibilityState}`)
      const pagehide = () => consoleLog('Bitcoin payment page closed before the signing session finished')
      document.addEventListener('visibilitychange', visibility)
      window.addEventListener('pagehide', pagehide)
      try {
        progress('Checking funds for this Bitcoin payment')
        const script = vaultPolicyV1ScriptFromStatus(status)
        const url = vaultOperatorOrigin(status.network)
        await vaultLatency.measure('bitcoin-setup', async () => {
          await contracts.refreshVtxos({ scripts: [context.scriptPubKey] })
          signal?.throwIfAborted()
        })
        const known = await contracts.getContractsWithVtxos({ script: context.scriptPubKey })
        signal?.throwIfAborted()
        const candidates = known
          .flatMap((contract) => contract.vtxos)
          .filter(
            (v) =>
              v.script === context.scriptPubKey &&
              /^[a-f0-9]{64}$/.test(v.txid) &&
              Number.isSafeInteger(v.vout) &&
              v.vout >= 0 &&
              v.vout <= 0xffffffff &&
              Number.isSafeInteger(v.value) &&
              v.value > 0 &&
              v.value <= 21e14 &&
              !v.isSpent &&
              !v.isSwept &&
              !v.isUnrolled &&
              !v.assets?.length &&
              v.commitmentTxIds?.length &&
              v.expiresAt &&
              v.expiresAt.getTime() > Date.now(),
          )
        const coin = chooseBitcoinInput(
          eligibilityScope(status),
          candidates,
          outputs.reduce((sum, output) => sum + output.amountSats, 0),
        )
        if (!coin) throw new Error('No live Spending output is available for this Bitcoin payment')
        progress('Unlock Spending with your passkey')
        let auth: VtxoSpendPasskey
        try {
          auth = await vaultLatency.measure('passkey', () => unlocker.unlock())
        } catch (error) {
          throw bitcoinPaymentCredentialError(error)
        }
        signal?.throwIfAborted()
        let journal: BitcoinPaymentJournal = {
          version: 1,
          vaultId: status.vaultId,
          descriptorHash: guardianRenewalContextDigest(status),
          operationId: createVtxoOperationId(),
          txid: coin.txid,
          vout: coin.vout,
          stage: 'preparing',
          reserveCount: 0,
          outputs,
          valueSats: coin.value,
        }
        const prepare = {
          vaultId: journal.vaultId,
          operationId: journal.operationId,
          txid: journal.txid,
          vout: journal.vout,
          outputs,
          expiresAt: Math.floor(Date.now() / 1000) + 240,
        }
        const prepareRequest = {
          ...prepare,
          ownerSignature: hex.encode(schnorr.sign(hex.decode(digest('bitcoin-prepare', prepare)), auth.phoneSecret)),
        }
        journal = { ...journal, prepareRequest }
        saveBitcoinPayment(journal)
        const prepared = validateSpendingBitcoinPlan(await bitcoinPaymentClient.prepare(prepareRequest), status)
        const plan = prepared.plan
        if (
          plan.operationId !== journal.operationId ||
          plan.txid !== coin.txid ||
          plan.vout !== coin.vout ||
          plan.valueSats !== coin.value ||
          JSON.stringify(plan.outputs) !== JSON.stringify(outputs)
        )
          throw new Error('Payment input changed')
        journal = { ...journal, stage: 'prepared', plan: prepared }
        saveBitcoinPayment(journal)
        if (signal?.aborted || !(await approve(plan))) {
          const released = await bitcoinPaymentClient.release({
            vaultId: journal.vaultId,
            operationId: journal.operationId,
          })
          if (terminal(released.state)) clearBitcoinPayment(journal)
          return released
        }
        signal?.throwIfAborted()
        if (plan.registerExpireAt * 1000 - Date.now() < 30_000)
          throw new Error('Payment approval expired. Check this payment before trying again.')
        progress('Sending to Bitcoin. Keep this page open.')
        installVaultSettlementEventSource()
        const provider = cancellableSdkCapability(
          new SpendingBitcoinProvider(
            url,
            journal,
            status,
            {
              assertion: auth.assertion,
              directSig: vtxoSpendDirectSig(auth, prepared.planDigest),
            },
            abort.signal,
            coin.expiresAt!,
          ),
          abort.signal,
        )
        const identity = cancellableSdkCapability(SingleKey.fromPrivateKey(auth.phoneSecret), abort.signal)
        const settlement = await createSettlementSession({
          identity,
          contracts,
          arkProvider: provider,
          network: networkPins(status.network).sdkNetwork,
        })
        signal?.throwIfAborted()
        const address = new ArkAddress(
          hex.decode(context.operatorPub),
          script.tweakedPublicKey,
          networkPins(status.network).arkHrp,
        ).encode()
        const input: ExtendedVirtualCoin = {
          ...coin,
          forfeitTapLeafScript: script.forfeit(),
          intentTapLeafScript: script.forfeit(),
          tapTree: script.encode(),
        }
        // Retain the owner's exact non-monetary cancellation before registration.
        // It remains usable after a reload without another passkey ceremony.
        const deletion = await settlement.makeDeleteIntentSignature([input])
        journal = { ...journal, deleteIntent: { proof: deletion.proof, message: JSON.stringify(deletion.message) } }
        saveBitcoinPayment(journal)
        // The same signing session must advertise the tree key and sign the tree.
        // wallet.settle() hides this protected-flow boundary and previously caused
        // Guardian finalization to miss the Operator's batch deadline.
        signal?.throwIfAborted()
        const session = identity.signerSession()
        const publicKey = hex.encode(await session.getPublicKey())
        signal?.throwIfAborted()
        const intent = await settlement.makeRegisterIntentSignature(
          [input],
          [
            { amount: BigInt(plan.changeSats), script: script.pkScript },
            ...bitcoinPlanOutputs(plan).map((output) => ({
              amount: BigInt(output.amountSats),
              script: hex.decode(output.script),
            })),
          ],
          outputs.map((_, i) => i + 1),
          [publicKey],
          undefined,
          plan.registerExpireAt,
        )
        signal?.throwIfAborted()
        timeout = setTimeout(
          () => {
            consoleLog('Bitcoin payment signing deadline reached')
            abort.abort()
          },
          Math.max(1000, plan.registerExpireAt * 1000 - Date.now() + 30_000),
        )
        stream = provider.getEventStream(abort.signal, [publicKey, `${coin.txid}:${coin.vout}`])
        const first = stream.next()
        void first.catch(() => {})
        const source = stream
        const primed = (async function* () {
          const next = await first
          if (!next.done) yield next.value
          yield* source
        })()
        signal?.throwIfAborted()
        const intentId = await provider.registerIntent(intent)
        let handler = scopeBitcoinBatchFailures(
          settlement.createBatchHandler(
            intentId,
            [input],
            [
              { address, amount: plan.changeSats },
              ...bitcoinPlanOutputs(plan).map((output) => ({
                address: Address(vaultAddressNetwork(status.network)).encode(
                  OutScript.decode(hex.decode(output.script)),
                ),
                amount: output.amountSats,
              })),
            ],
            session,
          ),
        )
        let batchExpiry = 0
        let unsignedTree: TxTreeNode[] = []
        const signing = handler.onTreeSigningStarted
        handler.onTreeSigningStarted = async (event, tree) => {
          abort.signal.throwIfAborted()
          const decision = await signing(event, tree)
          if (!decision.skip) unsignedTree = flattenTree(tree)
          return decision
        }
        const start = handler.onBatchStarted
        handler.onBatchStarted = async (event) => {
          const decision = await start(event)
          if (!decision.skip) batchExpiry = Number(event.batchExpiry)
          return decision
        }
        const finalize = handler.onBatchFinalization
        handler.onBatchFinalization = async (event, tree, connectors) => {
          abort.signal.throwIfAborted()
          if (!tree || !connectors || !Number.isSafeInteger(batchExpiry) || batchExpiry <= 0)
            throw new Error('Payment recovery paths are incomplete')
          provider.finalEvidence = {
            batchId: event.id,
            batchExpiry,
            commitmentPsbt: event.commitmentTx,
            vtxoTree: serializeBitcoinBatchTree(tree, unsignedTree),
            connectors: flattenTree(connectors),
          }
          await finalize(event, tree, connectors)
        }
        handler = traceBitcoinBatch(handler, () =>
          markVaultSettlementStreamParticipating(`${journal.txid}:${journal.vout}`),
        )
        const commitment = await Batch.join(primed, handler, {
          abortController: abort,
          eventCallback: async (event) => {
            if (
              [
                'batch_started',
                'tree_signing_started',
                'batch_finalization',
                'batch_finalized',
                'batch_failed',
              ].includes(event.type)
            )
              consoleLog(`Bitcoin payment event received: ${event.type} (${event.id})`)
          },
        })
        if (!commitment || !/^[a-f0-9]{64}$/.test(commitment))
          throw new Error(
            'The batch connection ended before Bitcoin payment completed. Check the pending payment before trying again.',
          )
        progress('Waiting for Bitcoin confirmation')
        const receipt = await bitcoinPaymentClient.status({
          vaultId: journal.vaultId,
          operationId: journal.operationId,
        })
        retainBitcoinOutcome(status, receipt)
        if (!['submitted', 'confirmed'].includes(receipt.state))
          throw new BitcoinPaymentError(
            'pending',
            'The batch completed. Its Bitcoin payment receipt is still being checked.',
          )
        return receipt
      } catch (error) {
        consoleError(error, 'Bitcoin payment lifecycle')
        if (error instanceof BitcoinPaymentError) throw error
        const saved = readSpendingBitcoin(status)
        if (saved) {
          const rejected = await prepareRejection(status, saved, error)
          if (rejected) throw rejected
          const receipt = await bitcoinPaymentClient
            .status({ vaultId: saved.vaultId, operationId: saved.operationId })
            .catch(() => null)
          if (receipt) {
            retainBitcoinOutcome(status, receipt)
            if (['submitted', 'confirmed'].includes(receipt.state)) return receipt
            if (terminal(receipt.state)) throw bitcoinPaymentRejected(receipt.reason)
          }
          throw new BitcoinPaymentError(
            'pending',
            'This payment has not completed. Open it in Recent to check its status before trying again.',
          )
        }
        throw error
      } finally {
        signal?.removeEventListener('abort', cancel)
        document.removeEventListener('visibilitychange', visibility)
        window.removeEventListener('pagehide', pagehide)
        if (timeout) clearTimeout(timeout)
        abort.abort()
        await stream?.return?.().catch(() => {})
        unlocker.dispose()
      }
    })
  })
}

/**
 * Definitive pre-registration rejection: the Guardian refused this exact
 * prepare request (400) and authoritative status confirms the operation was
 * never admitted (a 200 body with state `not_found`). The local draft is
 * cleared and the Guardian's reason surfaces as `not_sent` — nothing was
 * reserved. A transport-level 404 proves nothing about the authenticated
 * operation, so it keeps the pending path, as do network/timeout errors, an
 * unreachable status lookup, and any real operation state: a lost prepare
 * response must never be mistaken for a rejection. All runtime rejections
 * precede any ledger write, so `not_found` for the rejected operationId is
 * conclusive rather than a lagging index.
 */
async function prepareRejection(
  status: VaultStatus,
  journal: BitcoinPaymentJournal,
  error: unknown,
): Promise<BitcoinPaymentError | null> {
  if (journal.stage !== 'preparing') return null
  if (!(error instanceof VaultRequestError) || error.status !== 400 || error.code !== 'REJECTED') return null
  let admitted: string | null = null
  try {
    admitted = (await bitcoinPaymentClient.status({ vaultId: journal.vaultId, operationId: journal.operationId })).state
  } catch {
    return null
  }
  if (admitted !== 'not_found') return null
  clearBitcoinPayment(journal)
  return bitcoinPaymentRejected(error.message)
}

function retainBitcoinOutcome(status: VaultStatus, result: BitcoinPaymentResponse) {
  const journal = readSpendingBitcoin(status)
  if (!journal) return
  if (terminal(result.state)) clearBitcoinPayment(journal)
  else if (result.commitmentTxid) {
    validateBitcoinReceipt(result, journal, status)
    saveBitcoinPayment({
      ...journal,
      receipt: result,
      ...(result.state === 'confirmed' ? { stage: 'confirmed' as const } : {}),
    })
  }
}
