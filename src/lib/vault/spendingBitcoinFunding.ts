import {
  ArkAddress,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  type TxTreeNode,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import { scriptHexFromAddress, vaultAddressNetwork } from './bitcoin'
import { schnorr } from '@noble/curves/secp256k1.js'
import { consoleLog } from '../logs'
import { ensureVaultWalletWorker } from './vtxo/walletWorker'
import { BitcoinPaymentError, bitcoinPaymentRejected } from './bitcoinPaymentError'
import { chooseBitcoinInput, rememberBitcoinEligibility } from './bitcoinEligibility'
import { vaultGet, vaultPost } from './api'
import { connectorIdentity } from './connectorWithdrawal'
import { checkConnectorSetup } from './connectorSetup'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { vaultPolicyV1Contract, registerVaultPolicyV1ContractHandler } from './vtxo/contractHandler'
import {
  vaultPolicyV1ScriptFromStatus,
  createVtxoOperationId,
  createVtxoSpendUnlocker,
  newVtxoSpendChallenge,
  vaultArkServer,
  vtxoSpendDirectSig,
  withVtxoSendLock,
} from './vtxo/spend'
import { installVaultSettlementEventSource, waitForVaultSettlementStream } from './vtxo/settlementEventSource'
import { flattenTree, serializeLightRenewalForfeit, serializeLightRenewalTree } from './light/renewal'
import type {
  LightRenewalFinalEvidence,
  LightRenewalResponse,
  LightRenewalRegisterRequest,
  LightRenewalOperationRequest,
} from './light/renewalTypes'
import type { VaultStatus } from './types'
import type { EnrollmentSecrets } from './tenantEnrollment'
import { networkPins } from './networkPins'
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
  `${vaultArkServer(status.network)}:${status.vaultId}:${guardianRenewalContextDigest(status)}`
const terminal = (state: string) => ['released', 'cancelled', 'rejected'].includes(state)

const post = <T>(phase: string, body: unknown): Promise<T> => vaultPost(`/v1/vtxo/bitcoin/${phase}`, body)
// The shared Guardian batch response omits receiverVout when it is zero.
// Output identity and value are still checked against the retained signed tree.
export function normalizeBitcoinResponse(response: LightRenewalResponse): LightRenewalResponse {
  return response.receiverTxid && response.receiverVout === undefined ? { ...response, receiverVout: 0 } : response
}
const responsePost = (phase: string, body: unknown) =>
  post<LightRenewalResponse>(phase, body).then(normalizeBitcoinResponse)
export const bitcoinPaymentClient = {
  prepare: (body: NonNullable<BitcoinPaymentJournal['prepareRequest']>) =>
    body.outputs
      ? post<SpendingBitcoinPrepared>('prepare', body)
      : vaultPost<SpendingBitcoinPrepared>('/v1/vtxo/savings-setup/prepare', body),
  register: (body: LightRenewalRegisterRequest) => responsePost('register', body),
  final: (body: LightRenewalOperationRequest & { evidence: LightRenewalFinalEvidence }) => responsePost('final', body),
  status: (body: LightRenewalOperationRequest) => responsePost('status', body),
  release: (body: LightRenewalOperationRequest & { deleteIntent?: BitcoinPaymentJournal['deleteIntent'] }) =>
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
export async function checkSpendingBitcoin(status: VaultStatus): Promise<LightRenewalResponse | null> {
  return withVtxoSendLock(status.vaultId, async () => {
    const journal = readSpendingBitcoin(status)
    if (!journal) return null
    const body = { vaultId: journal.vaultId, operationId: journal.operationId }
    const result = await bitcoinPaymentClient.status(body)
    if (
      journal.stage === 'preparing' &&
      result.state === 'not_found' &&
      journal.prepareRequest!.expiresAt * 1000 <= Date.now() - 15000
    ) {
      clearBitcoinPayment(journal)
      return { state: 'cancelled' }
    }
    retainBitcoinOutcome(status, result)
    return result
  })
}
/** Cancellation is a user action, never a side effect of status polling. */
export async function cancelSpendingBitcoin(status: VaultStatus): Promise<LightRenewalResponse | null> {
  return withVtxoSendLock(status.vaultId, async () => {
    const journal = readSpendingBitcoin(status)
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
  finalEvidence?: Omit<LightRenewalFinalEvidence, 'ownerForfeitPsbt'>
  constructor(
    url: string,
    private journal: BitcoinPaymentJournal,
    private status: VaultStatus,
    private authorization: Pick<LightRenewalRegisterRequest, 'assertion' | 'directSig'>,
    private signal: AbortSignal,
    private coinExpiresAt: Date,
  ) {
    super(url)
  }
  override async submitSignedForfeitTxs(forfeits: string[], commitment?: string): Promise<void> {
    if (forfeits.length !== 1 || commitment || !this.finalEvidence)
      throw new Error('Unexpected Bitcoin payment finalization')
    const saved = readSpendingBitcoin(this.status)
    if (!saved || saved.operationId !== this.journal.operationId) throw new Error('Bitcoin payment journal changed')
    this.journal = saved
    const evidence = { ...this.finalEvidence, ownerForfeitPsbt: serializeLightRenewalForfeit(forfeits[0]) }
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
    await waitForVaultSettlementStream(`${this.journal.txid}:${this.journal.vout}`)
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
    // Keep the saved authorization until status or explicit cancellation proves release.
  }
}

/** A subscription may replay a failure from a batch that never included our intent. */
export function scopeBitcoinBatchFailures(handler: ReturnType<Wallet['createBatchHandler']>) {
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
): Promise<LightRenewalResponse> {
  outputs = validateBitcoinOutputs(outputs)
  const bound = status
  const context = guardianRenewalContext(status)
  if (outputs.reduce((sum, output) => sum + output.amountSats, 0) > context.spendingPolicy.txRecipientCapSats)
    throw new Error('This Bitcoin payment exceeds your per-payment limit')
  await supportsSpendingBitcoin(status)
  if (enrollment.vaultId !== status.vaultId) throw new Error('Sign in again to send from Spending')
  return withVtxoSendLock(status.vaultId, async () => {
    const prior = readSpendingBitcoin(status)
    if (prior) throw new Error('Check the pending Bitcoin payment before starting another')
    const unlocker = createVtxoSpendUnlocker(enrollment, bound, newVtxoSpendChallenge())
    let wallet: Wallet | undefined
    const abort = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      progress('Checking funds for this Bitcoin payment')
      const script = vaultPolicyV1ScriptFromStatus(status)
      const url = vaultArkServer(status.network)
      const indexer = new RestIndexerProvider(url)
      const result = await indexer.getVtxos({ scripts: [context.scriptPubKey] })
      const candidates = result.vtxos.filter(
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
      const auth = await unlocker.unlock()
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
      if (!(await approve(plan))) {
        const released = await bitcoinPaymentClient.release({
          vaultId: journal.vaultId,
          operationId: journal.operationId,
        })
        if (terminal(released.state)) clearBitcoinPayment(journal)
        return released
      }
      if (plan.registerExpireAt * 1000 - Date.now() < 30_000)
        throw new Error('Payment approval expired. Check this payment before trying again.')
      progress('Sending to Bitcoin. Keep this page open.')
      installVaultSettlementEventSource()
      const provider = new SpendingBitcoinProvider(
        url,
        journal,
        status,
        {
          assertion: auth.assertion,
          directSig: vtxoSpendDirectSig(auth, prepared.planDigest),
        },
        abort.signal,
        coin.expiresAt!,
      )
      const runtime = await ensureVaultWalletWorker(status)
      const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
      registerVaultPolicyV1ContractHandler()
      wallet = await Wallet.create({
        identity,
        arkProvider: provider,
        arkServerUrl: url,
        esploraUrl: '/esplora',
        storage: {
          walletRepository: runtime.walletRepository,
          contractRepository: runtime.contractRepository,
        },
        walletMode: 'static',
        settlementConfig: false,
      })
      const address = new ArkAddress(
        hex.decode(context.operatorPub),
        script.tweakedPublicKey,
        networkPins(status.network).arkHrp,
      ).encode()
      // The SDK signer router signs only inputs belonging to a known contract.
      // Register the exact enrolled Spending script before creating intent/forfeit proofs.
      await (await wallet.getContractManager()).createContract(vaultPolicyV1Contract(script, address))
      const input: ExtendedVirtualCoin = {
        ...coin,
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
        tapTree: script.encode(),
      }
      // The named program binds expiry; SDK defaults are not authorization.
      const register = wallet.makeRegisterIntentSignature.bind(wallet)
      wallet.makeRegisterIntentSignature = (...args) => {
        args[5] = plan.registerExpireAt
        return register(...args)
      }
      const deletion = wallet.makeDeleteIntentSignature.bind(wallet)
      wallet.makeDeleteIntentSignature = async (...args) => {
        const proof = await deletion(...args)
        journal = { ...journal, deleteIntent: { proof: proof.proof, message: JSON.stringify(proof.message) } }
        saveBitcoinPayment(journal)
        return proof
      }
      const createHandler = wallet.createBatchHandler.bind(wallet)
      wallet.createBatchHandler = (...args) => {
        const handler = scopeBitcoinBatchFailures(createHandler(...args))
        let batchExpiry = 0
        let unsignedTree: TxTreeNode[] = []
        const signing = handler.onTreeSigningStarted
        handler.onTreeSigningStarted = async (event, tree) => {
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
          if (!tree || !connectors || !Number.isSafeInteger(batchExpiry) || batchExpiry <= 0)
            throw new Error('Payment recovery paths are incomplete')
          provider.finalEvidence = {
            batchId: event.id,
            batchExpiry,
            commitmentPsbt: event.commitmentTx,
            vtxoTree: serializeLightRenewalTree(tree, unsignedTree),
            connectors: flattenTree(connectors),
          }
          await finalize(event, tree, connectors)
        }
        return handler
      }
      timeout = setTimeout(() => abort.abort(), Math.max(1000, plan.registerExpireAt * 1000 - Date.now() + 30_000))
      const commitment = await wallet.settle(
        {
          inputs: [input],
          outputs: [
            { address, amount: BigInt(plan.changeSats) },
            ...bitcoinPlanOutputs(plan).map((output) => ({
              address: Address(vaultAddressNetwork(status.network)).encode(OutScript.decode(hex.decode(output.script))),
              amount: BigInt(output.amountSats),
            })),
          ],
        },
        (event) => {
          if (
            ['batch_started', 'tree_signing_started', 'batch_finalization', 'batch_finalized', 'batch_failed'].includes(
              event.type,
            )
          )
            consoleLog(`Bitcoin payment batch: ${event.type}`)
        },
      )
      if (!commitment || !/^[a-f0-9]{64}$/.test(commitment))
        throw new Error(
          'The batch connection ended before Bitcoin payment completed. Check the pending payment before trying again.',
        )
      progress('Waiting for Bitcoin confirmation')
      const receipt = await bitcoinPaymentClient.status({ vaultId: journal.vaultId, operationId: journal.operationId })
      retainBitcoinOutcome(status, receipt)
      if (!['submitted', 'confirmed'].includes(receipt.state))
        throw new BitcoinPaymentError(
          'pending',
          'The batch completed. Its Bitcoin payment receipt is still being checked.',
        )
      return receipt
    } catch (error) {
      if (error instanceof BitcoinPaymentError) throw error
      const saved = readSpendingBitcoin(status)
      if (saved) {
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
      if (timeout) clearTimeout(timeout)
      abort.abort()
      unlocker.dispose()
      await wallet?.dispose().catch(() => consoleLog('Bitcoin payment signing session cleanup failed'))
    }
  })
}

function retainBitcoinOutcome(status: VaultStatus, result: LightRenewalResponse) {
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

/** Only setup knows the signer address and required exact-value outputs. */
export async function signerFundingOutputs(status: VaultStatus) {
  connectorIdentity(status)
  const setup = await checkConnectorSetup(status)
  if (setup.state !== 'checked' || setup.missing === 0) throw new Error('Check signer setup before funding it')
  return {
    address: setup.address,
    outputs: Array.from({ length: setup.missing }, () => ({
      script: scriptHexFromAddress(setup.address, status.network),
      amountSats: setup.amount,
    })),
  }
}
