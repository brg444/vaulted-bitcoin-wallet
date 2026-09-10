import { SPENDING_ONLY_TEMPLATE, requireSpendingEnrollmentStatus, spendingEnrollmentHash } from './spendingEnrollment'
import { bech32, hex } from '@scure/base'
import {
  createExitChainResolver,
  ChainedTxType,
  type ChainTx,
  type IContractManager,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { exitArchiveProviders, packExitArchive } from './recovery/exitArchive'
import { vaultExitRepository } from './vtxo/exitRepository'
import { lightExitRepository } from './light/exitRepository'
import { paymentHashOf, registerLockupContract, type AssetSwapRepository, type RfqQuote } from '@arkade-os/swap'
import { authorizerBase } from './status'
import { readBounded } from './bounded'
import { PRF_SALT } from './prfEnvelope'
import { passkeyGetOptions, prfExtension, prfFrom } from './webauthn'
import { deriveDirectP256, signDirectP256, zeroBytes } from './ceremony/directauth'
import { passkeyProofDigest } from './passkeyBinding'
import {
  createVaultLightningReceiveRecord,
  deriveVaultLightningReceive,
  receiveProfile,
  validateReceiveRecord,
  type VaultLightningReceiveProfile,
} from './lightningReceive'
import type { VaultStatus } from './types'

export const LNURL_ORIGIN = 'https://ln.getvaulted.xyz'
interface ReceivingBinding {
  vaultId: string
  network: string
  templateVersion: string
  protectionTier: string
  policyVersion: string
  descriptorHash: string
  spendingPolicyDigest: string
  spendingAddress: string
  spendingScript: string
  claimPublicKey: string
}
export interface LightningAddress {
  name?: string
  id: string
  address: string
  lnurl: string
  readToken: string
  active: boolean
  binding: ReceivingBinding
  maxFeeSats: number
}
const storageKey = (status: VaultStatus) => `vaulted:lnurl:v1:${status.network}:${status.vaultId}`
export const lightningAddressEnabled = () => import.meta.env.VITE_VAULT_LNURL === 'true'

export function validLightningName(name: string) {
  return (
    /^[a-z][a-z0-9_-]{2,31}$/.test(name) &&
    !/^v[0-9a-f]{16}$/.test(name) &&
    ![
      'admin',
      'support',
      'security',
      'abuse',
      'postmaster',
      'vaulted',
      'root',
      'system',
      'api',
      'www',
      'lnurl',
    ].includes(name)
  )
}
export async function lightningNameAvailable(name: string, address?: LightningAddress) {
  if (!validLightningName(name)) return false
  const response = await fetch(`${LNURL_ORIGIN}/v1/vaulted/names/${encodeURIComponent(name)}`, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: address ? { Authorization: `Bearer ${address.readToken}` } : undefined,
  })
  const raw = await readBounded(response, 1024)
  if (!response.ok) throw new Error('Could not check this name. Please try again.')
  return JSON.parse(raw).available === true
}
export function validateLightningAddress(value: LightningAddress, status: VaultStatus) {
  const name = value.name ?? value.id
  const encoded = bech32
    .encode('lnurl', bech32.toWords(new TextEncoder().encode(`${LNURL_ORIGIN}/.well-known/lnurlp/${name}`)), 1023)
    .toUpperCase()
  const b = value.binding
  const descriptor =
    status.templateVersion === SPENDING_ONLY_TEMPLATE
      ? spendingEnrollmentHash(requireSpendingEnrollmentStatus(status))
      : (status.lightDescriptorHash ?? status.connectorEnrollment?.descriptorHash)
  if (
    !/^v[0-9a-f]{16}$/.test(value.id) ||
    (name !== value.id && !validLightningName(name)) ||
    value.address !== `${name}@ln.getvaulted.xyz` ||
    value.lnurl !== encoded ||
    !/^[0-9a-f]{64}$/.test(value.readToken) ||
    typeof value.active !== 'boolean' ||
    !Number.isSafeInteger(value.maxFeeSats) ||
    value.maxFeeSats < 0 ||
    !b ||
    b.vaultId !== status.vaultId ||
    b.network !== status.network ||
    b.templateVersion !== status.templateVersion ||
    b.protectionTier !== status.protectionTier ||
    b.policyVersion !== status.policyVersion ||
    b.spendingAddress !== status.spendingArkAddress ||
    b.spendingScript !== status.spendingArkScript ||
    b.claimPublicKey !== status.phoneBip340Pub ||
    b.spendingPolicyDigest !== status.spendingPolicyDigest ||
    (descriptor && b.descriptorHash !== descriptor)
  )
    throw new Error('Lightning address does not match this wallet.')
  return value
}
export function loadLightningAddress(status: VaultStatus): LightningAddress | undefined {
  const raw = localStorage.getItem(storageKey(status))
  return raw ? validateLightningAddress(JSON.parse(raw), status) : undefined
}
async function post<T>(phase: string, body: unknown): Promise<T> {
  const res = await fetch(`${authorizerBase()}/v1/lnurl/${phase}`, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await readBounded(res, 16_384)
  if (!res.ok) throw new Error('Lightning address setup is unavailable. Your existing address has been retained.')
  return JSON.parse(raw) as T
}
export async function configureLightningAddress(status: VaultStatus, action: 'register' | 'revoke', name = '') {
  if (status.clientOrigin !== location.origin || status.rpId !== location.hostname)
    throw new Error('Wallet origin mismatch.')
  if (name && (action !== 'register' || !validLightningName(name))) throw new Error('Invalid Lightning address name.')
  const challenge = await post<{ challengeId: string; challenge: string }>('challenge', { action, name })
  if (!/^[0-9a-f]{64}$/.test(challenge.challenge)) throw new Error('Invalid Lightning address challenge.')
  const credential = (await navigator.credentials.get({
    publicKey: passkeyGetOptions({
      rpId: location.hostname,
      challenge: Uint8Array.from(hex.decode(challenge.challenge)),
      userVerification: 'required',
      extensions: prfExtension(PRF_SALT),
    }),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey request cancelled.')
  const assertion = credential.response as AuthenticatorAssertionResponse
  if (assertion.userHandle && new TextDecoder().decode(assertion.userHandle) !== status.vaultId)
    throw new Error('Choose this wallet’s original passkey.')
  const prf = prfFrom(credential)
  if (!prf || prf.length !== 32) throw new Error('The wallet’s original passkey PRF is required.')
  let direct: Awaited<ReturnType<typeof deriveDirectP256>> | undefined
  try {
    direct = await deriveDirectP256(prf)
    if (hex.encode(direct.pub) !== status.phoneDirectP256) throw new Error('Choose this wallet’s original passkey.')
    const credentialId = hex.encode(new Uint8Array(credential.rawId))
    const result = validateLightningAddress(
      await post<LightningAddress>(action, {
        name,
        vaultId: status.vaultId,
        challengeId: challenge.challengeId,
        credentialId,
        clientDataJSON: hex.encode(new Uint8Array(assertion.clientDataJSON)),
        authenticatorData: hex.encode(new Uint8Array(assertion.authenticatorData)),
        signature: hex.encode(new Uint8Array(assertion.signature)),
        directProof: hex.encode(
          signDirectP256(
            direct.scalar,
            passkeyProofDigest(`lnurl-${action}`, hex.decode(challenge.challenge), hex.decode(credentialId)),
          ),
        ),
      }),
      status,
    )
    if (name && result.name !== name) throw new Error('Lightning address name did not match your request.')
    localStorage.setItem(storageKey(status), JSON.stringify(result))
    if (localStorage.getItem(storageKey(status)) !== JSON.stringify(result))
      throw new Error('Lightning address could not be saved.')
    return result
  } finally {
    zeroBytes(prf)
    if (direct) zeroBytes(direct.scalar)
  }
}

interface Receipt {
  sequence: number
  swapId: string
  invoice: string
  preimage: string
  preimageHash: string
  lockupAddress: string
  recovery: { quote: RfqQuote; claimDelay: number; invoiceExpiresAt: number }
  claim?: VaultLightningReceiveProfile['claim']
  graphs?: Partial<Record<'funding' | 'payout', boolean>>
}

/** Import under the existing Lightning lifecycle lock; settlement still needs indexed payout evidence. */
export async function importLightningAddressReceipts(input: {
  status: VaultStatus
  repository: AssetSwapRepository
  contracts: IContractManager
}) {
  const { status, repository, contracts } = input
  const address = loadLightningAddress(status)
  if (!address) return
  const cursorKey = `${storageKey(status)}:receipt-cursor`
  const cursor = Number(localStorage.getItem(cursorKey) ?? 0)
  let after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
  for (let page = 0; page < 4; page++) {
    const res = await fetch(`${LNURL_ORIGIN}/v1/vaulted/receipts/${address.id}?after=${after}`, {
      headers: { Authorization: `Bearer ${address.readToken}` },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    const raw = await readBounded(res, 3_000_000)
    if (!res.ok) throw new Error('Lightning address receipts are temporarily unavailable.')
    const { receipts } = JSON.parse(raw) as { receipts: Receipt[] }
    if (!Array.isArray(receipts) || receipts.length > 100) throw new Error('Invalid Lightning receipts.')
    for (const r of receipts) {
      if (
        !Number.isSafeInteger(r.sequence) ||
        r.sequence <= after ||
        !/^[0-9a-f]{64}$/.test(r.preimage) ||
        paymentHashOf(hex.decode(r.preimage)) !== r.preimageHash ||
        r.swapId !== r.recovery?.quote?.rfq_id ||
        r.invoice !== r.recovery.quote.profile?.invoice ||
        r.lockupAddress !== r.recovery.quote.profile?.lockup_address
      )
        throw new Error('Invalid Lightning address recovery record.')
      const script = deriveVaultLightningReceive({
        quote: r.recovery.quote,
        paymentHash: r.preimageHash,
        payoutAddress: status.spendingArkAddress!,
        phonePub: status.phoneBip340Pub!,
        network: status.network!,
        claimDelay: r.recovery.claimDelay,
      })
      const record = createVaultLightningReceiveRecord({
        status,
        quote: r.recovery.quote,
        script,
        preimage: hex.decode(r.preimage),
        payDeadline: r.recovery.invoiceExpiresAt,
        estimatedPaySats: r.recovery.quote.from_amount,
        now: Math.floor(Date.now() / 1000),
      })
      if (r.claim) receiveProfile(record).claim = r.claim
      await registerLockupContract(contracts, script, r.lockupAddress)
      const contract = (await contracts.getContracts({ script: hex.encode(script.pkScript) }))[0]
      if (!contract) throw new Error('Lightning address contract was not saved.')
      validateReceiveRecord(record, contract, {
        vaultId: status.vaultId,
        network: status.network!,
        phonePub: status.phoneBip340Pub!,
        spendingScript: status.spendingArkScript!,
      })
      const existing = await repository.getRfqSwap(r.swapId)
      if (existing) {
        validateReceiveRecord(existing, contract, {
          vaultId: status.vaultId,
          network: status.network!,
          phonePub: status.phoneBip340Pub!,
          spendingScript: status.spendingArkScript!,
        })
        if (JSON.stringify(receiveProfile(existing).quote) !== JSON.stringify(r.recovery.quote))
          throw new Error('Lightning address quote changed.')
        if (r.claim && !receiveProfile(existing).claim && existing.state === 'pending') {
          receiveProfile(existing).claim = r.claim
          await repository.saveRfqSwap(existing)
        }
      } else {
        await repository.saveRfqSwap(record)
        if (JSON.stringify(await repository.getRfqSwap(r.swapId)) !== JSON.stringify(record))
          throw new Error('Lightning receipt could not be saved.')
      }
      const saved = (await repository.getRfqSwap(r.swapId))!
      for (const phase of ['funding', 'payout'] as const) {
        if (!r.graphs?.[phase] || (await receiveGraphCached(status, saved.profile[`lnurlGraph:${phase}`]))) continue
        saved.profile[`lnurlGraph:${phase}`] = await importReceiveGraph(status, address, r, phase)
        await repository.saveRfqSwap(saved)
      }
      after = r.sequence
    }
    localStorage.setItem(cursorKey, String(receipts.length < 100 ? 0 : after))
    if (receipts.length < 100) return
  }
  // Continue the next page on the next wallet pass. Returning to zero after
  // each full traversal also refreshes invoices that were funded out of order.
}

async function receiveGraphCached(status: VaultStatus, value: unknown) {
  if (!value || typeof value !== 'object') return false
  const marker = value as { txid: string; vout: number }
  if (!/^[0-9a-f]{64}$/.test(marker.txid) || !Number.isSafeInteger(marker.vout) || marker.vout < 0) return false
  const cache = status.lightDescriptor
    ? lightExitRepository(status.lightDescriptor)
    : vaultExitRepository(status.vaultId, status.network!)
  try {
    const branch = await cache.getBranch(marker)
    return (
      branch.some((tx) => tx.txid === marker.txid) &&
      branch.every((tx) => tx.type === ChainedTxType.Commitment || Boolean(tx.psbt))
    )
  } finally {
    await cache[Symbol.asyncDispose]()
  }
}

async function importReceiveGraph(
  status: VaultStatus,
  address: LightningAddress,
  receipt: Receipt,
  phase: 'funding' | 'payout',
) {
  const response = await fetch(`${LNURL_ORIGIN}/v1/vaulted/recovery/${address.id}/${receipt.swapId}/${phase}`, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${address.readToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await readBounded(response, 12_100_000)
  if (!response.ok) throw new Error('Funded Lightning recovery data is temporarily unavailable.')
  const graph = JSON.parse(raw) as {
    info: string
    coin: string
    chain: ChainTx[]
    transactions: Record<string, string>
  }
  const original = JSON.parse(graph.coin) as VirtualCoin
  // This is a historical outpoint snapshot used only to validate and cache
  // transaction ancestry. It never writes a coin into the wallet balance.
  const coin = { ...original, isSpent: false, spentBy: '' }
  const scriptPubKey =
    phase === 'payout'
      ? status.spendingArkScript!
      : hex.encode((await import('@arkade-os/sdk')).ArkAddress.decode(receipt.lockupAddress).pkScript)
  if (phase === 'payout' && (coin.txid !== receipt.claim?.txid || coin.vout !== 0))
    throw new Error('Lightning payout recovery identity mismatch.')
  const binding = { descriptorHash: address.binding.descriptorHash, network: status.network!, scriptPubKey }
  const archive = {
    version: 1 as const,
    descriptorHash: binding.descriptorHash,
    capturedAt: new Date().toISOString(),
    info: graph.info,
    coins: packExitArchive([coin]),
    branches: { [`${coin.txid}:${coin.vout}`]: graph.chain },
    transactions: graph.transactions,
  }
  const local = exitArchiveProviders(archive, binding)
  const cache = status.lightDescriptor
    ? lightExitRepository(status.lightDescriptor)
    : vaultExitRepository(status.vaultId, status.network!)
  try {
    const resolver = createExitChainResolver({ indexer: local.indexerProvider, repository: cache })
    await resolver.getVtxoChain(coin)
    await resolver.getVirtualTxs(Object.keys(graph.transactions))
    return { txid: coin.txid, vout: coin.vout }
  } finally {
    await cache[Symbol.asyncDispose]()
  }
}
