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
  savingsSetupDigest as digest,
  validateSavingsSetupPlan,
  readSavingsSetup,
  saveSetup,
  clearSetup,
  validateSetupReceipt,
  type SetupJournal,
  type SavingsSetupPlan,
  type SavingsSetupPrepared,
} from './savingsSetupStore'
export { readSavingsSetup, type SavingsSetupPlan } from './savingsSetupStore'
const terminal = (state: string) => ['released', 'cancelled', 'rejected'].includes(state)

const post = <T>(phase: string, body: unknown): Promise<T> => vaultPost(`/v1/vtxo/savings-setup/${phase}`, body)
// The shared Guardian batch response omits receiverVout when it is zero.
// Output identity and value are still checked against the retained signed tree.
export function normalizeSavingsSetupResponse(response: LightRenewalResponse): LightRenewalResponse {
  return response.receiverTxid && response.receiverVout === undefined ? { ...response, receiverVout: 0 } : response
}
const responsePost = (phase: string, body: unknown) =>
  post<LightRenewalResponse>(phase, body).then(normalizeSavingsSetupResponse)
export const setupClient = {
  prepare: (body: unknown) => post<SavingsSetupPrepared>('prepare', body),
  register: (body: LightRenewalRegisterRequest) => responsePost('register', body),
  final: (body: LightRenewalOperationRequest & { evidence: LightRenewalFinalEvidence }) => responsePost('final', body),
  status: (body: LightRenewalOperationRequest) => responsePost('status', body),
  release: (body: LightRenewalOperationRequest & { deleteIntent?: SetupJournal['deleteIntent'] }) =>
    responsePost('release', body),
}
export async function supportsSpendingSignerSetup(status: VaultStatus) {
  connectorIdentity(status)
  const info = await vaultGet<{ version: number; maxInputs: number; descriptorHash: string }>(
    `/v1/vtxo/savings-setup/info?vaultId=${encodeURIComponent(status.vaultId)}`,
  )
  if (info.version !== 1 || info.maxInputs !== 1 || info.descriptorHash !== guardianRenewalContextDigest(status))
    throw new Error('Spending funding capability does not match this vault')
  return true
}
export async function checkSpendingSignerFunding(status: VaultStatus): Promise<LightRenewalResponse | null> {
  return withVtxoSendLock(status.vaultId, async () => {
    const journal = readSavingsSetup(status)
    if (!journal) return null
    const body = { vaultId: journal.vaultId, operationId: journal.operationId }
    let result = await setupClient.status(body)
    if (journal.stage === 'preparing' && result.state === 'not_found') {
      if (journal.prepareRequest!.expiresAt * 1000 <= Date.now() - 15000) {
        clearSetup(journal)
        return { state: 'cancelled' }
      }
      const prepared = validateSavingsSetupPlan(await setupClient.prepare(journal.prepareRequest), status)
      journal.plan = prepared
      journal.stage = 'prepared'
      saveSetup(journal)
      readSavingsSetup(status) // Recheck the complete retained request/plan binding.
      result = await setupClient.status(body)
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
      result = await setupClient.release({ ...body, deleteIntent: journal.deleteIntent })
    retainSetupOutcome(status, result)
    return result
  })
}
class SavingsSetupProvider extends RestArkProvider {
  finalEvidence?: Omit<LightRenewalFinalEvidence, 'ownerForfeitPsbt'>
  constructor(
    url: string,
    private journal: SetupJournal,
    private status: VaultStatus,
  ) {
    super(url)
  }
  override async submitSignedForfeitTxs(forfeits: string[], commitment?: string): Promise<void> {
    if (forfeits.length !== 1 || commitment || !this.finalEvidence)
      throw new Error('Unexpected Savings setup finalization')
    const saved = readSavingsSetup(this.status)
    if (!saved || saved.operationId !== this.journal.operationId) throw new Error('Signer setup journal changed')
    this.journal = saved
    const evidence = { ...this.finalEvidence, ownerForfeitPsbt: serializeLightRenewalForfeit(forfeits[0]) }
    this.journal = { ...this.journal, stage: 'finalizing', final: evidence }
    saveSetup(this.journal)
    const result = await setupClient.final({
      vaultId: this.journal.vaultId,
      operationId: this.journal.operationId,
      evidence,
    })
    if (!['submitted', 'confirmed'].includes(result.state))
      throw new Error('Setup outcome is still being checked. Keep this wallet open or check again later.')
    validateSetupReceipt(result, this.journal, this.status)
    this.journal = { ...this.journal, stage: 'submitted', receipt: result }
    saveSetup(this.journal)
  }
  override async registerIntent(): Promise<string> {
    throw new Error('Savings setup requires Vault approval')
  }
  override async deleteIntent(): Promise<void> {
    throw new Error('Use the saved Savings setup to release this operation')
  }
}

/** A subscription may replay a failure from a batch that never included our intent. */
export function scopeSavingsSetupBatchFailures(handler: ReturnType<Wallet['createBatchHandler']>) {
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

export async function fundSignerFromSpending(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  approve: (plan: SavingsSetupPlan) => Promise<boolean>,
  progress: (message: string) => void,
): Promise<LightRenewalResponse> {
  connectorIdentity(status)
  const bound = status
  const context = guardianRenewalContext(status)
  if (enrollment.vaultId !== status.vaultId) throw new Error('Sign in again to fund your signer')
  const setup = await checkConnectorSetup(status)
  if (setup.state !== 'checked' || setup.missing === 0) throw new Error('Check signer setup before funding it')
  return withVtxoSendLock(status.vaultId, async () => {
    const prior = readSavingsSetup(status)
    if (prior) throw new Error('Check the pending signer setup before starting another')
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
      if (!coin) throw new Error('No settled Spending output is available for signer setup')
      let journal: SetupJournal = {
        version: 1,
        vaultId: status.vaultId,
        descriptorHash: guardianRenewalContextDigest(status),
        operationId: createVtxoOperationId(),
        txid: coin.txid,
        vout: coin.vout,
        stage: 'preparing',
        reserveCount: setup.missing,
        valueSats: coin.value,
      }
      const prepare = {
        vaultId: journal.vaultId,
        operationId: journal.operationId,
        txid: journal.txid,
        vout: journal.vout,
        reserveCount: journal.reserveCount,
        expiresAt: Math.floor(Date.now() / 1000) + 240,
      }
      const prepareRequest = {
        ...prepare,
        ownerSignature: hex.encode(schnorr.sign(hex.decode(digest('prepare', prepare)), auth.phoneSecret)),
      }
      journal = { ...journal, prepareRequest }
      saveSetup(journal)
      const prepared = validateSavingsSetupPlan(await setupClient.prepare(prepareRequest), status)
      const plan = prepared.plan
      if (
        plan.operationId !== journal.operationId ||
        plan.txid !== coin.txid ||
        plan.vout !== coin.vout ||
        plan.valueSats !== coin.value ||
        plan.reserveCount !== journal.reserveCount
      )
        throw new Error('Setup input changed')
      journal = { ...journal, stage: 'prepared', plan: prepared }
      saveSetup(journal)
      if (!(await approve(plan))) {
        const released = await setupClient.release({ vaultId: journal.vaultId, operationId: journal.operationId })
        if (terminal(released.state)) clearSetup(journal)
        return released
      }
      if (plan.registerExpireAt * 1000 - Date.now() < 30_000)
        throw new Error('Setup approval expired. Check this setup before trying again.')
      progress('Creating signer approval outputs. Keep this page open.')
      installVaultSettlementEventSource()
      const provider = new SavingsSetupProvider(url, journal, status)
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
      saveSetup(journal)
      const session = identity.signerSession()
      const publicKey = hex.encode(await session.getPublicKey())
      const intent = await wallet.makeRegisterIntentSignature(
        [input],
        [
          { amount: BigInt(plan.changeSats), script: script.pkScript },
          ...Array.from({ length: plan.reserveCount }, () => ({
            amount: BigInt(plan.reserveSats),
            script: hex.decode(plan.reserveScript),
          })),
        ],
        Array.from({ length: plan.reserveCount }, (_, i) => i + 1),
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
      saveSetup(journal)
      const registered = await setupClient.register({
        vaultId: journal.vaultId,
        operationId: journal.operationId,
        psbt: intent.proof,
        message: JSON.stringify(intent.message),
        assertion: auth.assertion,
        directSig: vtxoSpendDirectSig(auth, prepared.planDigest),
      })
      if (registered.state !== 'registered' || !registered.intentId)
        throw new Error('Setup registration is still being checked. Check again before trying again.')
      journal = { ...journal, stage: 'registered' }
      saveSetup(journal)
      const handler = scopeSavingsSetupBatchFailures(
        wallet.createBatchHandler(
          registered.intentId,
          [input],
          [
            { address, amount: plan.changeSats },
            ...Array.from({ length: plan.reserveCount }, () => ({ address: setup.address, amount: plan.reserveSats })),
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
          throw new Error('Setup recovery paths are incomplete')
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
            consoleLog(`Signer funding batch: ${event.type}`)
        },
      })
      if (!commitment || !/^[a-f0-9]{64}$/.test(commitment))
        throw new Error(
          'The batch connection ended before signer funding completed. Check the pending setup before trying again.',
        )
      progress('Waiting for Bitcoin confirmation')
      const receipt = await setupClient.status({ vaultId: journal.vaultId, operationId: journal.operationId })
      retainSetupOutcome(status, receipt)
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

function retainSetupOutcome(status: VaultStatus, result: LightRenewalResponse) {
  const journal = readSavingsSetup(status)
  if (!journal) return
  if (terminal(result.state)) clearSetup(journal)
  else if (result.commitmentTxid) {
    validateSetupReceipt(result, journal, status)
    saveSetup({ ...journal, receipt: result, ...(result.state === 'confirmed' ? { stage: 'confirmed' as const } : {}) })
  }
}
