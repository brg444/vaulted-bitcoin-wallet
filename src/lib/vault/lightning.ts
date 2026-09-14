import {
  ArkAddress,
  ReadonlySingleKey,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  VHTLCV2ContractHandler,
  deriveDescriptorLeafPubKey,
  identityDescriptor,
  type ArkInfo,
  type Identity,
  type IContractManager,
  type IWallet,
  type NetworkName,
  type ProvisionedKey,
  type ReadonlyIdentity,
} from '@arkade-os/sdk'
import {
  IndexedDbAssetSwapRepository,
  RfqSwapManager,
  arkadeRefunder,
  lockupContractParams,
  newRfqId,
  rfqSignerOf,
  senderIdentityForSwapRecord,
  type AssetSwapRepository,
  type RfqSwapRecord,
  type RfqTransport,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { base64, hex } from '@scure/base'
import { requestVaultLightningSend } from './lightningCovenant'
import {
  lightningSdkNetwork,
  vaultLightningFundingForInvoice,
  vaultLightningSendEnabled,
  type VaultLightningSolverProfile,
} from './lightningConfig'
import { decodeVaultLightningInvoice } from './lightningInvoice'
import { withVaultLightningLifecycleLock } from './lightningLock'
import { vaultLatency } from './latency'
import { getOperatorInfo } from './operatorInfoCache'
import { readRegisteredLightningContractParams, registeredContractScript } from './lightningValidation'
import {
  discardUnexposedVaultLightningQuote,
  durableVaultLightningRefund,
  persistVaultLightningQuote,
  recordingVaultLightningRefundArk,
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
import { cancellableSdkCapability } from './sdkCapability'

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

/**
 * Bind one Operator reply to the enrolled vault before any RFQ is sent: the
 * network must match, and the refund address, script and signing Operator key
 * must all agree with the enrolled Spending contract. Returns the resolved SDK
 * network so callers reuse the single validated reply.
 */
export function assertVaultLightningOperatorSetup(status: VaultStatus, info: ArkInfo): NetworkName {
  const network = requireMatchingLightningOperatorNetwork(status.network, info.network)
  validateVaultLightningRefund(status, network, info.signerPubkey)
  return network
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
  options: { refundRfqId?: string; signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted()
  const lifetime = new AbortController()
  const cancel = () => lifetime.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await withVaultLightningLifecycleLock(status.vaultId, () =>
      withUnlockedVaultLightningSdkWallet(phoneSecret, status, run, { ...options, signal: lifetime.signal }),
    )
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    lifetime.abort(new DOMException('Lightning approval ended', 'AbortError'))
  }
}

async function withUnlockedVaultLightningSdkWallet<T>(
  phoneSecret: Uint8Array,
  status: VaultStatus,
  run: (session: VaultLightningSession) => Promise<T>,
  options: { refundRfqId?: string; signal?: AbortSignal },
): Promise<T> {
  options.signal?.throwIfAborted()
  if (!status.spendingArkAddress) throw new Error('Vault has no Spending address.')
  const identity = cancellableSdkCapability(SingleKey.fromPrivateKey(phoneSecret), options.signal)
  if (hex.encode(await identity.compressedPublicKey()) !== String(status.phoneBip340Pub || '')) {
    throw new Error('Phone key does not match this vault.')
  }
  const arkServerUrl = vaultOperatorOrigin(status.network)
  const operator = cancellableSdkCapability(new RestArkProvider(arkServerUrl), options.signal)
  const indexer = new RestIndexerProvider(arkServerUrl)
  const info = await operator.getInfo()
  requireMatchingLightningOperatorNetwork(status.network, info.network)
  validateVaultLightningRefund(status, info.network as NetworkName, info.signerPubkey)
  options.signal?.throwIfAborted()
  return withVaultWalletState(status, async ({ contracts, swapRepository, swapManager }) => {
    options.signal?.throwIfAborted()
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
      options.signal?.throwIfAborted()
      return run(session)
    }
    if (!/^[0-9a-f]{64}$/.test(options.refundRfqId)) throw new Error('Lightning refund id is invalid.')

    // The persistent observer never holds a signer. Only this explicitly
    // reauthenticated operation installs the package refunder, drives one
    // pass, and then returns the manager to a fail-closed callback.
    const refundRecord = await swapRepository.getRfqSwap(options.refundRfqId)
    if (!refundRecord || refundRecord.kind !== 'lightning_send') {
      throw new Error('Lightning refund record is missing.')
    }
    if (!Number.isSafeInteger(refundRecord.amount)) throw new Error('Lightning refund record has no amount.')
    // The enrolled refund signers come from the lockup contract behind the
    // funded address, never from later refund bytes. Every recorded byte is
    // verified against these keys.
    const refundScript = VHTLCV2ContractHandler.createScript(
      await lockupContractParams(contracts, refundRecord.lockupAddress),
    )
    const refundScriptHex = hex.encode(refundScript.pkScript)
    const lockupPkScriptHex = hex.encode(ArkAddress.decode(refundRecord.lockupAddress).pkScript)
    if (refundScriptHex !== lockupPkScriptHex) throw new Error('Lightning refund contract does not match its lockup.')
    const refundFacts = {
      rfqId: refundRecord.rfqId,
      lockupAddress: refundRecord.lockupAddress,
      lockupPkScriptHex,
      amountSats: refundRecord.amount!,
      destination: String(status.spendingArkAddress || ''),
      vaultId: status.vaultId,
      network: status.network,
      senderPub: hex.encode(refundScript.options.sender),
      serverPub: hex.encode(refundScript.options.server),
    }
    const recordingArk = recordingVaultLightningRefundArk(operator, refundFacts, options.signal)
    // The sender session is resolved on first checkpoint signing, never at
    // setup: no signing capability is acquired before dispatch needs it.
    let refundSender: { sign: (tx: Transaction, indexes?: number[]) => Promise<Transaction> } | undefined
    const signRefundCheckpoint = async (checkpointPsbt: string): Promise<string> => {
      refundSender ??= (await senderIdentityForSwapRecord(requestWallet, rfqSignerOf(refundRecord) ?? {})) as {
        sign: (tx: Transaction, indexes?: number[]) => Promise<Transaction>
      }
      const signed = await refundSender.sign(Transaction.fromPSBT(base64.decode(checkpointPsbt)), [0])
      return base64.encode(signed.toPSBT())
    }
    return withAuthenticatedVaultLightningRefund(
      swapManager,
      options.refundRfqId,
      durableVaultLightningRefund(
        refundFacts,
        arkadeRefunder({
          ark: recordingArk,
          indexer,
          wallet: requestWallet,
          repository: swapRepository,
        }),
        {
          signal: options.signal,
          record: {
            submitRefund: (signedPsbt, checkpoints) => recordingArk.submitTx(signedPsbt, checkpoints),
            signCheckpoint: signRefundCheckpoint,
            finalizeRefund: (arkTxid, checkpoints) => recordingArk.finalizeTx(arkTxid, checkpoints),
          },
        },
      ),
      () => {
        options.signal?.throwIfAborted()
        return run(session)
      },
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
  identity: Identity | ReadonlyIdentity,
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

/**
 * The enrolled, public Lightning refund context. Derived only from the
 * enrolled phone public key and the pinned Spending refund address: no private
 * key is unwrapped, no signing capability is created, and no key material
 * crosses a screen boundary. The descriptor is exactly what the signing
 * identity would produce, so a later authenticated refund resolves the same
 * signer.
 */
export async function vaultLightningPublicRefund(status: VaultStatus): Promise<ProvisionedKey> {
  if (!status.enrolled || !status.spendingArkAddress) throw new Error('Enroll this vault before Lightning payments.')
  const compressed = String(status.phoneBip340Pub || '').toLowerCase()
  if (!/^[0-9a-f]{66}$/.test(compressed)) throw new Error('Enrolled phone public key is missing.')
  const identity = ReadonlySingleKey.fromPublicKey(hex.decode(compressed))
  const descriptor = await identityDescriptor(identity)
  const pubkey = await identity.xOnlyPublicKey()
  const { pkScript } = ArkAddress.decode(String(status.spendingArkAddress))
  return { descriptor, pubkey, pkScript, address: String(status.spendingArkAddress) }
}

/**
 * Verify the unlocked signer is the exact key the persisted quote bound. This
 * is the funding-time check that a public quote never bound a key the wallet
 * does not control: the stored descriptor must derive the unlocked x-only key.
 */
export async function assertVaultLightningStoredSigner(record: RfqSwapRecord, phoneSecret: Uint8Array): Promise<void> {
  const projection = rfqSignerOf(record)
  if (!projection?.signingDescriptor) throw new Error('Lightning recovery record has no signer descriptor.')
  const expected = deriveDescriptorLeafPubKey(projection.signingDescriptor)
  const actual = await SingleKey.fromPrivateKey(phoneSecret).xOnlyPublicKey()
  if (hex.encode(expected) !== hex.encode(actual)) {
    throw new Error('The unlocked signer does not match this Lightning quote.')
  }
}

export interface VaultLightningPublicQuoteSession {
  /** Public request wallet: a read-only identity and the real contract manager. */
  wallet: IWallet
  contracts: IContractManager
  repository: IndexedDbAssetSwapRepository
  manager: RfqSwapManager
  refund: ProvisionedKey
  /** The single Operator reply validated against this enrolled vault. */
  operatorInfo: ArkInfo
}

/**
 * Run a foreground Lightning quote on public enrolled information under the
 * per-vault lifecycle lock, so cross-tab RFQ serialization is preserved without
 * unwrapping signing keys or running broad observer maintenance.
 */
export async function withVaultLightningPublicQuote<T>(
  status: VaultStatus,
  run: (session: VaultLightningPublicQuoteSession) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return vaultLatency.measure('lock-wait', () =>
    withVaultLightningLifecycleLock(status.vaultId, () =>
      withVaultWalletState(status, async ({ contracts, swapRepository, swapManager }) => {
        options.signal?.throwIfAborted()
        const refund = await vaultLatency.measure('public-setup', () => vaultLightningPublicRefund(status))
        options.signal?.throwIfAborted()
        // Bind the Operator to the enrolled vault before any RFQ: network,
        // refund address/script and the signing Operator key must match, and
        // the single reply is reused by the requester below.
        const arkServerUrl = vaultOperatorOrigin(status.network)
        const operatorInfo = await vaultLatency.measure('operator-info', () => getOperatorInfo(arkServerUrl))
        assertVaultLightningOperatorSetup(status, operatorInfo)
        options.signal?.throwIfAborted()
        const identity = ReadonlySingleKey.fromPublicKey(hex.decode(String(status.phoneBip340Pub || '').toLowerCase()))
        const wallet = vaultLightningRequestWallet(identity, refund.address, contracts)
        return run({ wallet, contracts, repository: swapRepository, manager: swapManager, refund, operatorInfo })
      }),
    ),
  )
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
  refund,
  operatorInfo,
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
  /** Public refund context; required for the quote path that must not sign. */
  refund?: ProvisionedKey
  /** Validated Operator reply to reuse instead of a second getInfo. */
  operatorInfo?: ArkInfo
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

  const result = await vaultLatency.measure('rfq', () =>
    requester(wallet, arkServerUrl, transport, {
      invoice: facts,
      rfqId: requestId,
      ...(refund ? { refund } : {}),
      ...(operatorInfo ? { operatorInfo } : {}),
    }),
  )
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
        `Lightning quote asks ${result.fundAmount.toLocaleString()} sats; the solver and routing fee limit allows at most ${fundingCeiling.toLocaleString()} sats.`,
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
