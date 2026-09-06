import {
  ArkAddress,
  Batch,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  Transaction,
  type TxTree,
  type TxTreeNode,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { lightDescriptorDigest, LightScript, type LightDescriptor } from './contract'
import { lightContract, registerLightContractHandler } from './contractHandler'
import { installVaultSettlementEventSource, waitForVaultSettlementStream } from '../vtxo/settlementEventSource'
import { validateLightEnrollment, type LightEnrollment } from './enrollment'
import { lightStatusMatchesDescriptor } from './status'
import { vaultCosignerClient } from '../cosignerClient'
import {
  createVtxoOperationId,
  createVtxoSpendUnlocker,
  newVtxoSpendChallenge,
  vaultArkServer,
  vtxoSpendDirectSig,
  withVtxoSendLock,
} from '../vtxo/spend'
import { networkPins } from '../networkPins'
import type { VaultStatus } from '../types'
import type {
  LightRenewalPlan,
  LightRenewalPrepared,
  LightRenewalFinalEvidence,
  LightRenewalResponse,
} from './renewalTypes'

const canonicalHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)
const digest = (domain: string, value: unknown) =>
  hex.encode(sha256(new TextEncoder().encode(`${domain}:${JSON.stringify(value)}`)))

export function validateLightRenewalPlan(value: LightRenewalPrepared, d: LightDescriptor): LightRenewalPrepared {
  const p = value.plan
  if (
    !p ||
    !canonicalHex(p.operationId, 16) ||
    p.vaultId !== d.vaultId ||
    p.descriptorHash !== lightDescriptorDigest(d) ||
    !canonicalHex(p.txid, 32) ||
    !canonicalHex(p.feePolicyDigest, 32) ||
    !Number.isSafeInteger(p.vout) ||
    p.vout < 0 ||
    p.vout > 0xffffffff ||
    !Number.isSafeInteger(p.valueSats) ||
    p.valueSats > 21e14 ||
    !Number.isSafeInteger(p.receiverSats) ||
    p.receiverSats < 330 ||
    !Number.isSafeInteger(p.feeSats) ||
    p.feeSats < 0 ||
    p.feeSats > d.spendingPolicy.absoluteFeeCapSats ||
    p.receiverSats + p.feeSats !== p.valueSats ||
    !Number.isSafeInteger(p.registerExpireAt) ||
    p.registerExpireAt <= 0
  )
    throw new Error('Renewal does not match this wallet and its limits')
  const plan: LightRenewalPlan = {
    operationId: p.operationId,
    vaultId: p.vaultId,
    descriptorHash: p.descriptorHash,
    txid: p.txid,
    vout: p.vout,
    valueSats: p.valueSats,
    receiverSats: p.receiverSats,
    feeSats: p.feeSats,
    feePolicyDigest: p.feePolicyDigest,
    registerExpireAt: p.registerExpireAt,
  }
  if (digest('vaulted-light/renewal-plan/v1', plan) !== value.planDigest) throw new Error('Renewal approval changed')
  return { plan, planDigest: value.planDigest, state: value.state }
}

