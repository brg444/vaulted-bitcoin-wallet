import {
  ArkAddress,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  type Identity,
  type IContractManager,
  type IWallet,
  type NetworkName,
} from '@arkade-os/sdk'
import {
  IndexedDbAssetSwapRepository,
  RfqSwapManager,
  arkadeRefunder,
  newRfqId,
  type AssetSwapRepository,
  type RfqTransport,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { hex } from '@scure/base'
import { requestVaultLightningSend } from './lightningCovenant'
import {
  lightningSdkNetwork,
  vaultLightningFundingForInvoice,
  vaultLightningSendEnabled,
  type VaultLightningSolverProfile,
} from './lightningConfig'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import { withVaultLightningLifecycleLock } from './lightningLock'
import { readRegisteredLightningContractParams, registeredContractScript } from './lightningValidation'
import {
  discardUnexposedVaultLightningQuote,
  persistVaultLightningQuote,
  maintainVaultLightningObserver,
  restoreMatchingVaultLightningQuote,
  restoreMatchingVaultLightningFundingQuote,
  restorePersistedVaultLightningQuote,
  withAuthenticatedVaultLightningRefund,
  type VaultLightningQuote,
  type VaultLightningSession,
  type VaultLightningVtxoProof,
} from './lightningLifecycle'
import type { VaultStatus } from './types'
import { withActiveVaultWalletState, withVaultWalletState } from './vtxo/walletWorker'
import { vaultOperatorOrigin } from './networkPins'

export {
  isVaultLightningInput,
  discoverVaultLightningSolver,
  BITCOIN_LIGHTNING_SOLVER,
  MUTINYNET_LIGHTNING_SOLVER,
  lightningSdkNetwork,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
  type VaultLightningSolverProfile,
} from './lightningConfig'
export { LightningInvoiceRejected, decodeVaultLightningInvoice, wholeSatsFromMillisats } from './lightningInvoice'
export {
  assertVaultLightningQuoteCurrent,
  beginVaultLightningFunding,
  cancelVaultLightningQuote,
  getVaultLightningStatus,
  recordVaultLightningFundingTxid,
  resumeVaultLightningFunding,
  loadVaultLightningFundingQuote,
  retireAbandonedVaultLightningQuotes,
  vaultLightningSwapStorageName,
  type VaultLightningFundingTarget,
  type VaultLightningFundingProof,
  type VaultLightningQuote,
  type VaultLightningSession,
  VaultLightningFundingNotStartedError,
} from './lightningLifecycle'
export { withVaultLightningLifecycleLock } from './lightningLock'
export {
  requestVaultLightningSend,
  buildLightningSendCandidates,
  matchLightningSendCandidate,
} from './lightningCovenant'

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Guardian status is `mainnet`; arkd `getInfo().network` is `bitcoin`. */
export function requireMatchingLightningOperatorNetwork(
  statusNetwork: string | undefined,
  operatorNetwork: string,
): NetworkName {
  const sdkNetwork = lightningSdkNetwork(statusNetwork)
  if (!sdkNetwork || sdkNetwork !== operatorNetwork) {
    throw new Error('Vault and Arkade Operator networks do not match.')
  }
  return sdkNetwork
}

export function validateVaultLightningRefund(
  status: VaultStatus,
  operatorNetwork: NetworkName,
  operatorSignerPubkey: string,
): ArkAddress {
  if (!status.enrolled || !status.vaultId) throw new Error('Enrolled vault required for Lightning.')
  const sdkNetwork = requireMatchingLightningOperatorNetwork(status.network, operatorNetwork)
  const refund = ArkAddress.decode(String(status.spendingArkAddress || ''))
  const expectedHrp = sdkNetwork === 'bitcoin' ? 'ark' : 'tark'
  if (refund.hrp !== expectedHrp) throw new Error('Spending refund address is encoded for another network.')
  const advertisedScript = String(status.spendingArkScript || '').toLowerCase()
  if (!/^[0-9a-f]{68}$/.test(advertisedScript) || hex.encode(refund.pkScript) !== advertisedScript) {
    throw new Error('Spending refund address does not match its pinned script.')
  }
  const signer = hex.decode(operatorSignerPubkey)
  const xOnlySigner = signer.length === 33 ? signer.slice(1) : signer
  if (xOnlySigner.length !== 32 || !sameBytes(refund.serverPubKey, xOnlySigner)) {
    throw new Error('Spending refund address belongs to another Arkade Operator.')
  }
  return refund
}

export async function withVaultLightningSdkWallet<T>(
  phoneSecret: Uint8Array,
  status: VaultStatus,
  run: (session: VaultLightningSession) => Promise<T>,
  options: { refundRfqId?: string } = {},
): Promise<T> {
  return withVaultLightningLifecycleLock(status.vaultId, () =>
    withUnlockedVaultLightningSdkWallet(phoneSecret, status, run, options),
  )
}

async function withUnlockedVaultLightningSdkWallet<T>(
  phoneSecret: Uint8Array,
  status: VaultStatus,
  run: (session: VaultLightningSession) => Promise<T>,
  options: { refundRfqId?: string },
): Promise<T> {
  if (!status.spendingArkAddress) throw new Error('Vault has no Spending address.')
  const identity = SingleKey.fromPrivateKey(phoneSecret)
  if (hex.encode(await identity.compressedPublicKey()) !== String(status.phoneBip340Pub || '')) {
    throw new Error('Phone key does not match this vault.')
  }
  const arkServerUrl = vaultOperatorOrigin(status.network)
  const operator = new RestArkProvider(arkServerUrl)
  const indexer = new RestIndexerProvider(arkServerUrl)
  const info = await operator.getInfo()
  requireMatchingLightningOperatorNetwork(status.network, info.network)
  validateVaultLightningRefund(status, info.network as NetworkName, info.signerPubkey)
  return withVaultWalletState(status, async ({ contracts, swapRepository, swapManager }) => {
    const requestWallet = vaultLightningRequestWallet(identity, status.spendingArkAddress!, contracts)
    const session: VaultLightningSession = {
      wallet: requestWallet,
      repository: swapRepository,
      contracts,
      manager: swapManager,
      restoreFailures: [],
      retiredQuoteIds: [],
      retirementFailures: [],
    }
    if (!options.refundRfqId) {
      await maintainVaultLightningObserver({
        manager: swapManager,
        contracts,
        indexer,
        repository: swapRepository,
      })
      return run(session)
    }
    if (!/^[0-9a-f]{64}$/.test(options.refundRfqId)) throw new Error('Lightning refund id is invalid.')

    // The persistent observer never holds a signer. Only this explicitly
    // reauthenticated operation installs the package refunder, drives one
    // pass, and then returns the manager to a fail-closed callback.
    return withAuthenticatedVaultLightningRefund(
      swapManager,
      options.refundRfqId,
      arkadeRefunder({ ark: operator, indexer, wallet: requestWallet, repository: swapRepository }),
      () => run(session),
    )
  })
}

type LightningRequester = typeof requestVaultLightningSend

const OPTIONAL_SDK_CAPABILITY_PROBES = new Set([
  'getNextSigningDescriptor',
  'advanceSigningDescriptorWatermark',
  'getCurrentSigningDescriptor',
  'getUsedSigningDescriptors',
  'signerForDescriptor',
])

/** The exact public wallet surface used by @arkade-os/swap quote creation. */
export function vaultLightningRequestWallet(
  identity: Identity,
  refundAddress: string,
  contracts: IContractManager,
): IWallet {
  ArkAddress.decode(refundAddress)
  const capabilities: Record<string, unknown> = {
    identity,
    getAddress: async () => refundAddress,
    getContractManager: async () => contracts,
  }
  return new Proxy(capabilities, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property)
      if (property in target) return target[property]
      if (OPTIONAL_SDK_CAPABILITY_PROBES.has(property)) return undefined
      throw new Error(`Lightning quote attempted unsupported wallet capability: ${property}`)
    },
  }) as unknown as IWallet
}

