import { ArkAddress, P2A, RestIndexerProvider, Transaction, matchServerCheckpoints, type IWallet, type NetworkName } from '@arkade-os/sdk'
import {
  RefundNotLocallyPossibleError,
  RfqSwapManager,
  createRfqSwapRecord,
  isRfqSwapTerminal,
  lockupContractParams,
  rebuildRfqSwap,
  rfqSwapActivityInputs,
  rfqSecretsProfile,
  shouldRetainRfqSwap,
  type ArkadeRefundResult,
  type AssetSwapRepository,
  type InvoiceFacts,
  type LightningSendSwap,
  type LockupSpendIndexer,
  type RfqQuote,
  type RfqRestoreResult,
  type RfqRestoreFailure,
  type RfqSwap,
  type RfqSwapManagerConfig,
  type RfqSwapRecord,
  type RefundArkProvider,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { consoleError } from '../logs'
import {
  readLightningRecoveryAcknowledgment,
  readLightningRefundAttempt,
  recordRefundAttemptProgress,
  refundInputsFromSignedPsbt,
  refundPaymentTotal,
  readRetiredLightningFunding,
  type VaultLightningRefundAttempt,
  type VaultLightningRefundFacts,
  type VaultLightningRefundInput,
  validateLightningRefundFinals,
  validateLightningRefundGraph,
} from './lightningEvidence'
import { receiveProfile } from './lightningReceive'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import type { VaultLightningActivityRecord } from './history'
import type { LightningRequestResult } from './lightningValidation'

const VAULT_LIGHTNING_PROFILE = 'vaultLightning'
const VAULT_LIGHTNING_PROFILE_VERSION = 2
const VAULT_LIGHTNING_STORAGE_PREFIX = 'arkade-vault-v2'
const VAULT_LIGHTNING_REAUTHENTICATION_REQUIRED = 'Approve with passkey to return this payment to Spending.'

type VaultLightningManagerCallbacks = Parameters<RfqSwapManager['setCallbacks']>[0]

function observerRefundCapability(swap: { refundLocktime: number }, nowSeconds: () => number) {
  return nowSeconds() < swap.refundLocktime
    ? ({ ok: true } as const)
    : ({ ok: false, reason: VAULT_LIGHTNING_REAUTHENTICATION_REQUIRED } as const)
}

/** Keep the persistent observer useful without ever giving it signing authority. */
export function setVaultLightningObserverCallbacks(
  manager: Pick<RfqSwapManager, 'setCallbacks'>,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): void {
  manager.setCallbacks({
    canRefundArkade: async (swap) => observerRefundCapability(swap, nowSeconds),
    refundArkade: async () => {
      throw new RefundNotLocallyPossibleError('unsignable-wallet', VAULT_LIGHTNING_REAUTHENTICATION_REQUIRED)
    },
  })
}

/** The package callbacks installed only while an authenticated foreground operation holds the vault lock. */
export function setAuthenticatedVaultLightningRefundCallbacks(
  manager: Pick<RfqSwapManager, 'setCallbacks'>,
  rfqId: string,
  refundArkade: VaultLightningManagerCallbacks['refundArkade'],
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): void {
  manager.setCallbacks({
    canRefundArkade: async (swap) => (swap.rfqId === rfqId ? { ok: true } : observerRefundCapability(swap, nowSeconds)),
    refundArkade: async (swap) => {
      if (swap.rfqId !== rfqId) {
        throw new RefundNotLocallyPossibleError('unsignable-wallet', VAULT_LIGHTNING_REAUTHENTICATION_REQUIRED)
      }
      return refundArkade(swap)
    },
  })
}

/** Caller must hold the per-vault lifecycle Web Lock for this complete callback lifetime. */
export async function withAuthenticatedVaultLightningRefund<T>(
  manager: Pick<RfqSwapManager, 'setCallbacks' | 'poll' | 'getPendingSwaps' | 'removeSwap' | 'restoreFromRepository'>,
  rfqId: string,
  refundArkade: VaultLightningManagerCallbacks['refundArkade'],
  run: () => Promise<T>,
  nowSeconds?: () => number,
): Promise<T> {
  await refreshVaultLightningObserver(manager)
  setAuthenticatedVaultLightningRefundCallbacks(manager, rfqId, refundArkade, nowSeconds)
  try {
    await manager.poll()
    return await run()
  } finally {
    setVaultLightningObserverCallbacks(manager, nowSeconds)
  }
}

export interface VaultLightningQuote {
  kind: 'lightning'
  invoice: string
  invoiceAmountSats: number
  invoiceExpiresAt: number
  rfqId: string
  fundAddress: string
  fundAmountSats: number
  corridorFeeSats: number
  validUntil: number
  refundLocktime: number
}

export interface VaultLightningFundingTarget {
  rfqId: string
  address: string
  amountSats: number
}

export interface VaultLightningFundingProof extends VaultLightningFundingTarget {
  operationId: string
  bundleDigest: string
  /** Vault VTXO transaction fee. Missing only on records written before this field was introduced. */
  fundingFeeSats?: number
}

export type VaultLightningVtxoProof = Omit<VaultLightningFundingProof, 'rfqId'>

export class VaultLightningFundingNotStartedError extends Error {
  constructor() {
    super('Lightning funding has not started.')
    this.name = 'VaultLightningFundingNotStartedError'
  }
}

type VaultLightningFundingState = 'quoted' | 'funding' | 'cancel_requested'

export interface StoredVaultLightningProfile {
  version: 2
  network: NetworkName
  invoice: string
  quote: RfqQuote
  fundingState: VaultLightningFundingState
  fundingProof?: VaultLightningFundingProof
}

export function validFundingProof(value: unknown): value is VaultLightningFundingProof {
  const proof = value as Partial<VaultLightningFundingProof> | undefined
  return Boolean(
    proof &&
      /^[0-9a-f-]{16,}$/i.test(String(proof.operationId || '')) &&
      /^[0-9a-f]{64}$/.test(String(proof.bundleDigest || '')) &&
      typeof proof.address === 'string' &&
      proof.address.length > 0 &&
      Number.isSafeInteger(proof.amountSats) &&
      proof.amountSats! > 0 &&
      (proof.fundingFeeSats === undefined ||
        (Number.isSafeInteger(proof.fundingFeeSats) && proof.fundingFeeSats >= 0)) &&
      /^[0-9a-f]{64}$/.test(String(proof.rfqId || '')),
  )
}

function sameFundingProof(a: VaultLightningFundingProof | undefined, b: VaultLightningFundingProof): boolean {
  return Boolean(
    a &&
      a.rfqId === b.rfqId &&
      a.address === b.address &&
      a.amountSats === b.amountSats &&
      a.operationId === b.operationId &&
      a.bundleDigest === b.bundleDigest &&
      a.fundingFeeSats === b.fundingFeeSats,
  )
}

function recordClaimsPersistedFunding(record: RfqSwapRecord, invoice: string, network: NetworkName): boolean {
  const profile = record.profile[VAULT_LIGHTNING_PROFILE] as Partial<StoredVaultLightningProfile> | undefined
  return Boolean(
    profile?.invoice === invoice &&
      profile.network === network &&
      (profile.fundingState === 'funding' || record.fundingArkTxid),
  )
}

export interface VaultLightningSession {
  wallet: IWallet
  repository: AssetSwapRepository
  contracts: SwapContractRegistry
  manager: RfqSwapManager
  restoreFailures: RfqRestoreFailure[]
  retiredQuoteIds: string[]
  retirementFailures: { rfqId: string; error: Error }[]
}

export interface VaultLightningObserver {
  manager: RfqSwapManager
  restoreFailures: RfqRestoreFailure[]
  retiredQuoteIds: string[]
  retirementFailures: { rfqId: string; error: Error }[]
}

type VaultLightningObserverDeps = {
  contracts: SwapContractRegistry
  indexer: LockupSpendIndexer
  repository: AssetSwapRepository
  managerConfig?: RfqSwapManagerConfig
  vault?: { vaultId: string; network: string }
}

/** Construct the page-local package manager without reading or writing shared state. */
export function createVaultLightningObserver({
  contracts,
  indexer,
  repository,
  managerConfig,
  vault,
}: VaultLightningObserverDeps): RfqSwapManager {
  // Incoming claims use verified payout receipts and retain their recovery
  // records. The package's send observer must not resolve or prune them.
  // Funded send terminals past package retention stay hidden until the
  // payment owner acknowledges them; the owner still sees the full store.
  const nowSeconds = managerConfig?.now ?? (() => Math.floor(Date.now() / 1000))
  const manager = new RfqSwapManager(
    {
      indexer,
      contracts,
      repository: {
        getAllRfqSwaps: async () =>
          (await repository.getAllRfqSwaps()).filter(
            (r) => r.kind !== 'lightning_receive' && !isWithheldFundedLightningRecord(r, nowSeconds(), vault),
          ),
        getRfqSwap: (id) => repository.getRfqSwap(id),
        saveRfqSwap: (record) => repository.saveRfqSwap(record),
        removeRfqSwap: (id) => repository.removeRfqSwap(id),
      },
    },
    { ...managerConfig, enableAutoActions: true },
  )
  setVaultLightningObserverCallbacks(manager, managerConfig?.now)
  return manager
}

/**
 * Rebuild one page-local manager from the durable package repository before
 * every pass. Managers are intentionally not started: their internal timers
 * cannot coordinate repository writes made by another browser tab.
 */
export async function refreshVaultLightningObserver(
  manager: Pick<RfqSwapManager, 'getPendingSwaps' | 'removeSwap' | 'restoreFromRepository' | 'poll'>,
): Promise<RfqRestoreResult> {
  for (const swap of await manager.getPendingSwaps()) await manager.removeSwap(swap.rfqId)
  const restored = await manager.restoreFromRepository()
  await manager.poll()
  return restored
}

/** Caller coordinates this complete maintenance pass with the per-vault Web Lock. */
export async function maintainVaultLightningObserver({
  manager,
  contracts,
  indexer,
  repository,
  nowSeconds,
}: {
  manager: RfqSwapManager
  contracts: SwapContractRegistry
  indexer: LockupSpendIndexer
  repository: AssetSwapRepository
  nowSeconds?: number
}): Promise<Omit<VaultLightningObserver, 'manager'>> {
  const retired = await retireAbandonedVaultLightningQuotes(repository, contracts, nowSeconds)
  await reconcileVaultLightningFundingTxids(repository, indexer)
  const restored = await refreshVaultLightningObserver(manager)
  return {
    restoreFailures: restored.failed,
    retiredQuoteIds: retired.retired,
    retirementFailures: retired.failed,
  }
}

export function vaultLightningSwapStorageName(vaultId: string): string {
  const id = String(vaultId || '').trim()
  if (!id) throw new Error('vault id required for Lightning storage')
  return `${VAULT_LIGHTNING_STORAGE_PREFIX}:${encodeURIComponent(id)}:rfq-swaps`
}

export function storedLightningProfile(record: RfqSwapRecord): StoredVaultLightningProfile {
  const value = record.profile[VAULT_LIGHTNING_PROFILE] as Partial<StoredVaultLightningProfile> | undefined
  const quote = value?.quote
  if (
    record.kind !== 'lightning_send' ||
    !value ||
    value.version !== VAULT_LIGHTNING_PROFILE_VERSION ||
    typeof value.invoice !== 'string' ||
    !quote ||
    quote.rfq_id !== record.rfqId ||
    !Number.isSafeInteger(quote.to_amount) ||
    !Number.isSafeInteger(quote.from_amount) ||
    !Number.isSafeInteger(quote.valid_until) ||
    !Number.isSafeInteger(quote.refund_locktime) ||
    !Number.isSafeInteger(record.amount) ||
    quote.from_amount !== record.amount ||
    !['quoted', 'funding', 'cancel_requested'].includes(String(value.fundingState)) ||
    (value.fundingState === 'funding' && !validFundingProof(value.fundingProof))
  ) {
    throw new Error(`Stored Lightning quote ${record.rfqId} is incomplete`)
  }
  if (!['bitcoin', 'testnet', 'signet', 'mutinynet', 'regtest'].includes(String(value.network))) {
    throw new Error(`Stored Lightning quote ${record.rfqId} has no network`)
  }
  const invoice = decodeVaultLightningInvoice(value.invoice, value.network as NetworkName, 0)
  if (quote.to_amount !== invoice.amountSats) {
    throw new Error(`Stored Lightning quote ${record.rfqId} does not match its invoice`)
  }
  return value as StoredVaultLightningProfile
}

function quoteFromRecord(record: RfqSwapRecord): VaultLightningQuote {
  const stored = storedLightningProfile(record)
  const invoice = decodeVaultLightningInvoice(stored.invoice, stored.network, 0)
  const fundAmountSats = record.amount!
  return {
    kind: 'lightning',
    invoice: stored.invoice,
    invoiceAmountSats: invoice.amountSats,
    invoiceExpiresAt: invoice.expiresAt,
    rfqId: record.rfqId,
    fundAddress: record.lockupAddress,
    fundAmountSats,
    corridorFeeSats: fundAmountSats - invoice.amountSats,
    validUntil: stored.quote.valid_until,
    refundLocktime: stored.quote.refund_locktime!,
  }
}

async function retireStoredLightningQuote(
  repository: Pick<AssetSwapRepository, 'removeRfqSwap'>,
  contracts: Pick<SwapContractRegistry, 'setContractWatchState'>,
  record: RfqSwapRecord,
): Promise<Error | undefined> {
  const stored = storedLightningProfile(record)
  if (stored.fundingState === 'funding' || record.fundingArkTxid) {
    throw new Error(`Funded Lightning payment ${record.rfqId} cannot be retired`)
  }

  let contractError: unknown
  try {
    const contractScript = hex.encode(ArkAddress.decode(record.lockupAddress).pkScript)
    await contracts.setContractWatchState(contractScript, 'retained')
  } catch (error) {
    contractError = error
  }

  let removalError: unknown
  try {
    // The RFQ record is the authoritative retry trigger. Once an unfunded
    // quote is abandoned or cancelled it must be removed even when its old
    // contract row was never written, was cleared, or now lives elsewhere.
    await repository.removeRfqSwap(record.rfqId)
  } catch (error) {
    removalError = error
  }

  if (contractError !== undefined && removalError !== undefined) {
    throw new AggregateError([contractError, removalError], `Lightning quote ${record.rfqId} cleanup failed`)
  }
  if (removalError !== undefined) throw removalError
  return contractError === undefined
    ? undefined
    : contractError instanceof Error
      ? contractError
      : new Error(String(contractError))
}

export async function retireAbandonedVaultLightningQuotes(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps' | 'removeRfqSwap'>,
  contracts: Pick<SwapContractRegistry, 'setContractWatchState'>,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ retired: string[]; failed: { rfqId: string; error: Error }[] }> {
  const retired: string[] = []
  const failed: { rfqId: string; error: Error }[] = []
  for (const record of await repository.getAllRfqSwaps()) {
    let stored: StoredVaultLightningProfile
    try {
      stored = storedLightningProfile(record)
    } catch (error) {
      if (record.kind === 'lightning_send') {
        failed.push({ rfqId: record.rfqId, error: error instanceof Error ? error : new Error(String(error)) })
      }
      continue
    }
    if (
      stored.fundingState !== 'cancel_requested' &&
      !(stored.fundingState === 'quoted' && nowSeconds >= stored.quote.valid_until)
    ) {
      continue
    }
    try {
      const retirementError = await retireStoredLightningQuote(repository, contracts, record)
      retired.push(record.rfqId)
      if (retirementError) failed.push({ rfqId: record.rfqId, error: retirementError })
    } catch (error) {
      failed.push({ rfqId: record.rfqId, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return { retired, failed }
}

export async function discardUnexposedVaultLightningQuote(
  repository: Pick<AssetSwapRepository, 'removeRfqSwap'>,
  contracts: Pick<SwapContractRegistry, 'setContractWatchState'>,
  manager: RfqSwapManager,
  rfqId: string,
  contractScript: string | undefined,
  primaryError: unknown,
): Promise<never> {
  const cleanupTasks = [manager.removeSwap(rfqId), repository.removeRfqSwap(rfqId)]
  if (contractScript) cleanupTasks.push(contracts.setContractWatchState(contractScript, 'retained'))
  const cleanup = await Promise.allSettled(cleanupTasks)
  const cleanupErrors: unknown[] = contractScript
    ? []
    : [new Error('Registered Lightning contract could not be identified')]
  cleanupErrors.push(
    ...cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason),
  )
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'Lightning quote persistence and cleanup failed')
  }
  throw primaryError
}

export async function restorePersistedVaultLightningQuote(
  repository: Pick<AssetSwapRepository, 'getRfqSwap'>,
  contracts: SwapContractRegistry,
  manager: RfqSwapManager,
  rfqId: string,
  invoice: string,
  network: NetworkName,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VaultLightningQuote | undefined> {
  const record = await repository.getRfqSwap(rfqId)
  if (!record) return undefined
  const stored = storedLightningProfile(record)
  if (stored.network !== network) throw new Error(`Lightning request ${rfqId} belongs to another network.`)
  if (stored.invoice !== invoice) throw new Error(`Lightning request ${rfqId} belongs to another invoice.`)
  if (stored.fundingState === 'cancel_requested') throw new Error('This Lightning quote was cancelled.')
  if (isRfqSwapTerminal(record.state)) throw new Error('This Lightning payment is already resolved.')
  if (stored.fundingState === 'funding' || record.fundingArkTxid) {
    throw new Error('This Lightning payment is already processing and cannot be funded again.')
  }
  assertVaultLightningQuoteCurrent(quoteFromRecord(record), nowSeconds)
  const params = await lockupContractParams(contracts, record.lockupAddress)
  const swap = rebuildRfqSwap(record, params)
  if (!(await manager.hasSwap(rfqId))) await manager.addSwap(swap)
  return quoteFromRecord(record)
}

export async function restoreMatchingVaultLightningQuote(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps' | 'getRfqSwap'>,
  contracts: SwapContractRegistry,
  manager: RfqSwapManager,
  invoice: string,
  network: NetworkName,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VaultLightningQuote | undefined> {
  const candidates = (await repository.getAllRfqSwaps())
    .filter((record) => record.kind === 'lightning_send' && !isRfqSwapTerminal(record.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const record of candidates) {
    // Even a damaged record still carries enough public identity to prevent a
    // second payment of the same invoice after durable funding began.
    if (recordClaimsPersistedFunding(record, invoice, network)) {
      throw new Error('This Lightning payment is already processing and cannot be funded again.')
    }
    let stored: StoredVaultLightningProfile
    try {
      stored = storedLightningProfile(record)
    } catch {
      // Repository restoration is per record. A corrupt abandoned quote must
      // not disable every future Lightning payment in this vault.
      continue
    }
    if (stored.network !== network || stored.invoice !== invoice || stored.fundingState === 'cancel_requested') continue
    // A payment that already crossed the durable funding boundary is not a
    // stale quote and must continue to block duplicate funding.
    if (stored.fundingState === 'funding' || record.fundingArkTxid) {
      throw new Error('This Lightning payment is already processing and cannot be funded again.')
    }
    try {
      return await restorePersistedVaultLightningQuote(
        repository,
        contracts,
        manager,
        record.rfqId,
        invoice,
        network,
        nowSeconds,
      )
    } catch {
      // An expired quote or one whose contract can no longer be reconstructed
      // is isolated just like RfqSwapManager.restoreFromRepository failures.
      continue
    }
  }
  return undefined
}

/** Resume only the exact VTXO reservation that already entered funding. */
export async function restoreMatchingVaultLightningFundingQuote(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps' | 'getRfqSwap'>,
  contracts: SwapContractRegistry,
  manager: RfqSwapManager,
  invoice: string,
  network: NetworkName,
  proof: VaultLightningVtxoProof,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VaultLightningQuote | undefined> {
  const candidates = (await repository.getAllRfqSwaps())
    .filter((record) => record.kind === 'lightning_send' && !record.fundingArkTxid && !isRfqSwapTerminal(record.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const record of candidates) {
    let stored: StoredVaultLightningProfile
    try {
      stored = storedLightningProfile(record)
    } catch {
      continue
    }
    if (stored.network !== network || stored.invoice !== invoice || stored.fundingState !== 'funding') continue
    const expected = { ...proof, rfqId: record.rfqId }
    if (!sameFundingProof(stored.fundingProof, expected)) continue
    assertVaultLightningQuoteCurrent(quoteFromRecord(record), nowSeconds)
    const params = await lockupContractParams(contracts, record.lockupAddress)
    const swap = rebuildRfqSwap(record, params)
    if (!(await manager.hasSwap(record.rfqId))) await manager.addSwap(swap)
    return quoteFromRecord(record)
  }
  return undefined
}

/** Read the original invoice and quote for an existing funding operation, without negotiating again.
 * Expiry gates new authorization; it must not hide an already-authorized transaction's recovery path.
 */
export async function loadVaultLightningFundingQuote(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps'>,
  network: NetworkName,
  proof: VaultLightningVtxoProof,
): Promise<VaultLightningQuote | undefined> {
  const matches = (await repository.getAllRfqSwaps()).filter((record) => {
    if (record.kind !== 'lightning_send') return false
    const raw = record.profile[VAULT_LIGHTNING_PROFILE] as Partial<StoredVaultLightningProfile> | undefined
    if (raw?.fundingProof?.operationId !== proof.operationId) return false
    const stored = storedLightningProfile(record)
    if (
      stored.network !== network ||
      stored.fundingState !== 'funding' ||
      !sameFundingProof(stored.fundingProof, { ...proof, rfqId: record.rfqId })
    ) {
      throw new Error('Lightning funding does not match the persisted VTXO reservation.')
    }
    return true
  })
  if (matches.length > 1) throw new Error('Multiple Lightning records refer to this payment. Recovery needs review.')
  return matches[0] ? quoteFromRecord(matches[0]) : undefined
}

export async function persistVaultLightningQuote({
  result,
  facts,
  refundLocktime,
  contractParams,
  repository,
  manager,
  network,
  nowSeconds,
}: {
  result: LightningRequestResult
  facts: InvoiceFacts
  refundLocktime: number
  contractParams: Record<string, string>
  repository: AssetSwapRepository
  manager: RfqSwapManager
  network: NetworkName
  nowSeconds: number
}): Promise<VaultLightningQuote> {
  const stored: StoredVaultLightningProfile = {
    version: VAULT_LIGHTNING_PROFILE_VERSION,
    network,
    invoice: facts.raw,
    quote: result.quote,
    fundingState: 'quoted',
  }
  const swap: LightningSendSwap = {
    kind: 'lightning_send',
    rfqId: result.rfqId,
    state: 'pending',
    lockupPkScript: result.swapPkScript,
    lockup: { script: result.script, address: result.address },
    paymentHash: facts.paymentHash,
    refundLocktime,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
  }
  const origin = {
    kind: 'lightning_send' as const,
    lockupAddress: result.address,
    amount: result.fundAmount,
    profile: {
      ...rfqSecretsProfile(result.secrets, facts.paymentHash),
      [VAULT_LIGHTNING_PROFILE]: stored,
    },
  }
  await repository.saveRfqSwap(createRfqSwapRecord(origin, swap))
  const persisted = await repository.getRfqSwap(result.rfqId)
  if (!persisted) throw new Error('Lightning recovery record was not durably stored.')
  const rebuilt = rebuildRfqSwap(persisted, contractParams)
  await manager.addSwap(rebuilt)
  return quoteFromRecord(persisted)
}

export async function beginVaultLightningFunding(
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'saveRfqSwap'>,
  rfqId: string,
  fundingProof: VaultLightningFundingProof,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VaultLightningFundingTarget> {
  const record = await repository.getRfqSwap(rfqId)
  if (!record) throw new Error('Lightning recovery record is missing. Do not fund this quote.')
  if (isRfqSwapTerminal(record.state)) throw new Error('This Lightning payment is already resolved.')
  const stored = storedLightningProfile(record)
  if (stored.fundingState === 'cancel_requested') throw new Error('This Lightning quote was cancelled.')
  if (stored.fundingState === 'funding' || record.fundingArkTxid) {
    throw new Error('This Lightning payment is already processing and cannot be funded again.')
  }
  if (
    !validFundingProof(fundingProof) ||
    fundingProof.fundingFeeSats === undefined ||
    fundingProof.rfqId !== rfqId ||
    fundingProof.address !== record.lockupAddress ||
    fundingProof.amountSats !== record.amount
  ) {
    throw new Error('Lightning funding does not match the reviewed VTXO reservation.')
  }
  assertVaultLightningQuoteCurrent(quoteFromRecord(record), nowSeconds)
  await repository.saveRfqSwap({
    ...record,
    profile: {
      ...record.profile,
      [VAULT_LIGHTNING_PROFILE]: { ...stored, fundingState: 'funding', fundingProof },
    },
  })
  const persisted = await repository.getRfqSwap(rfqId)
  if (!persisted || storedLightningProfile(persisted).fundingState !== 'funding') {
    throw new Error('Lightning funding permission was not durably stored. Do not fund this quote.')
  }
  return { rfqId, address: record.lockupAddress, amountSats: record.amount! }
}

export async function resumeVaultLightningFunding(
  repository: Pick<AssetSwapRepository, 'getRfqSwap'>,
  proof: VaultLightningFundingProof,
  nowSeconds = Math.floor(Date.now() / 1000),
  alreadyAuthorized = false,
): Promise<VaultLightningFundingTarget> {
  const record = await repository.getRfqSwap(proof.rfqId)
  if (!record || record.fundingArkTxid || isRfqSwapTerminal(record.state)) {
    throw new Error('This Lightning payment cannot be resumed.')
  }
  const stored = storedLightningProfile(record)
  if (stored.fundingState === 'quoted') throw new VaultLightningFundingNotStartedError()
  if (stored.fundingState !== 'funding' || !sameFundingProof(stored.fundingProof, proof)) {
    throw new Error('Lightning funding does not match the persisted VTXO reservation.')
  }
  if (!alreadyAuthorized) assertVaultLightningQuoteCurrent(quoteFromRecord(record), nowSeconds)
  return { rfqId: record.rfqId, address: record.lockupAddress, amountSats: record.amount! }
}

export async function recordVaultLightningFundingTxid(
  repository: Pick<AssetSwapRepository, 'getRfqSwap' | 'saveRfqSwap'>,
  rfqId: string,
  fundingArkTxid: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(fundingArkTxid)) throw new Error('Lightning funding transaction id is invalid.')
  const record = await repository.getRfqSwap(rfqId)
  if (!record) throw new Error('Lightning recovery record is missing.')
  const stored = storedLightningProfile(record)
  if (stored.fundingState !== 'funding') throw new Error('Lightning funding was not prepared.')
  if (record.fundingArkTxid && record.fundingArkTxid !== fundingArkTxid) {
    throw new Error('Lightning quote is already bound to another funding transaction.')
  }
  await repository.saveRfqSwap({ ...record, fundingArkTxid })
  const persisted = await repository.getRfqSwap(rfqId)
  if (persisted?.fundingArkTxid !== fundingArkTxid) {
    throw new Error('Lightning funding transaction was not durably stored.')
  }
}

/**
 * Recover a funding txid only when the published swap activity resolver finds
 * one unambiguous transaction for the exact persisted lockup contract.
 *
 * The manager does not need this txid to protect or refund the lockup: it
 * watches by script. Persisting it makes history and receipts converge after a
 * broadcast response is lost. Multiple observed txids are deliberately left
 * to the manager/activity resolver rather than guessing which one funded it.
 */
export async function reconcileVaultLightningFundingTxids(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps' | 'getRfqSwap' | 'saveRfqSwap'>,
  indexer: Pick<RestIndexerProvider, 'getVtxos' | 'getVirtualTxs'>,
): Promise<string[]> {
  const records = await repository.getAllRfqSwaps()
  const unresolved = records.filter((record) => {
    if (record.kind !== 'lightning_send' || record.fundingArkTxid) return false
    try {
      return storedLightningProfile(record).fundingState === 'funding'
    } catch {
      return false
    }
  })
  if (unresolved.length === 0) return []

  const activityById = new Map(
    (
      await rfqSwapActivityInputs({
        repository: { getAllRfqSwaps: async () => unresolved },
        indexer,
      })
    ).map((activity) => [activity.rfqId, activity]),
  )
  const recovered: string[] = []
  for (const unresolvedRecord of unresolved) {
    const candidates = [...new Set(activityById.get(unresolvedRecord.rfqId)?.txids ?? [])]
    if (candidates.length !== 1 || !/^[0-9a-f]{64}$/.test(candidates[0])) continue

    const current = await repository.getRfqSwap(unresolvedRecord.rfqId)
    if (!current) continue
    if (current.fundingArkTxid) {
      if (current.fundingArkTxid !== candidates[0]) continue
      recovered.push(current.rfqId)
      continue
    }
    if (storedLightningProfile(current).fundingState !== 'funding') continue
    await repository.saveRfqSwap({ ...current, fundingArkTxid: candidates[0] })
    const persisted = await repository.getRfqSwap(current.rfqId)
    if (persisted?.fundingArkTxid !== candidates[0]) {
      throw new Error(`Recovered Lightning funding transaction for ${current.rfqId} was not durably stored`)
    }
    recovered.push(current.rfqId)
  }
  return recovered
}

export async function cancelVaultLightningQuote(
  session: Pick<VaultLightningSession, 'repository' | 'contracts' | 'manager'>,
  rfqId: string,
): Promise<boolean> {
  const record = await session.repository.getRfqSwap(rfqId)
  if (!record) return false
  const stored = storedLightningProfile(record)
  if (stored.fundingState === 'funding' || record.fundingArkTxid) {
    throw new Error('Lightning funding has started. This payment must resolve or refund.')
  }
  if (isRfqSwapTerminal(record.state)) throw new Error('This Lightning payment is already resolved.')
  if (stored.fundingState !== 'cancel_requested') {
    await session.repository.saveRfqSwap({
      ...record,
      profile: {
        ...record.profile,
        [VAULT_LIGHTNING_PROFILE]: { ...stored, fundingState: 'cancel_requested' },
      },
    })
  }
  await session.manager.removeSwap(rfqId)
  const current = await session.repository.getRfqSwap(rfqId)
  if (!current) return true
  const retirementError = await retireStoredLightningQuote(session.repository, session.contracts, current)
  if (retirementError) {
    // The record deletion is authoritative. A missing old contract must not
    // make a completed cancellation look failed or leave the quote retrying.
    consoleError(retirementError, `Lightning quote ${rfqId} contract retirement failed after cancellation`)
  }
  return true
}

export async function listVaultLightningActivityRecords(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps'>,
): Promise<VaultLightningActivityRecord[]> {
  const records: VaultLightningActivityRecord[] = []
  for (const record of await repository.getAllRfqSwaps()) {
    try {
      if (record.kind === 'lightning_receive') {
        const receive = receiveProfile(record)
        if (!receive.claim) continue
        records.push({
          rfqId: record.rfqId,
          fundingTxid: receive.claim.txid,
          type: 'received',
          state: record.state,
          amount: record.amount!,
          displayAmount: record.amount!,
          fee: receive.quote.from_amount - record.amount!,
          createdAt: record.createdAt,
          terminal: record.state === 'settled',
        })
        continue
      }
      if (record.kind !== 'lightning_send' || !record.fundingArkTxid) continue
      const quote = quoteFromRecord(record)
      const stored = storedLightningProfile(record)
      records.push({
        rfqId: record.rfqId,
        fundingTxid: record.fundingArkTxid,
        state: record.state,
        amount: quote.fundAmountSats,
        displayAmount: quote.invoiceAmountSats,
        fee: quote.corridorFeeSats + (stored.fundingProof?.fundingFeeSats || 0),
        createdAt: record.createdAt,
        terminal: isRfqSwapTerminal(record.state),
      })
    } catch {
      // One stale record must not block the persistent wallet's activity feed.
    }
  }
  return records
}

export function getVaultLightningStatus(
  repository: Pick<AssetSwapRepository, 'getRfqSwap'>,
  rfqId: string,
): Promise<RfqSwapRecord | undefined> {
  return repository.getRfqSwap(rfqId)
}

export function assertVaultLightningQuoteCurrent(
  quote: VaultLightningQuote,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (nowSeconds >= quote.invoiceExpiresAt) throw new Error('This Lightning invoice has expired.')
  if (nowSeconds >= quote.validUntil) throw new Error('This Lightning quote has expired. Return to Send and try again.')
}

export type { VaultLightningRetiredFunding } from './lightningEvidence'
export { readLightningRecoveryAcknowledgment, readRetiredLightningFunding }

/** A funded record carries Vaulted money movement that package age-based
 * pruning must never delete without owner acknowledgment. */
export function isFundedLightningRecord(record: RfqSwapRecord): boolean {
  if (typeof record.fundingArkTxid === 'string' && record.fundingArkTxid) return true
  try {
    return storedLightningProfile(record).fundingState === 'funding'
  } catch {
    return false
  }
}

/** Funded terminals past package retention stay enumerated to the manager
 * only while a matching retirement receipt exists. Unfunded quotes, active
 * swaps and recent terminals keep their existing visibility exactly. */
export function isWithheldFundedLightningRecord(
  record: RfqSwapRecord,
  nowSeconds: number,
  vault?: { vaultId: string; network: string },
): boolean {
  if (record.kind !== 'lightning_send' || shouldRetainRfqSwap(record, nowSeconds)) return false
  if (!isFundedLightningRecord(record)) return false
  const receipt = readRetiredLightningFunding(record.rfqId)
  if (!receipt) return true
  return !(
    receipt.lockupAddress === record.lockupAddress &&
    receipt.amountSats === record.amount &&
    receipt.fundingArkTxid === record.fundingArkTxid &&
    receipt.state === record.state &&
    (!vault || (receipt.vaultId === vault.vaultId && receipt.network === vault.network))
  )
}

/** Funded terminal records awaiting owner retirement. Cheap enumeration for
 * settle scheduling; the full predicate runs per record on acknowledgment. */
export async function listFundedTerminalLightningRecords(
  repository: Pick<AssetSwapRepository, 'getAllRfqSwaps'>,
): Promise<string[]> {
  const out: string[] = []
  for (const record of await repository.getAllRfqSwaps()) {
    if (record.kind !== 'lightning_send' || !isRfqSwapTerminal(record.state)) continue
    if (!isFundedLightningRecord(record)) continue
    out.push(record.rfqId)
  }
  return out
}

/** Best-effort retirement sweeps live in the operation owner; this module
 * keeps observation, funded-record gating and refund dispatch durability. */

function validRefundPsbtList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

export function recordingVaultLightningRefundArk(
  base: Pick<RefundArkProvider, 'getInfo' | 'submitTx' | 'finalizeTx'>,
  facts: VaultLightningRefundFacts,
  signal?: AbortSignal,
): Pick<RefundArkProvider, 'getInfo' | 'submitTx' | 'finalizeTx'> {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'submitTx') {
        return async (signedRefundPsbt: string, checkpoints: string[]) => {
          signal?.throwIfAborted()
          if (typeof signedRefundPsbt !== 'string' || !signedRefundPsbt || !validRefundPsbtList(checkpoints)) {
            throw new Error('Lightning refund submission is malformed.')
          }
          // Validate the complete package graph before dispatch: the unsigned
          // checkpoints spend the original lockup outpoints, and the signed
          // refund spends exactly those checkpoint outputs at index 0, plus
          // the SDK-added zero-value P2A anchor. The payment output carries
          // the full funded sum.
          const unsignedCheckpoints = checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)))
          const fundedInputs: VaultLightningRefundInput[] = []
          for (const checkpoint of unsignedCheckpoints) {
            for (let index = 0; index < checkpoint.inputsLength; index++) {
              const input = checkpoint.getInput(index)
              const txid = input.txid?.length ? hex.encode(input.txid) : ''
              if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(input.index)) {
                throw new Error('Lightning refund checkpoint input is incomplete.')
              }
              const amount = input.witnessUtxo?.amount
              fundedInputs.push({
                txid,
                vout: input.index as number,
                value: typeof amount === 'bigint' ? Number(amount) : null,
              })
            }
          }
          if (!fundedInputs.length) throw new Error('Lightning refund has no funded inputs.')
          const derived = refundInputsFromSignedPsbt(signedRefundPsbt)
          const checkpointIds = new Set(unsignedCheckpoints.map((checkpoint) => checkpoint.id))
          if (derived.inputs.length !== unsignedCheckpoints.length) {
            throw new Error('Lightning refund does not spend every checkpoint.')
          }
          for (const input of derived.inputs) {
            if (input.vout !== 0 || !checkpointIds.has(input.txid)) {
              throw new Error('Lightning refund input is not a checkpoint output.')
            }
          }
          const paymentOutputs = Transaction.fromPSBT(base64.decode(signedRefundPsbt))
          const anchorScriptHex = hex.encode(P2A.script)
          let paymentTotal = 0n
          let anchors = 0
          for (let index = 0; index < paymentOutputs.outputsLength; index++) {
            const output = paymentOutputs.getOutput(index)
            if (!output || !output.script) throw new Error('Lightning refund output is incomplete.')
            if (hex.encode(output.script) === anchorScriptHex) {
              if (output.amount !== P2A.amount) throw new Error('Lightning refund anchor is not zero-value.')
              anchors++
              continue
            }
            paymentTotal += output.amount ?? 0n
          }
          if (anchors !== 1) throw new Error('Lightning refund must carry exactly one P2A anchor.')
          const fundedTotal = fundedInputs.every((input) => typeof input.value === 'number')
            ? fundedInputs.reduce((total, input) => total + BigInt(input.value ?? 0), 0n)
            : null
          if (fundedTotal !== null && paymentTotal !== fundedTotal) {
            throw new Error('Lightning refund output does not match its funded inputs.')
          }
          // The complete pre-submit graph, including the sender's exact
          // tapscript signatures over the enrolled key, validates before
          // anything persists or dispatches.
          const progress = {
            ...facts,
            fundedInputs,
            signedRefundPsbt,
            submittedRefundTxid: derived.txid,
            submittedCheckpointPsbts: [...checkpoints],
            refundOutputSats: Number(paymentTotal),
          }
          validateLightningRefundGraph({ ...progress, stage: 'submitted', updatedAt: Math.floor(Date.now() / 1000) })
          recordRefundAttemptProgress(progress, 'submitted')
          const submitted = await target.submitTx(signedRefundPsbt, checkpoints)
          if (submitted.arkTxid !== derived.txid) {
            throw new Error('Lightning refund submission transaction changed.')
          }
          const serverRefundPsbt =
            typeof submitted.finalArkTx === 'string' && submitted.finalArkTx ? submitted.finalArkTx : undefined
          if (serverRefundPsbt) {
            const serverRefund = Transaction.fromPSBT(base64.decode(serverRefundPsbt))
            if (serverRefund.id !== derived.txid) {
              throw new Error('Lightning refund Operator response changed the transaction.')
            }
          }
          recordRefundAttemptProgress(
            {
              ...facts,
              fundedInputs,
              signedRefundPsbt,
              submittedRefundTxid: derived.txid,
              submittedCheckpointPsbts: [...checkpoints],
              refundOutputSats: Number(paymentTotal),
              serverCheckpointPsbts: [...submitted.signedCheckpointTxs],
              ...(serverRefundPsbt ? { serverRefundPsbt } : {}),
            },
            'submitted',
          )
          return submitted
        }
      }
      if (property === 'finalizeTx') {
        return async (arkTxid: string, checkpoints: string[]) => {
          signal?.throwIfAborted()
          if (!/^[0-9a-f]{64}$/.test(arkTxid) || !validRefundPsbtList(checkpoints)) {
            throw new Error('Lightning refund finalization is malformed.')
          }
          // A final checkpoint is a signature over the recorded unsigned
          // twin by the enrolled sender and Operator, never a replacement
          // graph: validate before persisting or releasing.
          const previous = readLightningRefundAttempt(facts.rfqId)
          validateLightningRefundFinals(
            previous?.submittedCheckpointPsbts,
            checkpoints,
            facts.senderPub,
            facts.serverPub,
          )
          recordRefundAttemptProgress({ ...facts, finalCheckpointPsbts: [...checkpoints] }, 'finalized')
          return await target.finalizeTx(arkTxid, checkpoints)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Durable boundary around the package refund dispatch.
 *
 * Persists the exact attempt before dispatch so a lost response resumes the
 * same attempt instead of allocating a new one, and replays an observed
 * result without re-dispatching. Dispatch never starts after cancellation.
 * A retry first re-reads the current funded inputs and refuses to proceed
 * when they differ from the retained set, and any observed transaction that
 * is not the retained one is rejected rather than stored. Signed submission
 * and checkpoint bytes are captured by the recording Operator surface; this
 * wrapper owns identity, result caching and the attempt lifecycle around it. */
/** The Operator surface a durable refund replay drives. `submitRefund`
 * reports the Operator-signed successor alongside the signed checkpoints;
 * resume persists both before signing so a lost response never resubmits. */
export interface VaultLightningRefundRecorder {
  submitRefund: (
    signedPsbt: string,
    checkpoints: string[],
  ) => Promise<{ arkTxid: string; signedCheckpointTxs: string[]; finalArkTx?: string }>
  signCheckpoint: (checkpointPsbt: string) => Promise<string>
  finalizeRefund: (arkTxid: string, checkpoints: string[]) => Promise<void>
}

export function durableVaultLightningRefund(
  facts: VaultLightningRefundFacts,
  inner: (swap: RfqSwap) => Promise<ArkadeRefundResult>,
  options: {
    signal?: AbortSignal
    record: VaultLightningRefundRecorder
  },
): (swap: RfqSwap) => Promise<ArkadeRefundResult> {
  return async (swap) => {
    options.signal?.throwIfAborted()
    if (swap.rfqId !== facts.rfqId) throw new Error('Lightning refund attempt changed operation.')
    if (hex.encode(swap.lockupPkScript) !== facts.lockupPkScriptHex) {
      throw new Error('Lightning refund lockup changed.')
    }
    const previous = readLightningRefundAttempt(facts.rfqId)
    if (previous) {
      if (
        previous.lockupAddress !== facts.lockupAddress ||
        previous.lockupPkScriptHex !== facts.lockupPkScriptHex ||
        previous.amountSats !== facts.amountSats ||
        previous.destination !== facts.destination ||
        previous.senderPub !== facts.senderPub ||
        previous.serverPub !== facts.serverPub ||
        (previous.vaultId !== undefined && previous.vaultId !== facts.vaultId) ||
        (previous.network !== undefined && previous.network !== facts.network)
      ) {
        throw new Error('Lightning refund inputs changed.')
      }
      if (previous.stage === 'result' && previous.refundArkTxid) {
        return { arkTxid: previous.refundArkTxid, amount: previous.resultAmount ?? previous.amountSats }
      }
      if (previous.signedRefundPsbt && previous.submittedCheckpointPsbts?.length) {
        return resumeRecordedRefund(facts, swap, previous, options)
      }
    } else {
      recordRefundAttemptProgress(facts, 'dispatched')
    }
    options.signal?.throwIfAborted()
    const result = await inner(swap)
    if (!result) return result
    if (!/^[0-9a-f]{64}$/.test(result.arkTxid)) throw new Error('Lightning refund transaction id is invalid.')
    if (!Number.isSafeInteger(result.amount) || result.amount < 0) {
      throw new Error('Lightning refund result amount is invalid.')
    }
    if (previous?.submittedRefundTxid && result.arkTxid !== previous.submittedRefundTxid) {
      throw new Error('Lightning refund transaction changed.')
    }
    recordRefundAttemptProgress({ ...facts, refundArkTxid: result.arkTxid, resultAmount: result.amount }, 'result')
    return result
  }
}

/** Resume recorded bytes without rebuilding: replay the latest durable
 * phase instead of restarting. An observed Operator response is never
 * resubmitted; recorded final checkpoints are never re-signed. Each phase
 * persists before dispatch so a response lost after landing still resumes
 * forward. Works with empty live inputs because nothing is re-derived; a
 * changed transaction can never replace the retained bytes. */
async function resumeRecordedRefund(
  facts: VaultLightningRefundFacts,
  swap: RfqSwap,
  previous: VaultLightningRefundAttempt,
  options: {
    signal?: AbortSignal
    record: VaultLightningRefundRecorder
  },
): Promise<ArkadeRefundResult> {
  const signedRefundPsbt = previous.signedRefundPsbt!
  const submittedCheckpointPsbts = previous.submittedCheckpointPsbts!
  options.signal?.throwIfAborted()
  // Replay nothing corrupt: the recorded graph, with exact enrolled
  // signatures, validates before any resubmit, signature or finalization.
  // A live swap carrying its enrolled contract cross-checks the recorded
  // keys; a changed contract refuses the replay.
  validateLightningRefundGraph(previous)
  const enrolled = swap.lockup?.script?.options as { sender?: Uint8Array; server?: Uint8Array } | undefined
  if (enrolled?.sender && enrolled?.server) {
    if (hex.encode(enrolled.sender) !== previous.senderPub || hex.encode(enrolled.server) !== previous.serverPub) {
      throw new Error('Lightning refund contract changed.')
    }
  }
  const retained = refundPaymentTotal(signedRefundPsbt)
  const submittedRefundTxid = previous.submittedRefundTxid ?? retained.txid
  if (submittedRefundTxid !== retained.txid) {
    throw new Error('Lightning refund transaction changed.')
  }
  const refundOutputSats = previous.refundOutputSats ?? retained.paymentTotal
  let serverCheckpointPsbts = previous.serverCheckpointPsbts
  let serverRefundPsbt = previous.serverRefundPsbt
  if (!serverCheckpointPsbts?.length || !serverRefundPsbt) {
    // No Operator response was ever observed, so this is the only phase
    // that resubmits. Both halves of the response persist together; a later
    // retry finds them and skips this dispatch.
    const submitted = await options.record.submitRefund(signedRefundPsbt, submittedCheckpointPsbts)
    if (submitted.arkTxid !== submittedRefundTxid) {
      throw new Error('Lightning refund transaction changed.')
    }
    if (!submitted.signedCheckpointTxs.length || !submitted.finalArkTx) {
      throw new Error('Lightning refund Operator response is incomplete.')
    }
    serverCheckpointPsbts = submitted.signedCheckpointTxs
    serverRefundPsbt = submitted.finalArkTx
    recordRefundAttemptProgress(
      {
        ...facts,
        fundedInputs: previous.fundedInputs,
        signedRefundPsbt,
        submittedRefundTxid,
        submittedCheckpointPsbts: [...submittedCheckpointPsbts],
        refundOutputSats,
        serverCheckpointPsbts: [...serverCheckpointPsbts],
        serverRefundPsbt,
      },
      'submitted',
    )
  }
  // The retained Operator-signed successor must be the same transaction
  // before any final checkpoint is released for signing.
  if (Transaction.fromPSBT(base64.decode(serverRefundPsbt)).id !== submittedRefundTxid) {
    throw new Error('Lightning refund Operator response changed the transaction.')
  }
  let finalCheckpointPsbts = previous.finalCheckpointPsbts
  if (!finalCheckpointPsbts?.length) {
    // Sign each Operator checkpoint exactly once. A lost finalize response
    // replays the persisted finals below instead of signing again.
    const expected = submittedCheckpointPsbts.map((raw) => Transaction.fromPSBT(base64.decode(raw)))
    const pairs = matchServerCheckpoints(serverCheckpointPsbts, expected, 'Lightning refund resume')
    finalCheckpointPsbts = []
    for (const { server } of pairs) {
      options.signal?.throwIfAborted()
      finalCheckpointPsbts.push(await options.record.signCheckpoint(base64.encode(server.toPSBT())))
    }
    recordRefundAttemptProgress({ ...facts, finalCheckpointPsbts: [...finalCheckpointPsbts] }, 'finalized')
  }
  options.signal?.throwIfAborted()
  await options.record.finalizeRefund(submittedRefundTxid, finalCheckpointPsbts)
  recordRefundAttemptProgress(
    { ...facts, refundArkTxid: submittedRefundTxid, resultAmount: refundOutputSats },
    'result',
  )
  return { arkTxid: submittedRefundTxid, amount: refundOutputSats }
}