interface RenewalJournal {
  version: 1
  vaultId: string
  descriptorHash: string
  operationId: string
  txid: string
  vout: number
  stage: 'preparing' | 'prepared' | 'registering' | 'registered' | 'finalizing' | 'submitted'
  plan?: LightRenewalPrepared
  final?: LightRenewalFinalEvidence
}
const journalKey = (vaultId: string) => `vaulted-light-renewal:${vaultId}`
export function readLightRenewal(d: LightDescriptor): RenewalJournal | null {
  const raw = localStorage.getItem(journalKey(d.vaultId))
  if (!raw) return null
  if (raw.length > 1_000_000) throw new Error('Renewal record is too large')
  const record = JSON.parse(raw) as RenewalJournal
  if (
    record.version !== 1 ||
    record.vaultId !== d.vaultId ||
    record.descriptorHash !== lightDescriptorDigest(d) ||
    !canonicalHex(record.operationId, 16) ||
    !canonicalHex(record.txid, 32) ||
    !Number.isSafeInteger(record.vout) ||
    record.vout < 0 ||
    record.vout > 0xffffffff ||
    !['preparing', 'prepared', 'registering', 'registered', 'finalizing', 'submitted'].includes(record.stage)
  )
    throw new Error('Renewal record does not match this wallet')
  if (record.plan) {
    record.plan = validateLightRenewalPlan(record.plan, d)
    if (
      record.plan.plan.operationId !== record.operationId ||
      record.plan.plan.txid !== record.txid ||
      record.plan.plan.vout !== record.vout
    )
      throw new Error('Renewal record changed')
  }
  return record
}
function saveRenewal(record: RenewalJournal) {
  const raw = JSON.stringify(record)
  if (raw.length > 1_000_000) throw new Error('Recovery paths are too large to save for this renewal')
  localStorage.setItem(journalKey(record.vaultId), raw)
  if (localStorage.getItem(journalKey(record.vaultId)) !== raw) throw new Error('Unable to save renewal progress')
}
const terminal = (state: string) => ['confirmed', 'released', 'cancelled', 'rejected'].includes(state)
export async function checkLightRenewal(record: LightEnrollment): Promise<LightRenewalResponse | null> {
  const valid = validateLightEnrollment(record)
  return withVtxoSendLock(valid.descriptor.vaultId, async () => {
    const journal = readLightRenewal(valid.descriptor)
    if (!journal) return null
    const request = { vaultId: journal.vaultId, operationId: journal.operationId }
    let result = await vaultCosignerClient.lightRenewal.status(request)
    if (
      ['prepared', 'register_authorized', 'register_dispatched', 'registered', 'final_authorized'].includes(
        result.state,
      )
    )
      result = await vaultCosignerClient.lightRenewal.release(request)
    if (terminal(result.state)) localStorage.removeItem(journalKey(journal.vaultId))
    return result
  })
}

// The SDK constructs and validates intents, trees, MuSig sessions and forfeits.
// Vault code supplies the named cosigner boundary and durable recovery journal.
function flattenTree(tree: TxTree): TxTreeNode[] {
  const result: TxTreeNode[] = []
  const queue = [tree]
  const seen = new Set<string>()
  while (queue.length) {
    const node = queue.pop()!
    if (seen.has(node.root.id) || result.length >= 512) throw new Error('Invalid renewal recovery graph')
    seen.add(node.root.id)
    result.push({
      txid: node.root.id,
      tx: base64.encode(node.root.toPSBT()),
      children: Object.fromEntries([...node.children].map(([index, child]) => [index, child.root.id])),
    })
    queue.push(...node.children.values())
  }
  return result
}

// The pinned SDK's TxTree uses scure's default unknown-field policy: adding a
// tree signature can discard the public MuSig key metadata. Retain the exact
// pre-signing PSBT and attach only the SDK's completed signature. The runtime
// independently checks the complete signed graph and its aggregate keys.
export function serializeLightRenewalTree(tree: TxTree, unsigned: TxTreeNode[]): TxTreeNode[] {
  const signed = flattenTree(tree)
  if (signed.length !== unsigned.length) throw new Error('Renewal tree changed while signing')
  const originals = new Map(unsigned.map((node) => [node.txid, node]))
  if (originals.size !== unsigned.length) throw new Error('Repeated renewal tree transaction')
  return signed.map((node) => {
    const original = originals.get(node.txid)
    if (!original || JSON.stringify(original.children) !== JSON.stringify(node.children))
      throw new Error('Renewal tree changed while signing')
    const tx = Transaction.fromPSBT(base64.decode(original.tx))
    const completed = Transaction.fromPSBT(base64.decode(node.tx))
    const signature = completed.getInput(0).tapKeySig
    if (tx.id !== completed.id || !signature || signature.length !== 64)
      throw new Error('Renewal tree signature is missing')
    tx.updateInput(0, { tapKeySig: signature })
    return { ...original, tx: base64.encode(tx.toPSBT()) }
  })
}

