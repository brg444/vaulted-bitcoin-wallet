import { ArkAddress, type IWallet, type NetworkName, type RestIndexerProvider } from '@arkade-os/sdk'
import {
  RefundNotLocallyPossibleError,
  RfqSwapManager,
  createRfqSwapRecord,
  isRfqSwapTerminal,
  lockupContractParams,
  rebuildRfqSwap,
  rfqSwapActivityInputs,
  rfqSecretsProfile,
  type AssetSwapRepository,
  type InvoiceFacts,
  type LightningSendSwap,
  type LockupSpendIndexer,
  type RfqQuote,
  type RfqRestoreResult,
  type RfqRestoreFailure,
  type RfqSwapManagerConfig,
  type RfqSwapRecord,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { hex } from '@scure/base'
import { consoleError } from '../logs'
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

interface StoredVaultLightningProfile {
  version: 2
  network: NetworkName
  invoice: string
  quote: RfqQuote
  fundingState: VaultLightningFundingState
  fundingProof?: VaultLightningFundingProof
}

function validFundingProof(value: unknown): value is VaultLightningFundingProof {
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
}

/** Construct the page-local package manager without reading or writing shared state. */
export function createVaultLightningObserver({
  contracts,
  indexer,
  repository,
  managerConfig,
}: VaultLightningObserverDeps): RfqSwapManager {
  // Incoming claims use verified payout receipts and retain their recovery
  // records. The package's send observer must not resolve or prune them.
  const manager = new RfqSwapManager(
    {
      indexer,
      contracts,
      repository: {
        getAllRfqSwaps: async () => (await repository.getAllRfqSwaps()).filter((r) => r.kind !== 'lightning_receive'),
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
    if (record.kind !== 'lightning_send' || !record.fundingArkTxid) continue
    try {
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
