import {
  ArkAddress,
  Batch,
  InMemoryContractRepository,
  InMemoryWalletRepository,
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
    let result = await bitcoinPaymentClient.status(body)
    if (journal.stage === 'preparing' && result.state === 'not_found') {
      if (journal.prepareRequest!.expiresAt * 1000 <= Date.now() - 15000) {
        clearBitcoinPayment(journal)
        return { state: 'cancelled' }
      }
      const prepared = validateSpendingBitcoinPlan(await bitcoinPaymentClient.prepare(journal.prepareRequest!), status)
      journal.plan = prepared
      journal.stage = 'prepared'
      saveBitcoinPayment(journal)
      readSpendingBitcoin(status) // Recheck the complete retained request/plan binding.
      result = await bitcoinPaymentClient.status(body)
    }
    if (
      [
        'prepared',
        'register_authorized',
        'register_dispatched',
        'registered',
        'final_authorized',
        'delete_authorized',
        'delete_dispatched',
        'delete_result',
      ].includes(result.state)
    )
      result = await bitcoinPaymentClient.release({ ...body, deleteIntent: journal.deleteIntent })
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
  override async registerIntent(): Promise<string> {
    throw new Error('Bitcoin payment requires Vault approval')
  }
  override async deleteIntent(): Promise<void> {
    throw new Error('Use the saved Bitcoin payment to release this operation')
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
    let stream: AsyncIterableIterator<import('@arkade-os/sdk').SettlementEvent> | undefined
    try {
      progress('Unlock Spending with your passkey')
      const auth = await unlocker.unlock()
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
      candidates.sort((a, b) => b.value - a.value)
      const coin = candidates[0]
      if (!coin) throw new Error('No live Spending output is available for this Bitcoin payment')
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
      const provider = new SpendingBitcoinProvider(url, journal, status)
      const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
      registerVaultPolicyV1ContractHandler()
      wallet = await Wallet.create({
        identity,
        arkProvider: provider,
        arkServerUrl: url,
        esploraUrl: '/esplora',
        storage: {
          walletRepository: new InMemoryWalletRepository(),
          contractRepository: new InMemoryContractRepository(),
        },
        walletMode: 'static',
        settlementConfig: { boardingUtxoSweep: false, deprecatedSignerMigration: false, autoRenewVtxos: false },
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
      // Retain the owner's exact non-monetary cancellation before registration.
      // It remains usable after a reload without another passkey ceremony.
      const deletion = await wallet.makeDeleteIntentSignature([input])
      journal = { ...journal, deleteIntent: { proof: deletion.proof, message: JSON.stringify(deletion.message) } }
      saveBitcoinPayment(journal)
      const session = identity.signerSession()
      const publicKey = hex.encode(await session.getPublicKey())
      const intent = await wallet.makeRegisterIntentSignature(
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
      timeout = setTimeout(() => abort.abort(), Math.max(1000, plan.registerExpireAt * 1000 - Date.now() + 30_000))
      stream = provider.getEventStream(abort.signal, [publicKey, `${coin.txid}:${coin.vout}`])
      const first = stream.next()
      void first.catch(() => {})
      await waitForVaultSettlementStream(`${coin.txid}:${coin.vout}`)
      const source = stream
      const primed = (async function* () {
        const next = await first
        if (!next.done) yield next.value
        yield* source
      })()
      journal = { ...journal, stage: 'registering' }
      saveBitcoinPayment(journal)
      const registered = await bitcoinPaymentClient.register({
        vaultId: journal.vaultId,
        operationId: journal.operationId,
        psbt: intent.proof,
        message: JSON.stringify(intent.message),
        assertion: auth.assertion,
        directSig: vtxoSpendDirectSig(auth, prepared.planDigest),
      })
      if (registered.state !== 'registered' || !registered.intentId)
        throw new Error('Payment registration is still being checked. Check again before trying again.')
      journal = { ...journal, stage: 'registered' }
      saveBitcoinPayment(journal)
      const handler = scopeBitcoinBatchFailures(
        wallet.createBatchHandler(
          registered.intentId,
          [input],
          [
            { address, amount: plan.changeSats },
            ...bitcoinPlanOutputs(plan).map((output) => ({
              address: Address(vaultAddressNetwork(status.network)).encode(OutScript.decode(hex.decode(output.script))),
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
      const commitment = await Batch.join(primed, handler, {
        abortController: abort,
        eventCallback: async (event) => {
          if (
            ['batch_started', 'tree_signing_started', 'batch_finalization', 'batch_finalized', 'batch_failed'].includes(
              event.type,
            )
          )
            consoleLog(`Bitcoin payment batch: ${event.type}`)
        },
      })
      if (!commitment || !/^[a-f0-9]{64}$/.test(commitment))
        throw new Error(
          'The batch connection ended before Bitcoin payment completed. Check the pending payment before trying again.',
        )
      progress('Waiting for Bitcoin confirmation')
      const receipt = await bitcoinPaymentClient.status({ vaultId: journal.vaultId, operationId: journal.operationId })
      retainBitcoinOutcome(status, receipt)
      return receipt
    } finally {
      if (timeout) clearTimeout(timeout)
      abort.abort()
      await stream?.return?.().catch(() => {})
      await wallet?.dispose()
      unlocker.dispose()
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