export function serializeLightRenewalForfeit(raw: string): string {
  const tx = Transaction.fromPSBT(base64.decode(raw))
  if (tx.inputsLength !== 2 || (tx.getInput(0).sighashType ?? 0) !== 0)
    throw new Error('Unexpected Light forfeit signature mode')
  // btcd omits an explicit SIGHASH_DEFAULT PSBT field. Its omission retains
  // exactly the same BIP-341 digest and 64-byte owner signature.
  tx.updateInput(0, { sighashType: undefined }, true)
  return base64.encode(tx.toPSBT())
}

class LightRenewalProvider extends RestArkProvider {
  finalEvidence?: Omit<LightRenewalFinalEvidence, 'ownerForfeitPsbt'>
  constructor(
    url: string,
    private journal: RenewalJournal,
  ) {
    super(url)
  }
  override async submitSignedForfeitTxs(forfeits: string[], commitment?: string): Promise<void> {
    if (forfeits.length !== 1 || commitment || !this.finalEvidence)
      throw new Error('Unexpected Light renewal finalization')
    const evidence = { ...this.finalEvidence, ownerForfeitPsbt: serializeLightRenewalForfeit(forfeits[0]) }
    this.journal = { ...this.journal, stage: 'finalizing', final: evidence }
    saveRenewal(this.journal)
    const result = await vaultCosignerClient.lightRenewal.final({
      vaultId: this.journal.vaultId,
      operationId: this.journal.operationId,
      evidence,
    })
    if (!['submitted', 'confirmed'].includes(result.state))
      throw new Error('Renewal outcome is still being checked. Keep this wallet open or check again later.')
    this.journal = { ...this.journal, stage: 'submitted' }
    saveRenewal(this.journal)
  }
  override async registerIntent(): Promise<string> {
    throw new Error('Light renewal requires Vault approval')
  }
  override async deleteIntent(): Promise<void> {
    throw new Error('Use the saved Light renewal to release this operation')
  }
}