export async function withVaultLightningRepository<T>(
  vaultId: string,
  run: (repository: IndexedDbAssetSwapRepository) => Promise<T>,
): Promise<T> {
  return withActiveVaultWalletState(vaultId, ({ swapRepository }) => run(swapRepository))
}

export async function requestVaultLightningQuote({
  wallet,
  arkServerUrl,
  invoice,
  network,
  transport,
  repository,
  contracts,
  manager,
  profile,
  resumeVtxo,
  rfqId,
  requester = requestVaultLightningSend,
  nowSeconds = Math.floor(Date.now() / 1000),
  enabled,
}: {
  wallet: IWallet
  arkServerUrl: string
  invoice: string
  network: NetworkName
  transport: RfqTransport
  repository: AssetSwapRepository
  contracts: SwapContractRegistry
  manager: RfqSwapManager
  profile: VaultLightningSolverProfile
  resumeVtxo?: VaultLightningVtxoProof
  rfqId?: string
  requester?: LightningRequester
  nowSeconds?: number
  enabled?: boolean
}): Promise<VaultLightningQuote> {
  if (!(enabled ?? vaultLightningSendEnabled(network))) {
    throw new Error('Lightning send is not enabled in this release.')
  }
  if (profile.network !== network) throw new Error('Lightning solver profile is for another network.')
  if (!/^[0-9a-f]{64}$/.test(profile.pubkey)) throw new Error('Lightning solver pubkey is invalid.')
  if (
    profile.relays.length === 0 ||
    profile.relays.some((relay) => {
      try {
        return new URL(relay).protocol !== 'wss:'
      } catch {
        return true
      }
    })
  ) {
    throw new Error('Lightning solver relay configuration is invalid.')
  }
  if (
    !Number.isSafeInteger(profile.minSats) ||
    !Number.isSafeInteger(profile.maxSats) ||
    !Number.isSafeInteger(profile.maxFundingSats) ||
    profile.minSats < 1 ||
    profile.maxSats < profile.minSats ||
    profile.maxFundingSats < profile.maxSats
  ) {
    throw new Error('Lightning solver amount limits are invalid.')
  }
  const facts = decodeVaultLightningInvoice(invoice, network, nowSeconds)
  if (facts.amountSats < profile.minSats || facts.amountSats > profile.maxSats) {
    throw new Error(
      `Lightning amount must be ${profile.minSats.toLocaleString()}–${profile.maxSats.toLocaleString()} sats.`,
    )
  }
  if (rfqId !== undefined && !/^[0-9a-f]{64}$/.test(rfqId)) {
    throw new Error('Lightning RFQ id must be 32 bytes of lowercase hex.')
  }
  if (resumeVtxo) {
    const resumed = await restoreMatchingVaultLightningFundingQuote(
      repository,
      contracts,
      manager,
      facts.raw,
      network,
      resumeVtxo,
      nowSeconds,
    )
    if (resumed) return resumed
  }
  const existing = rfqId
    ? await restorePersistedVaultLightningQuote(repository, contracts, manager, rfqId, facts.raw, network, nowSeconds)
    : await restoreMatchingVaultLightningQuote(repository, contracts, manager, facts.raw, network, nowSeconds)
  if (existing) return existing

  const requestId = rfqId ?? newRfqId()

  const result = await requester(wallet, arkServerUrl, transport, { invoice: facts, rfqId: requestId })
  const contractScript = registeredContractScript(result)
  try {
    if (!Number.isSafeInteger(result.fundAmount) || result.fundAmount > profile.maxFundingSats) {
      throw new Error(
        `Lightning funding amount exceeds the solver profile’s ${profile.maxFundingSats.toLocaleString()} sat limit.`,
      )
    }
    const fundingCeiling = vaultLightningFundingForInvoice(facts.amountSats, profile)
    if (result.fundAmount > fundingCeiling) {
      throw new Error(
        `Lightning quote asks ${result.fundAmount.toLocaleString()} sats; the pinned solver fee allows at most ${fundingCeiling.toLocaleString()} sats.`,
      )
    }
    const contractParams = await readRegisteredLightningContractParams({ result, contracts })

    return await persistVaultLightningQuote({
      result,
      facts,
      refundLocktime: result.quote.refund_locktime!,
      contractParams,
      repository,
      manager,
      network,
      nowSeconds,
    })
  } catch (error) {
    return discardUnexposedVaultLightningQuote(repository, contracts, manager, requestId, contractScript, error)
  }
}

export function vaultLightningTransport(profile: VaultLightningSolverProfile): RfqTransport {
  return nostrRfqTransport({
    relays: [...profile.relays],
    solverPubkey: profile.pubkey,
    timeoutMs: 30_000,
  })
}

export async function withVaultLightningTransport<T>(
  profile: VaultLightningSolverProfile,
  run: (transport: RfqTransport) => Promise<T>,
  createTransport: (profile: VaultLightningSolverProfile) => RfqTransport = vaultLightningTransport,
): Promise<T> {
  const transport = createTransport(profile)
  try {
    return await run(transport)
  } finally {
    await transport.close()
  }
}