export async function renewLightSpending(
  record: LightEnrollment,
  status: VaultStatus,
  approve: (plan: LightRenewalPlan) => Promise<boolean>,
  progress: (message: string) => void,
): Promise<LightRenewalResponse> {
  const valid = validateLightEnrollment(record)
  const bound = lightStatusMatchesDescriptor(status, valid.descriptor)
  return withVtxoSendLock(valid.descriptor.vaultId, async () => {
    const prior = readLightRenewal(valid.descriptor)
    if (prior && prior.stage !== 'preparing') throw new Error('Check the previous renewal before starting another')
    const unlocker = createVtxoSpendUnlocker(valid.enrollment, bound, newVtxoSpendChallenge())
    let wallet: Wallet | undefined
    const abort = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let stream: AsyncIterableIterator<import('@arkade-os/sdk').SettlementEvent> | undefined
    try {
      progress('Approve with your passkey to prepare renewal')
      const auth = await unlocker.unlock()
      const script = new LightScript(valid.descriptor)
      const url = vaultArkServer(valid.descriptor.network)
      const indexer = new RestIndexerProvider(url)
      const result = await indexer.getVtxos({ scripts: [valid.descriptor.scriptPubKey] })
      const candidates = result.vtxos.filter(
        (v) =>
          !v.isSpent &&
          !v.isSwept &&
          v.commitmentTxIds?.length &&
          v.expiresAt &&
          v.expiresAt.getTime() > Date.now() &&
          (!prior || (v.txid === prior.txid && v.vout === prior.vout)),
      )
      candidates.sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
      const coin = candidates[0]
      if (!coin) throw new Error('No active Spending output is available for renewal')
      let journal: RenewalJournal = prior ?? {
        version: 1,
        vaultId: valid.descriptor.vaultId,
        descriptorHash: lightDescriptorDigest(valid.descriptor),
        operationId: createVtxoOperationId(),
        txid: coin.txid,
        vout: coin.vout,
        stage: 'preparing',
      }
      saveRenewal(journal)
      const prepare = {
        vaultId: journal.vaultId,
        operationId: journal.operationId,
        txid: journal.txid,
        vout: journal.vout,
      }
      const prepared = validateLightRenewalPlan(
        await vaultCosignerClient.lightRenewal.prepare({
          ...prepare,
          ownerSignature: hex.encode(
            schnorr.sign(hex.decode(digest('vaulted-light/renewal-prepare/v1', prepare)), auth.phoneSecret),
          ),
        }),
        valid.descriptor,
      )
      const plan = prepared.plan
      if (
        plan.operationId !== journal.operationId ||
        plan.txid !== coin.txid ||
        plan.vout !== coin.vout ||
        plan.valueSats !== coin.value
      )
        throw new Error('Renewal input changed')
      journal = { ...journal, stage: 'prepared', plan: prepared }
      saveRenewal(journal)
      if (!(await approve(plan))) {
        const released = await vaultCosignerClient.lightRenewal.release(prepare)
        if (terminal(released.state)) localStorage.removeItem(journalKey(journal.vaultId))
        return released
      }
      if (plan.registerExpireAt * 1000 - Date.now() < 30_000)
        throw new Error('Renewal approval expired. Check this renewal before trying again.')
      progress('Renewing Spending. Keep this page open.')
      installVaultSettlementEventSource()
      const provider = new LightRenewalProvider(url, journal)
      const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
      registerLightContractHandler()
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
        hex.decode(valid.descriptor.operatorPub),
        script.tweakedPublicKey,
        networkPins(valid.descriptor.network).arkHrp,
      ).encode()
      // The SDK signer router signs only inputs belonging to a known contract.
      // Register the exact enrolled Light script before creating intent/forfeit proofs.
      await (await wallet.getContractManager()).createContract(lightContract(script, address))
      const input: ExtendedVirtualCoin = {
        ...coin,
        forfeitTapLeafScript: script.forfeit(),
        intentTapLeafScript: script.forfeit(),
        tapTree: script.encode(),
      }
      const session = identity.signerSession()
      const publicKey = hex.encode(await session.getPublicKey())
      const intent = await wallet.makeRegisterIntentSignature(
        [input],
        [{ amount: BigInt(plan.receiverSats), script: script.pkScript }],
        [],
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
      saveRenewal(journal)
      const registered = await vaultCosignerClient.lightRenewal.register({
        vaultId: journal.vaultId,
        operationId: journal.operationId,
        psbt: intent.proof,
        message: JSON.stringify(intent.message),
        assertion: auth.assertion,
        directSig: vtxoSpendDirectSig(auth, prepared.planDigest),
      })
      if (registered.state !== 'registered' || !registered.intentId)
        throw new Error('Renewal registration is still being checked. Check again before renewing.')
      journal = { ...journal, stage: 'registered' }
      saveRenewal(journal)
      const handler = wallet.createBatchHandler(
        registered.intentId,
        [input],
        [{ address, amount: plan.receiverSats }],
        session,
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
          throw new Error('Renewal recovery paths are incomplete')
        provider.finalEvidence = {
          batchId: event.id,
          batchExpiry,
          commitmentPsbt: event.commitmentTx,
          vtxoTree: serializeLightRenewalTree(tree, unsignedTree),
          connectors: flattenTree(connectors),
        }
        await finalize(event, tree, connectors)
      }
      await Batch.join(primed, handler, { abortController: abort })
      progress('Waiting for Bitcoin confirmation')
      const receipt = await vaultCosignerClient.lightRenewal.status(prepare)
      if (terminal(receipt.state)) localStorage.removeItem(journalKey(journal.vaultId))
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
