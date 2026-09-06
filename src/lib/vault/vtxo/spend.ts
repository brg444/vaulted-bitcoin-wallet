import { LIGHT_PROFILE, LightScript } from '../light/contract'
import { requireLightStatus } from '../light/status'
import { unlockLightOwnerKey } from '../light/keyBackup'
import {
  ArkAddress,
  buildOffchainTx,
  CSVMultisigTapscript,
  Intent,
  RestArkProvider,
  scriptFromTapLeafScript,
  SingleKey,
  Transaction,
  type ArkProvider,
  verifyTapscriptSignatures,
} from '@arkade-os/sdk'
import { SigHash } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { base64, hex } from '@scure/base'
import { deriveDirectP256, signDirectP256, zeroBytes } from '../ceremony/directauth'
import { VaultRequestError } from '../api'
import {
  UnknownVtxoOperationStateError,
  vaultCosignerClient,
  vtxoOperationViewFromWire,
  type VtxoAuthorizeRequest,
  type VtxoAuthorizeResponse,
  type VtxoCheckpointAuthorizeResponse,
  type VtxoFinalizeResponse,
  type VtxoOperationState,
  type VtxoOperationView,
  type VtxoReserveRequest,
  type VtxoReserveResponse,
} from '../cosignerClient'
import { unlockPhoneBip340 } from '../savingsSpend'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { PRF_SALT, unwrapPhoneSecret } from '../prfEnvelope'
import { deviceSigningOptions, prfExtension, prfFrom } from '../webauthn'
import { arkadeIntentFeePolicyDigest } from './feePolicy'
import { networkPins } from '../networkPins'
import { configuredReleaseNetwork } from '../releaseNetwork'
import { browserVaultLockManager, requireVaultLockManager, type VaultLockManager } from './lock'
import {
  signVtxoAbortDigest,
  signVtxoReserveDigest,
  verifyVtxoReserveSignature,
  type VtxoReserveDigestInput,
} from './reserveAuth'
import { submitExactVaultSdkOperation, type VaultSdkOperationValidation } from './sdkOperationAdapter'
import { VAULT_POLICY_V1_EXIT_DELAY_UNIT, VaultPolicyV1Script, type VaultPolicyV1Params } from './script'

export type { VtxoOperationState, VtxoOperationView, VtxoReserveResponse } from '../cosignerClient'

const VTXO_DUST_SATS = 330
const MAX_VTXO_INPUTS = 50

declare const __VAULT_E2E_OPERATOR_ORIGIN__: string

function releaseNetwork(network?: string): string {
  const raw =
    network || configuredReleaseNetwork(import.meta.env.VITE_VAULT_RELEASE_NETWORK, import.meta.env.PROD) || 'mutinynet'
  return raw === 'bitcoin' ? 'mainnet' : raw
}

export function vaultArkServer(network?: string): string {
  if (__VAULT_E2E_OPERATOR_ORIGIN__) return __VAULT_E2E_OPERATOR_ORIGIN__
  return networkPins(releaseNetwork(network)).operatorOrigin
}

export interface VaultVtxoSpendResult {
  txid: string
  operationId: string
  feeSats: number
}

export interface VaultVtxoSpendQuote {
  operationId: string
  bundleDigest: string
  destAddress: string
  amountSats: number
  feeSats: number
  feePolicyDigest: string
  reservationExpires: string
  changeSats: number
  changeVout?: number
}

export class VtxoReviewedReservationError extends Error {
  constructor() {
    super('This fee quote expired or changed. Review the send again.')
    this.name = 'VtxoReviewedReservationError'
  }
}

export class VtxoReceiptPendingError extends Error {
  readonly txid: string
  readonly operationId: string
  readonly feeSats: number

  constructor(txid: string, operationId: string, feeSats: number) {
    super('VTXO finalization receipt unavailable')
    this.name = 'VtxoReceiptPendingError'
    this.txid = txid
    this.operationId = operationId
    this.feeSats = feeSats
  }
}

export class VtxoSpendInFlightError extends Error {
  readonly txid: string
  readonly operationId: string

  constructor(txid: string, operationId: string) {
    super('VTXO spend is still with the operator')
    this.name = 'VtxoSpendInFlightError'
    this.txid = txid
    this.operationId = operationId
  }
}

export class VtxoSpendUnresolvedError extends Error {
  readonly txid: string
  readonly operationId: string

  constructor(txid: string, operationId: string) {
    super('VTXO spend is unresolved')
    this.name = 'VtxoSpendUnresolvedError'
    this.txid = txid
    this.operationId = operationId
  }
}

export class VtxoSameSendInProgressError extends Error {
  readonly destAddress: string
  readonly amountSats: number
  readonly operationId: string

  constructor(pending: PersistedVtxoSpend) {
    super('A send of this exact amount to this address is still in progress.')
    this.name = 'VtxoSameSendInProgressError'
    this.destAddress = pending.destAddress
    this.amountSats = pending.amountSats
    this.operationId = pending.operationId
  }
}

export class VtxoReservedReplaceError extends Error {
  readonly operationId: string

  constructor(operationId: string) {
    super('A reserved send is still open. Abort it before sending a different amount.')
    this.name = 'VtxoReservedReplaceError'
    this.operationId = operationId
  }
}

export class VtxoLivePendingError extends Error {
  readonly operationIds: string[]

  constructor(operationIds: string[]) {
    super('A send is already with the operator and cannot be cancelled.')
    this.name = 'VtxoLivePendingError'
    this.operationIds = operationIds
  }
}

export class VtxoAbortFailedError extends Error {
  constructor(message = 'The reserved send could not be aborted.') {
    super(message)
    this.name = 'VtxoAbortFailedError'
  }
}

export function isVtxoReceiptPendingError(err: unknown): err is VtxoReceiptPendingError {
  return err instanceof VtxoReceiptPendingError
}

export function isVtxoSpendInFlightError(err: unknown): err is VtxoSpendInFlightError {
  return err instanceof VtxoSpendInFlightError
}

export function isVtxoSpendUnresolvedError(err: unknown): err is VtxoSpendUnresolvedError {
  return err instanceof VtxoSpendUnresolvedError
}

export function isVtxoReviewedReservationError(err: unknown): err is VtxoReviewedReservationError {
  return err instanceof VtxoReviewedReservationError
}

export function isVtxoSameSendInProgressError(err: unknown): err is VtxoSameSendInProgressError {
  return err instanceof VtxoSameSendInProgressError
}

export function isVtxoReservedReplaceError(err: unknown): err is VtxoReservedReplaceError {
  return err instanceof VtxoReservedReplaceError
}

export function isVtxoLivePendingError(err: unknown): err is VtxoLivePendingError {
  return err instanceof VtxoLivePendingError
}

export function isVtxoAbortFailedError(err: unknown): err is VtxoAbortFailedError {
  return err instanceof VtxoAbortFailedError
}

export type PersistedVtxoSpendStage =
  | 'pre-reserve'
  | 'reserved'
  | 'authorized'
  | 'operator-submitted'
  | 'checkpoints-authorized'
  | 'operator-finalized'

export interface PersistedVtxoSpend {
  vaultId: string
  operationId: string
  bundleDigest: string
  destAddress: string
  amountSats: number
  arkTxid: string
  reservationExpires?: string
  checkpointTapscript?: string
  stage: PersistedVtxoSpendStage
  unsignedArkPsbt?: string
  authorizedPsbt?: string
  authorizedPendingProof?: string
  operatorSubmitAttempted?: boolean
  unsignedCheckpointPsbts?: string[]
  operatorCheckpointPsbts?: string[]
  checkpointPsbts?: string[]
  reservePhoneSignature?: string
  feePolicyDigest?: string
  feeSats?: number
  changeSats?: number
  changeVout?: number
  sdkBundleVersion?: 1
  reservedInputs?: { txid: string; vout: number; valueSats: number; scriptHex: string }[]
  reservedOutputs?: { scriptHex: string; amountSats: number }[]
  operatorArkPsbt?: string
}

export function vtxoSpendStorageKey(vaultId: string): string {
  return `arkade-vault-vtxo-spend:${vaultId}`
}

export function vtxoSpendJournalKey(vaultId: string): string {
  return `arkade-vault-vtxo-spend-journal:${vaultId}`
}

const MAX_VTXO_SPEND_JOURNAL = 32

function persistedReservationFactsAreValid(record: Partial<PersistedVtxoSpend>): boolean {
  if (record.stage === 'pre-reserve') return true
  const reviewFactsAreValid = Boolean(
    /^[0-9a-f]{64}$/.test(String(record.feePolicyDigest || '')) &&
      typeof record.feeSats === 'number' &&
      Number.isSafeInteger(record.feeSats) &&
      record.feeSats >= 0 &&
      typeof record.changeSats === 'number' &&
      Number.isSafeInteger(record.changeSats) &&
      record.changeSats >= 0 &&
      (record.changeSats === 0 ? record.changeVout === undefined : record.changeVout === 1),
  )
  if (!reviewFactsAreValid || record.sdkBundleVersion === undefined) return reviewFactsAreValid
  if (record.sdkBundleVersion !== 1) return false
  const inputs = record.reservedInputs
  const outputs = record.reservedOutputs
  if (!inputs || inputs.length < 1 || inputs.length > MAX_VTXO_INPUTS || !outputs) return false
  if (outputs.length !== (record.changeSats === 0 ? 1 : 2)) return false
  if (
    outputs[0]?.amountSats !== record.amountSats ||
    !/^[0-9a-f]{68}$/.test(String(outputs[0]?.scriptHex || '')) ||
    (record.changeSats !== 0 &&
      (outputs[1]?.amountSats !== record.changeSats || !/^[0-9a-f]{68}$/.test(String(outputs[1]?.scriptHex || ''))))
  ) {
    return false
  }
  let previousOutpoint = ''
  let inputTotal = 0
  for (const input of inputs) {
    if (
      !/^[0-9a-f]{64}$/.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > 0xffffffff ||
      !Number.isSafeInteger(input.valueSats) ||
      input.valueSats <= 0 ||
      !/^[0-9a-f]{68}$/.test(input.scriptHex)
    ) {
      return false
    }
    const outpoint = `${input.txid}:${input.vout.toString(16).padStart(8, '0')}`
    if (previousOutpoint && outpoint <= previousOutpoint) return false
    previousOutpoint = outpoint
    inputTotal += input.valueSats
    if (!Number.isSafeInteger(inputTotal)) return false
  }
  return inputTotal === record.amountSats! + record.feeSats! + record.changeSats!
}

function parsePersistedVtxoSpend(
  vaultId: string,
  parsed: Partial<PersistedVtxoSpend> | null,
): PersistedVtxoSpend | undefined {
  if (
    parsed &&
    parsed.vaultId === vaultId &&
    isVtxoOperationId(parsed.operationId) &&
    parsed.stage &&
    parsed.destAddress &&
    typeof parsed.amountSats === 'number' &&
    (parsed.reservePhoneSignature === undefined || /^[0-9a-f]{128}$/.test(parsed.reservePhoneSignature)) &&
    persistedReservationFactsAreValid(parsed) &&
    (parsed.stage === 'pre-reserve' || (parsed.bundleDigest && (parsed.stage === 'reserved' || parsed.arkTxid)))
  ) {
    return parsed as PersistedVtxoSpend
  }
  return undefined
}

function readVtxoSpendJournal(vaultId: string): PersistedVtxoSpend[] {
  if (typeof localStorage === 'undefined' || !vaultId) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(vtxoSpendJournalKey(vaultId)) || 'null') as {
      version?: number
      operations?: Partial<PersistedVtxoSpend>[]
    } | null
    if (parsed?.version === 1 && Array.isArray(parsed.operations)) {
      return parsed.operations
        .map((record) => parsePersistedVtxoSpend(vaultId, record))
        .filter((record): record is PersistedVtxoSpend => Boolean(record))
        .slice(0, MAX_VTXO_SPEND_JOURNAL)
    }
  } catch {
    // Fall through to the retired one-slot key.
  }
  try {
    const legacy = parsePersistedVtxoSpend(
      vaultId,
      JSON.parse(localStorage.getItem(vtxoSpendStorageKey(vaultId)) || 'null') as Partial<PersistedVtxoSpend>,
    )
    return legacy ? [legacy] : []
  } catch {
    return []
  }
}

function writeVtxoSpendJournal(vaultId: string, operations: PersistedVtxoSpend[]) {
  if (typeof localStorage === 'undefined' || !vaultId) return
  localStorage.setItem(vtxoSpendJournalKey(vaultId), JSON.stringify({ version: 1, operations }))
  localStorage.removeItem(vtxoSpendStorageKey(vaultId))
}

export function listPersistedVtxoSpends(vaultId: string): PersistedVtxoSpend[] {
  return readVtxoSpendJournal(vaultId)
}

export function loadPersistedVtxoSpend(vaultId: string): PersistedVtxoSpend | undefined {
  const operations = readVtxoSpendJournal(vaultId)
  return operations[operations.length - 1]
}

export function loadPersistedVtxoSpendById(vaultId: string, operationId: string): PersistedVtxoSpend | undefined {
  return readVtxoSpendJournal(vaultId).find((record) => record.operationId === operationId)
}

export function isVtxoOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

export function createVtxoOperationId(random?: Uint8Array): string {
  const bytes = random || crypto.getRandomValues(new Uint8Array(16))
  if (bytes.length !== 16) throw new Error('VTXO operation id requires 16 random bytes')
  return hex.encode(bytes)
}

export function preReserveVtxoSpend(
  vaultId: string,
  destAddress: string,
  amountSats: number,
  operationId = createVtxoOperationId(),
): PersistedVtxoSpend {
  if (!vaultId.trim()) throw new Error('vault id required')
  if (!isVtxoOperationId(operationId)) throw new Error('invalid VTXO operation id')
  const record: PersistedVtxoSpend = {
    vaultId,
    operationId,
    bundleDigest: '',
    destAddress: destAddress.trim(),
    amountSats,
    arkTxid: '',
    stage: 'pre-reserve',
  }
  persistVtxoSpend(record)
  return record
}

export function vtxoReserveRequest(pending: PersistedVtxoSpend, status: VaultStatus): VtxoReserveRequest {
  if (pending.stage !== 'pre-reserve' || !isVtxoOperationId(pending.operationId)) {
    throw new Error('VTXO pre-reservation required')
  }
  if (!pending.reservePhoneSignature || !reserveSignatureMatches(pending, status)) {
    throw new Error('VTXO reservation requires this device signature')
  }
  return {
    vaultId: pending.vaultId,
    operationId: pending.operationId,
    purpose: 'spend',
    destAddress: pending.destAddress,
    amountSats: pending.amountSats,
    phoneSignature: pending.reservePhoneSignature,
  }
}

export function persistVtxoSpend(record: PersistedVtxoSpend) {
  if (typeof localStorage === 'undefined') return
  const operations = readVtxoSpendJournal(record.vaultId)
  const index = operations.findIndex((candidate) => candidate.operationId === record.operationId)
  if (index >= 0) operations.splice(index, 1)
  else if (operations.length >= MAX_VTXO_SPEND_JOURNAL) {
    throw new VtxoLivePendingError(operations.map((candidate) => candidate.operationId))
  }
  operations.push(record)
  writeVtxoSpendJournal(record.vaultId, operations)
}

export function clearPersistedVtxoSpend(vaultId: string, operationId?: string) {
  if (typeof localStorage === 'undefined' || !vaultId) return
  if (!operationId) {
    localStorage.removeItem(vtxoSpendJournalKey(vaultId))
    localStorage.removeItem(vtxoSpendStorageKey(vaultId))
    return
  }
  writeVtxoSpendJournal(
    vaultId,
    readVtxoSpendJournal(vaultId).filter((record) => record.operationId !== operationId),
  )
}

function requireHex(value: string | undefined, bytes: number, name: string): Uint8Array<ArrayBuffer> {
  let decoded: Uint8Array
  try {
    decoded = hex.decode(String(value || '').toLowerCase())
  } catch {
    throw new Error(`${name} is not hex`)
  }
  if (decoded.length !== bytes) throw new Error(`${name} must be ${bytes} bytes`)
  return decoded as Uint8Array<ArrayBuffer>
}

function requireNonemptyHex(value: string | undefined, name: string): string {
  const normalized = String(value || '').toLowerCase()
  if (!normalized) throw new Error(`${name} is missing`)
  if (normalized.length % 2 !== 0) throw new Error(`${name} is not hex`)
  requireHex(normalized, normalized.length / 2, name)
  return normalized
}

function xOnly(value: string | undefined, name: string): Uint8Array {
  const raw = String(value || '').toLowerCase()
  if (/^(02|03)[0-9a-f]{64}$/.test(raw)) return hex.decode(raw.slice(2))
  return requireHex(raw, 32, name)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a?.length === b?.length && a?.every((value, index) => value === b?.[index]) === true
}

function requireEnrolledSpendingStatus(status: VaultStatus) {
  const pins = networkPins(status.network)
  if (!status.enrolled) throw new Error('regular VTXO spending requires an enrolled vault')
  if (!status.vaultId) throw new Error('vault id required')
  if (status.vtxoExitDelay !== pins.policyExitDelay) throw new Error('VTXO exit delay does not match')
  if (status.vtxoExitDelayUnit !== VAULT_POLICY_V1_EXIT_DELAY_UNIT)
    throw new Error('VTXO exit delay unit does not match')
  return pins
}

export function spendingScriptFromStatus(status: VaultStatus): VaultPolicyV1Script | LightScript {
  if (status.templateVersion === LIGHT_PROFILE) {
    const valid = requireLightStatus(status)
    return new LightScript(valid.lightDescriptor!)
  }
  return vaultPolicyV1ScriptFromStatus(status)
}

export function vaultPolicyV1ScriptFromStatus(status: VaultStatus): VaultPolicyV1Script {
  if (status.templateVersion === LIGHT_PROFILE) throw new Error('Light requires its own Spending script')
  const pins = requireEnrolledSpendingStatus(status)
  const address = ArkAddress.decode(String(status.spendingArkAddress || ''))
  if (address.hrp !== pins.arkHrp) throw new Error('spending Ark address does not match this network')
  const params: VaultPolicyV1Params = {
    userPub: xOnly(status.phoneBip340Pub, 'phone pubkey'),
    vtxoVaultCosignerPub: xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
    arkdServerPub: address.serverPubKey,
    delegatePub: xOnly(status.vtxoDelegatePub, 'delegate pubkey'),
    exitDelay: BigInt(pins.policyExitDelay),
    exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
    network: pins.network,
    exitDevicePub: xOnly(status.phoneBip340Pub, 'phone pubkey'),
    exitHardwarePub: xOnly(status.externalOwnerWalletPub, 'hardware pubkey'),
    ...(status.recoveryKeyPub || status.recoveryPub
      ? { exitRecoveryPub: xOnly(status.recoveryKeyPub || status.recoveryPub, 'recovery pubkey') }
      : {}),
  }
  const script = new VaultPolicyV1Script(params)
  const advertised = requireHex(status.spendingArkScript, 34, 'spending Ark script')
  if (!sameBytes(script.pkScript, advertised) || !sameBytes(address.pkScript, advertised)) {
    throw new Error('spending Ark address does not match vault-policy-v1')
  }
  return script
}

async function requirePinnedOperator(provider: ArkProvider, status: VaultStatus, checkpointTapscript?: string) {
  const info = await provider.getInfo()
  const pins = networkPins(status.network)
  if (info.network !== pins.operatorGetInfoNetwork) throw new Error('Operator network does not match this release')
  const address = ArkAddress.decode(String(status.spendingArkAddress || ''))
  if (!sameBytes(xOnly(info.signerPubkey, 'Operator signer pubkey'), address.serverPubKey)) {
    throw new Error('Operator signer does not match the spending address')
  }
  const reservedCheckpointTapscript = requireNonemptyHex(checkpointTapscript, 'reserved checkpoint tapscript')
  const operatorCheckpointTapscript = requireNonemptyHex(info.checkpointTapscript, 'Operator checkpoint tapscript')
  if (operatorCheckpointTapscript !== pins.checkpointTapscript) {
    throw new Error('Operator checkpoint tapscript does not match this release')
  }
  if (operatorCheckpointTapscript !== reservedCheckpointTapscript) {
    throw new Error('Operator checkpoint tapscript changed after reservation')
  }
  return info
}

async function requireCurrentReservationPolicy(
  provider: ArkProvider,
  status: VaultStatus,
  pending: PersistedVtxoSpend,
) {
  const info = await requirePinnedOperator(provider, status, pending.checkpointTapscript)
  const currentFeePolicyDigest = arkadeIntentFeePolicyDigest(info.fees.intentFee)
  if (!pending.feePolicyDigest || currentFeePolicyDigest !== pending.feePolicyDigest) {
    throw new Error('Operator fee policy changed after reservation')
  }
  return info
}

export type VtxoSpendPasskey = {
  assertion: Pick<VtxoAuthorizeRequest, 'credentialId' | 'clientDataJSON' | 'authenticatorData' | 'signature'>
  phoneSecret: Uint8Array
  scalar: Uint8Array
}

export function vtxoSpendDirectSig(auth: VtxoSpendPasskey, digestHex: string): string {
  return hex.encode(signDirectP256(auth.scalar, requireHex(digestHex, 32, 'bundle digest')))
}

export function newVtxoSpendChallenge(): string {
  return hex.encode(crypto.getRandomValues(new Uint8Array(32)))
}

async function authorizeWithPasskey(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  digestHex: string,
): Promise<VtxoSpendPasskey> {
  const digest = requireHex(digestHex, 32, 'bundle digest')
  const rpId = String(status.rpId || '').toLowerCase()
  if (!rpId || rpId !== location.hostname.toLowerCase()) {
    throw new Error('deployment RP ID does not match this signing client host')
  }
  if (status.clientOrigin !== location.origin) {
    throw new Error('deployment origin does not match this signing client origin')
  }
  const credentialId = requireHex(enrollment.credId, enrollment.credId.length / 2, 'credential id')
  const credential = (await navigator.credentials.get({
    publicKey: deviceSigningOptions(
      {
        challenge: digest,
        rpId,
        userVerification: 'required',
        extensions: prfExtension(PRF_SALT, credentialId),
      },
      credentialId,
    ),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('The operation was aborted.')
  const prf = prfFrom(credential)
  if (!prf || prf.length !== 32) throw new Error('authenticator did not return PRF')
  let scalar: Uint8Array | undefined
  try {
    const derived = await deriveDirectP256(prf)
    scalar = derived.scalar
    if (hex.encode(derived.pub) !== enrollment.phoneDirectP256 || hex.encode(derived.pub) !== status.phoneDirectP256) {
      throw new Error('passkey direct key does not match this vault')
    }
    const phoneSecret =
      status.templateVersion === LIGHT_PROFILE
        ? await unlockLightOwnerKey(
            enrollment.lightKeyBackup,
            prf,
            'passkey-prf',
            requireLightStatus(status).lightDescriptor!,
          )
        : await unwrapPhoneSecret(prf, enrollment.nonce, enrollment.ciphertext)
    const identity = SingleKey.fromPrivateKey(phoneSecret)
    if (hex.encode(await identity.compressedPublicKey()) !== enrollment.phoneBip340Pub) {
      zeroBytes(phoneSecret)
      throw new Error('phone key does not match this vault')
    }
    const response = credential.response as AuthenticatorAssertionResponse
    const scalarCopy = new Uint8Array(scalar)
    return {
      assertion: {
        credentialId: enrollment.credId,
        clientDataJSON: hex.encode(new Uint8Array(response.clientDataJSON)),
        authenticatorData: hex.encode(new Uint8Array(response.authenticatorData)),
        signature: hex.encode(new Uint8Array(response.signature)),
      },
      phoneSecret,
      scalar: scalarCopy,
    }
  } finally {
    zeroBytes(prf, scalar as Uint8Array)
  }
}

export function createVtxoSpendUnlocker(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  digestHex: string,
  unlockPasskey: (
    enrollment: EnrollmentSecrets,
    status: VaultStatus,
    digestHex: string,
  ) => Promise<VtxoSpendPasskey> = authorizeWithPasskey,
) {
  let session: VtxoSpendPasskey | undefined
  return {
    async unlock() {
      if (!session) session = await unlockPasskey(enrollment, status, digestHex)
      return session
    },
    dispose() {
      if (!session) return
      zeroBytes(session.phoneSecret, session.scalar)
      session = undefined
    },
  }
}

export type VtxoSpendUnlocker = ReturnType<typeof createVtxoSpendUnlocker>

function vtxoSpendNeedsPasskey(stage: PersistedVtxoSpendStage): boolean {
  return stage !== 'checkpoints-authorized' && stage !== 'operator-finalized'
}

export function vtxoDestinationScript(status: VaultStatus, destAddress: string): Uint8Array {
  const spendingAddress = ArkAddress.decode(String(status.spendingArkAddress || ''))
  let destination: ArkAddress
  try {
    destination = ArkAddress.decode(destAddress.trim())
  } catch {
    throw new Error('regular VTXO destination must be an Arkade address')
  }
  if (destination.hrp !== networkPins(status.network).arkHrp) {
    throw new Error('destination Arkade address does not match this network')
  }
  if (!sameBytes(destination.serverPubKey, spendingAddress.serverPubKey)) {
    throw new Error('destination belongs to another Arkade Operator')
  }
  return destination.pkScript
}

function reserveDigestInput(pending: PersistedVtxoSpend, status: VaultStatus): VtxoReserveDigestInput {
  if (pending.vaultId !== status.vaultId) throw new Error('VTXO reservation vault does not match status')
  return {
    operationId: pending.operationId,
    vaultId: pending.vaultId,
    destScript: vtxoDestinationScript(status, pending.destAddress),
    amountSats: pending.amountSats,
  }
}

function reserveSignatureMatches(pending: PersistedVtxoSpend, status: VaultStatus): boolean {
  if (!pending.reservePhoneSignature) return false
  return verifyVtxoReserveSignature(
    reserveDigestInput(pending, status),
    pending.reservePhoneSignature,
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
  )
}

/** Persist the signature before the reservation request can leave this process. */
export function persistVtxoReserveSignature(
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  phoneSecret: Uint8Array,
  auxRand?: Uint8Array,
): PersistedVtxoSpend {
  if (pending.stage !== 'pre-reserve') throw new Error('VTXO pre-reservation required')
  if (pending.reservePhoneSignature) {
    if (!reserveSignatureMatches(pending, status)) throw new Error('persisted VTXO reserve signature is invalid')
    return pending
  }
  const expectedPhone = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const signature = hex.encode(signVtxoReserveDigest(reserveDigestInput(pending, status), phoneSecret, auxRand))
  if (!verifyVtxoReserveSignature(reserveDigestInput(pending, status), signature, expectedPhone)) {
    throw new Error('phone key does not match this vault')
  }
  const next = { ...pending, reservePhoneSignature: signature }
  persistVtxoSpend(next)
  return next
}

export function buildReservedVtxoSpend(
  status: VaultStatus,
  reserve: VtxoReserveResponse,
  amountSats: number,
  destAddress: string,
  expectedFeePolicyDigest: string,
) {
  const script = spendingScriptFromStatus(status)
  if (!Number.isSafeInteger(amountSats) || amountSats < VTXO_DUST_SATS) {
    throw new Error('VTXO amount is below dust')
  }
  if (amountSats > status.txCap) throw new Error('VTXO amount exceeds the transaction cap')
  if (!/^[0-9a-f]{64}$/.test(reserve.feePolicyDigest)) throw new Error('fee policy digest is malformed')
  if (reserve.feePolicyDigest !== expectedFeePolicyDigest) throw new Error('Operator fee policy changed')
  if (!Number.isSafeInteger(reserve.feeSats) || reserve.feeSats < 0) throw new Error('reserved fee is invalid')
  if (reserve.feeSats > status.absoluteFeeCap) throw new Error('reserved fee exceeds the vault cap')
  if (amountSats + reserve.feeSats > status.periodRemaining) throw new Error('reserved total exceeds the allowance')
  if (!Number.isSafeInteger(reserve.changeSats) || reserve.changeSats < 0) {
    throw new Error('reserved change is invalid')
  }
  if (reserve.inputs.length < 1 || reserve.inputs.length > MAX_VTXO_INPUTS) {
    throw new Error(`reservation must contain 1 to ${MAX_VTXO_INPUTS} inputs`)
  }

  const policyScriptHex = hex.encode(script.pkScript)
  let previousOutpoint = ''
  let inputTotal = 0n
  for (const input of reserve.inputs) {
    if (!/^[0-9a-f]{64}$/.test(input.txid)) throw new Error('reserved input txid is malformed')
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new Error('reserved input vout is malformed')
    }
    if (!Number.isSafeInteger(input.valueSats) || input.valueSats <= 0) {
      throw new Error('reserved input value is malformed')
    }
    if (input.scriptHex !== policyScriptHex) throw new Error('reserved input is not vault-policy-v1')
    const outpoint = `${input.txid}:${input.vout.toString(16).padStart(8, '0')}`
    if (previousOutpoint && outpoint <= previousOutpoint) {
      throw new Error(outpoint === previousOutpoint ? 'duplicate reserved input' : 'reserved inputs are not canonical')
    }
    previousOutpoint = outpoint
    inputTotal += BigInt(input.valueSats)
    if (inputTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('reserved input total overflows safe sats')
  }

  const requiredTotal = BigInt(amountSats) + BigInt(reserve.feeSats) + BigInt(reserve.changeSats)
  if (inputTotal !== requiredTotal) throw new Error('reserved input total does not conserve value')
  if (reserve.destScript.toLowerCase() !== hex.encode(vtxoDestinationScript(status, destAddress))) {
    throw new Error('reserved destination does not match the requested address')
  }
  const outputs = [
    {
      script: requireHex(reserve.destScript, reserve.destScript.length / 2, 'destination script'),
      amount: BigInt(amountSats),
    },
  ]
  if (reserve.changeSats === 0) {
    if (reserve.changeVout !== undefined || reserve.changeAddress !== '' || reserve.changeScript !== '') {
      throw new Error('zero change must omit all change output facts')
    }
  } else {
    if (reserve.changeSats < VTXO_DUST_SATS) throw new Error('VTXO change is below dust')
    if (reserve.changeVout !== 1) throw new Error('change output index is not canonical')
    if (reserve.changeScript !== policyScriptHex) throw new Error('change is not vault-policy-v1')
    if (reserve.changeAddress !== status.spendingArkAddress) throw new Error('change address is not vault-policy-v1')
    outputs.push({ script: requireHex(reserve.changeScript, 34, 'change script'), amount: BigInt(reserve.changeSats) })
  }
  const checkpointTapscript = requireNonemptyHex(reserve.checkpointTapscript, 'checkpoint tapscript')
  if (checkpointTapscript !== networkPins(status.network).checkpointTapscript) {
    throw new Error('reserved checkpoint tapscript does not match this release')
  }
  const unroll = CSVMultisigTapscript.decode(
    requireHex(checkpointTapscript, checkpointTapscript.length / 2, 'checkpoint tapscript'),
  )
  return buildOffchainTx(
    reserve.inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      value: input.valueSats,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    })),
    outputs,
    unroll,
  )
}

export function buildPersistedVtxoSdkBundle(status: VaultStatus, pending: PersistedVtxoSpend) {
  if (
    pending.sdkBundleVersion !== 1 ||
    !pending.reservedInputs ||
    !pending.reservedOutputs ||
    !pending.checkpointTapscript ||
    !persistedReservationFactsAreValid(pending)
  ) {
    throw new Error('fresh SDK spend is missing its validated reservation bundle')
  }
  const script = spendingScriptFromStatus(status)
  const policyScriptHex = hex.encode(script.pkScript)
  for (const input of pending.reservedInputs) {
    if (input.scriptHex !== policyScriptHex) throw new Error('persisted SDK input is not current vault-policy-v1')
  }
  const destinationScript = hex.encode(vtxoDestinationScript(status, pending.destAddress))
  if (
    pending.reservedOutputs[0].scriptHex !== destinationScript ||
    pending.reservedOutputs[0].amountSats !== pending.amountSats
  ) {
    throw new Error('persisted SDK destination changed from the reviewed reservation')
  }
  if (pending.changeSats === 0) {
    if (pending.reservedOutputs.length !== 1) throw new Error('zero-change SDK bundle has another output')
  } else if (
    pending.reservedOutputs.length !== 2 ||
    pending.reservedOutputs[1].scriptHex !== policyScriptHex ||
    pending.reservedOutputs[1].amountSats !== pending.changeSats
  ) {
    throw new Error('persisted SDK change is not current vault-policy-v1')
  }
  const inputs = pending.reservedInputs.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    value: input.valueSats,
    tapLeafScript: script.forfeit(),
    tapTree: script.encode(),
  }))
  const outputs = pending.reservedOutputs.map((output) => ({
    script: requireHex(output.scriptHex, 34, 'persisted SDK output script'),
    amount: BigInt(output.amountSats),
  }))
  const serverUnrollScript = CSVMultisigTapscript.decode(
    requireHex(pending.checkpointTapscript, pending.checkpointTapscript.length / 2, 'persisted checkpoint tapscript'),
  )
  const rebuilt = buildOffchainTx(inputs, outputs, serverUnrollScript)
  if (rebuilt.arkTx.id !== pending.arkTxid) throw new Error('persisted SDK bundle changed the reserved Ark transaction')
  if (!pending.unsignedCheckpointPsbts?.length) throw new Error('persisted SDK bundle is missing checkpoints')
  checkpointPairsInCanonicalOrder(
    pending.unsignedCheckpointPsbts,
    rebuilt.checkpoints.map((tx) => base64.encode(tx.toPSBT())),
    'SDK rebuild',
  )
  return { inputs, outputs, serverUnrollScript, rebuilt }
}

export const VTXO_GET_PENDING_MESSAGE: Intent.GetPendingTxMessage = {
  type: 'get-pending-tx',
  expire_at: 0,
}

type PsbtInput = ReturnType<Transaction['getInput']>

function sameOptionalBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && sameBytes(a, b)
}

function sameTapLeafScripts(a: PsbtInput['tapLeafScript'], b: PsbtInput['tapLeafScript']): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.length === b.length &&
    a.every(([leftControl, leftScript], index) => {
      const right = b[index]
      return Boolean(
        right &&
          leftControl.version === right[0].version &&
          sameBytes(leftControl.internalKey, right[0].internalKey) &&
          leftControl.merklePath.length === right[0].merklePath.length &&
          leftControl.merklePath.every((node, nodeIndex) => sameBytes(node, right[0].merklePath[nodeIndex])) &&
          sameBytes(leftScript, right[1]),
      )
    })
  )
}

function requireInputShapeMatches(expected: PsbtInput, candidate: PsbtInput, context: string) {
  if (
    !sameOptionalBytes(expected.txid, candidate.txid) ||
    expected.index !== candidate.index ||
    expected.sequence !== candidate.sequence ||
    expected.sighashType !== candidate.sighashType ||
    !sameOptionalBytes(expected.tapInternalKey, candidate.tapInternalKey) ||
    !sameOptionalBytes(expected.tapMerkleRoot, candidate.tapMerkleRoot)
  ) {
    throw new Error(`${context} changed an input`)
  }
  if (expected.witnessUtxo === undefined || candidate.witnessUtxo === undefined) {
    if (expected.witnessUtxo !== candidate.witnessUtxo) throw new Error(`${context} changed an input prevout`)
  } else if (
    expected.witnessUtxo.amount !== candidate.witnessUtxo.amount ||
    !sameBytes(expected.witnessUtxo.script, candidate.witnessUtxo.script)
  ) {
    throw new Error(`${context} changed an input prevout`)
  }
  if (!sameTapLeafScripts(expected.tapLeafScript, candidate.tapLeafScript)) {
    throw new Error(`${context} changed an input tapleaf`)
  }
}

function pendingProofFromCheckpoints(unsignedCheckpointPsbts: string[]): Transaction {
  if (unsignedCheckpointPsbts.length < 1 || unsignedCheckpointPsbts.length > MAX_VTXO_INPUTS) {
    throw new Error('pending proof requires the exact reserved checkpoints')
  }
  const inputs = unsignedCheckpointPsbts.map((raw) => {
    const checkpoint = Transaction.fromPSBT(base64.decode(raw))
    if (checkpoint.inputsLength !== 1) throw new Error('pending proof checkpoint must have one input')
    return checkpoint.getInput(0)
  })
  return Intent.create(VTXO_GET_PENDING_MESSAGE, inputs, [])
}

function transactionWithoutTapscriptSignatures(tx: Transaction): Uint8Array {
  const unsigned = tx.clone()
  const inputs = (
    unsigned as unknown as {
      inputs: (PsbtInput & { unknown?: [{ type: number; key: Uint8Array }, Uint8Array][] })[]
    }
  ).inputs
  for (const input of inputs) {
    Reflect.deleteProperty(input, 'tapScriptSig')
    if (input.unknown) {
      input.unknown = input.unknown.filter(([key]) => !(key.type === 222 && hex.encode(key.key) === '74617074726565'))
    }
  }
  return unsigned.toPSBT()
}

function pendingProofWithoutTapscriptSignatures(proof: Transaction): Uint8Array {
  return transactionWithoutTapscriptSignatures(proof)
}

function requireExactTapscriptSigners(
  proof: Transaction,
  inputIndex: number,
  expectedPubkeys: Uint8Array[],
  allowedSighashTypes?: number[],
  expectedLeafHash?: Uint8Array,
) {
  const signatures = proof.getInput(inputIndex).tapScriptSig || []
  const actual = signatures.map(([data]) => hex.encode(data.pubKey)).sort()
  const expected = expectedPubkeys.map(hex.encode).sort()
  if (actual.length !== expected.length || actual.some((pubkey, index) => pubkey !== expected[index])) {
    throw new Error('pending proof has the wrong signer set')
  }
  verifyTapscriptSignatures(proof, inputIndex, expected, undefined, allowedSighashTypes, expectedLeafHash)
}

function inputSpendLeafHash(tx: Transaction, inputIndex: number): Uint8Array {
  const leaves = tx.getInput(inputIndex).tapLeafScript
  if (leaves?.length !== 1) throw new Error(`input ${inputIndex} must carry exactly one spend leaf`)
  const scriptWithVersion = leaves[0][1]
  const version = scriptWithVersion[scriptWithVersion.length - 1]
  return tapLeafHash(scriptFromTapLeafScript(leaves[0]), version)
}

export async function createPhoneSignedPendingProof(
  unsignedCheckpointPsbts: string[],
  identity: Pick<SingleKey, 'sign'>,
  phonePub: Uint8Array,
): Promise<string> {
  const proof = await identity.sign(pendingProofFromCheckpoints(unsignedCheckpointPsbts))
  for (let index = 0; index < proof.inputsLength; index++) {
    requireExactTapscriptSigners(proof, index, [phonePub], [SigHash.ALL], inputSpendLeafHash(proof, index))
  }
  return base64.encode(proof.toPSBT())
}

/** Rebuild the canonical proof and require exactly the phone and VaultCosigner signatures. */
export function requireAuthorizedPendingProof(
  unsignedCheckpointPsbts: string[],
  authorizedPendingProof: string,
  status: VaultStatus,
): string {
  const expected = pendingProofFromCheckpoints(unsignedCheckpointPsbts)
  const candidate = Transaction.fromPSBT(base64.decode(authorizedPendingProof))
  if (
    candidate.id !== expected.id ||
    candidate.inputsLength !== expected.inputsLength ||
    candidate.outputsLength !== expected.outputsLength
  ) {
    throw new Error('Vault authorization changed the pending proof')
  }
  for (let index = 0; index < expected.inputsLength; index++) {
    requireInputShapeMatches(expected.getInput(index), candidate.getInput(index), 'Vault authorization')
  }
  if (!sameBytes(pendingProofWithoutTapscriptSignatures(expected), pendingProofWithoutTapscriptSignatures(candidate))) {
    throw new Error('Vault authorization changed the pending proof PSBT')
  }
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  for (let index = 0; index < candidate.inputsLength; index++) {
    requireExactTapscriptSigners(
      candidate,
      index,
      [phonePub, vaultPub],
      [SigHash.ALL],
      inputSpendLeafHash(expected, index),
    )
  }
  return base64.encode(candidate.toPSBT())
}

function requireCheckpointShapeMatches(original: Transaction, candidate: Transaction, context = 'Operator') {
  if (original.id !== candidate.id || original.inputsLength !== 1 || candidate.inputsLength !== 1) {
    throw new Error(`${context} changed the checkpoint transaction`)
  }
  const expected = original.getInput(0)
  const submitted = candidate.getInput(0)
  if (
    !expected.witnessUtxo ||
    !submitted.witnessUtxo ||
    expected.witnessUtxo.amount !== submitted.witnessUtxo.amount ||
    !sameBytes(expected.witnessUtxo.script, submitted.witnessUtxo.script)
  ) {
    throw new Error(`${context} changed the checkpoint prevout`)
  }
  if (
    expected.tapLeafScript?.length !== 1 ||
    submitted.tapLeafScript?.length !== 1 ||
    !sameBytes(expected.tapLeafScript[0][1], submitted.tapLeafScript[0][1])
  ) {
    throw new Error(`${context} changed the checkpoint tapleaf`)
  }
  if (!sameBytes(transactionWithoutTapscriptSignatures(original), transactionWithoutTapscriptSignatures(candidate))) {
    throw new Error(`${context} changed the checkpoint PSBT`)
  }
}

export function requireOperatorSignedCheckpoint(
  original: Transaction,
  candidate: Transaction,
  operatorPub: Uint8Array,
) {
  requireCheckpointShapeMatches(original, candidate)
  const submitted = candidate.getInput(0)
  const signatures = submitted.tapScriptSig
  if (signatures?.length !== 1 || !sameBytes(signatures[0][0].pubKey, operatorPub)) {
    throw new Error('checkpoint requires exactly the Operator signature')
  }
  verifyTapscriptSignatures(
    candidate,
    0,
    [hex.encode(operatorPub)],
    undefined,
    undefined,
    inputSpendLeafHash(original, 0),
  )
}

function requireArkShapeMatches(original: Transaction, candidate: Transaction, context: string) {
  if (
    original.id !== candidate.id ||
    original.inputsLength !== candidate.inputsLength ||
    original.outputsLength !== candidate.outputsLength
  ) {
    throw new Error(`${context} changed the Ark transaction`)
  }
  for (let index = 0; index < original.inputsLength; index++) {
    requireInputShapeMatches(original.getInput(index), candidate.getInput(index), context)
  }
  if (!sameBytes(transactionWithoutTapscriptSignatures(original), transactionWithoutTapscriptSignatures(candidate))) {
    throw new Error(`${context} changed the Ark PSBT`)
  }
}

function requireNoTapscriptSignatures(tx: Transaction, context: string) {
  for (let index = 0; index < tx.inputsLength; index++) {
    if (tx.getInput(index).tapScriptSig?.length) throw new Error(`${context} is already signed`)
  }
}

export function createVaultSdkOperationValidation(
  status: VaultStatus,
  unsignedArk: Transaction,
  operatorPub: Uint8Array,
): VaultSdkOperationValidation {
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  return {
    assertArkTransaction(candidate, stage) {
      requireArkShapeMatches(unsignedArk, candidate, `${stage} SDK validation`)
      if (stage === 'unsigned') requireNoTapscriptSignatures(candidate, 'unsigned Ark transaction')
      else {
        const signers = stage === 'vault-authorized' ? [phonePub, vaultPub] : [phonePub, vaultPub, operatorPub]
        for (let index = 0; index < candidate.inputsLength; index++) {
          requireExactTapscriptSigners(candidate, index, signers, undefined, inputSpendLeafHash(unsignedArk, index))
        }
      }
    },
    assertCheckpointTransaction(candidate, expectedUnsigned, stage) {
      requireCheckpointShapeMatches(expectedUnsigned, candidate, stage)
      if (stage === 'unsigned') requireNoTapscriptSignatures(candidate, 'unsigned checkpoint')
      else if (stage === 'operator-signed') requireOperatorSignedCheckpoint(expectedUnsigned, candidate, operatorPub)
      else {
        requireExactTapscriptSigners(
          candidate,
          0,
          [operatorPub, phonePub, vaultPub],
          undefined,
          inputSpendLeafHash(expectedUnsigned, 0),
        )
      }
    },
  }
}

function checkpointPairsInCanonicalOrder(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
  context: string,
): { original: Transaction; candidate: Transaction }[] {
  if (candidateCheckpointPsbts.length !== expectedCheckpointPsbts.length) {
    throw new Error(`${context} returned the wrong checkpoint count`)
  }
  const candidates = new Map<string, Transaction>()
  for (const raw of candidateCheckpointPsbts) {
    const candidate = Transaction.fromPSBT(base64.decode(raw))
    if (candidates.has(candidate.id)) throw new Error(`${context} returned a duplicate checkpoint`)
    candidates.set(candidate.id, candidate)
  }
  const expectedIds = new Set<string>()
  const ordered = expectedCheckpointPsbts.map((raw) => {
    const original = Transaction.fromPSBT(base64.decode(raw))
    if (expectedIds.has(original.id)) throw new Error('local checkpoint identity is duplicated')
    expectedIds.add(original.id)
    const candidate = candidates.get(original.id)
    if (!candidate) throw new Error(`${context} returned an unknown or missing checkpoint`)
    requireCheckpointShapeMatches(original, candidate, context)
    candidates.delete(original.id)
    return { original, candidate }
  })
  if (candidates.size !== 0) throw new Error(`${context} returned an unknown checkpoint`)
  return ordered
}

/** Match by witness-independent checkpoint txid and restore reserved input order. */
export function matchOperatorSignedCheckpoints(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
  operatorPub: Uint8Array,
): string[] {
  return checkpointPairsInCanonicalOrder(expectedCheckpointPsbts, candidateCheckpointPsbts, 'Operator').map(
    ({ original, candidate }) => {
      requireOperatorSignedCheckpoint(original, candidate, operatorPub)
      return base64.encode(candidate.toPSBT())
    },
  )
}

type OperatorPendingTx = Awaited<ReturnType<ArkProvider['getPendingTxs']>>[number]

/** Validate the exact retained Operator result before advancing a persisted operation. */
export function matchPendingOperatorSubmission(
  pending: PersistedVtxoSpend,
  candidates: OperatorPendingTx[],
  status: VaultStatus,
  operatorPub: Uint8Array,
): { arkTxid: string; operatorArkPsbt: string; operatorCheckpointPsbts: string[] } {
  if (!pending.unsignedArkPsbt || !pending.unsignedCheckpointPsbts?.length) {
    throw new Error('persisted VTXO spend is missing its original transaction bundle')
  }
  if (candidates.length !== 1) throw new Error('Operator pending lookup did not return exactly one transaction')
  const candidate = candidates[0]
  if (candidate.arkTxid !== pending.arkTxid) throw new Error('Operator pending lookup returned another transaction')
  const originalArk = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const finalArk = Transaction.fromPSBT(base64.decode(candidate.finalArkTx))
  if (
    originalArk.id !== pending.arkTxid ||
    finalArk.id !== pending.arkTxid ||
    finalArk.inputsLength !== originalArk.inputsLength ||
    finalArk.outputsLength !== originalArk.outputsLength
  ) {
    throw new Error('Operator pending lookup changed the Ark transaction')
  }
  const expectedArkSigners = [
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
    xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
    operatorPub,
  ]
  for (let index = 0; index < originalArk.inputsLength; index++) {
    requireInputShapeMatches(originalArk.getInput(index), finalArk.getInput(index), 'Operator pending lookup')
    requireExactTapscriptSigners(finalArk, index, expectedArkSigners, undefined, inputSpendLeafHash(originalArk, index))
  }
  return {
    arkTxid: candidate.arkTxid,
    operatorArkPsbt: base64.encode(finalArk.toPSBT()),
    operatorCheckpointPsbts: matchOperatorSignedCheckpoints(
      pending.unsignedCheckpointPsbts,
      candidate.signedCheckpointTxs,
      operatorPub,
    ),
  }
}

/** Restore canonical checkpoint order after the VaultCosigner adds signatures. */
export function orderAuthorizedCheckpoints(
  expectedCheckpointPsbts: string[],
  candidateCheckpointPsbts: string[],
): string[] {
  return checkpointPairsInCanonicalOrder(expectedCheckpointPsbts, candidateCheckpointPsbts, 'Vault service').map(
    ({ candidate }) => base64.encode(candidate.toPSBT()),
  )
}

function requireFullyAuthorizedCheckpoints(
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  operatorPub: Uint8Array,
  checkpointPsbts = pending.checkpointPsbts,
): string[] {
  if (!pending.unsignedCheckpointPsbts?.length || !checkpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const phonePub = xOnly(status.phoneBip340Pub, 'phone pubkey')
  const vaultPub = xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey')
  return checkpointPairsInCanonicalOrder(pending.unsignedCheckpointPsbts, checkpointPsbts, 'Vault authorization').map(
    ({ original, candidate }) => {
      requireExactTapscriptSigners(
        candidate,
        0,
        [operatorPub, phonePub, vaultPub],
        undefined,
        inputSpendLeafHash(original, 0),
      )
      return base64.encode(candidate.toPSBT())
    },
  )
}

function requireVaultAuthorizedArk(pending: PersistedVtxoSpend, status: VaultStatus): string {
  if (!pending.unsignedArkPsbt || !pending.authorizedPsbt) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const original = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const candidate = Transaction.fromPSBT(base64.decode(pending.authorizedPsbt))
  requireArkShapeMatches(original, candidate, 'Vault authorization')
  const signers = [
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
    xOnly(status.vtxoVaultCosignerPub, 'VTXO VaultCosigner pubkey'),
  ]
  for (let index = 0; index < candidate.inputsLength; index++) {
    requireExactTapscriptSigners(candidate, index, signers, undefined, inputSpendLeafHash(original, index))
  }
  return base64.encode(candidate.toPSBT())
}

export function requireUserSignedArkInputs(arkTx: Transaction, userPub: Uint8Array) {
  for (let index = 0; index < arkTx.inputsLength; index++) {
    verifyTapscriptSignatures(
      arkTx,
      index,
      [hex.encode(userPub)],
      undefined,
      undefined,
      inputSpendLeafHash(arkTx, index),
    )
  }
}

async function finalizeVaultOperation(vaultId: string, operationId: string, bundleDigest: string, arkTxid: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result: VtxoFinalizeResponse = await vaultCosignerClient.spending.finalize({
        vaultId,
        operationId,
        bundleDigest,
        arkTxid,
      })
      if (result.state !== 'finalized' || result.arkTxid !== arkTxid)
        throw new Error('invalid VTXO finalization receipt')
      return
    } catch (err) {
      lastError = err
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('VTXO finalization receipt unavailable')
}

export function pendingVtxoSpendBlocksNewSend(pending: PersistedVtxoSpend | undefined): boolean {
  return Boolean(pending)
}

export function isSameVtxoPayment(pending: PersistedVtxoSpend, destAddress: string, amountSats: number): boolean {
  return pending.destAddress === destAddress.trim() && pending.amountSats === amountSats
}

export type VtxoNewSendAction = 'start' | 'resume' | 'abort-reserved' | 'warn' | 'live-pending'

export function vtxoSpendIsAbortable(pending: PersistedVtxoSpend): boolean {
  return pending.stage === 'pre-reserve' || pending.stage === 'reserved'
}

export function vtxoSpendIsLivePending(pending: PersistedVtxoSpend): boolean {
  return (
    pending.operatorSubmitAttempted === true ||
    pending.stage === 'authorized' ||
    pending.stage === 'operator-submitted' ||
    pending.stage === 'checkpoints-authorized' ||
    pending.stage === 'operator-finalized'
  )
}

export function vtxoNewSendAction(
  pending: PersistedVtxoSpend | undefined,
  destAddress: string,
  amountSats: number,
): VtxoNewSendAction {
  if (!pending) return 'start'
  if (isSameVtxoPayment(pending, destAddress, amountSats)) {
    if (
      pending.operatorSubmitAttempted ||
      pending.stage === 'operator-submitted' ||
      pending.stage === 'checkpoints-authorized' ||
      pending.stage === 'operator-finalized'
    ) {
      return 'warn'
    }
    return 'resume'
  }
  if (vtxoSpendIsAbortable(pending)) return 'abort-reserved'
  return 'live-pending'
}

export function vtxoJournalSendAction(
  operations: readonly PersistedVtxoSpend[],
  destAddress: string,
  amountSats: number,
): VtxoNewSendAction {
  const matching = operations.find((record) => isSameVtxoPayment(record, destAddress, amountSats))
  if (operations.some((record) => record.operationId !== matching?.operationId && vtxoSpendIsLivePending(record))) {
    return 'live-pending'
  }
  if (matching) return vtxoNewSendAction(matching, destAddress, amountSats)
  if (operations.some(vtxoSpendIsLivePending)) return 'live-pending'
  if (operations.some(vtxoSpendIsAbortable)) return 'abort-reserved'
  return operations.length ? vtxoNewSendAction(operations[operations.length - 1], destAddress, amountSats) : 'start'
}

export async function withVtxoSendLock<T>(
  vaultId: string,
  run: () => Promise<T>,
  locks: VaultLockManager | null | undefined = browserVaultLockManager(),
): Promise<T> {
  return requireVaultLockManager(locks).request(
    `arkade-vault-vtxo-send:${vaultId}`,
    { mode: 'exclusive' },
    async (lock) => {
      if (!lock) throw new Error('Web Locks API returned no exclusive send lock')
      return run()
    },
  )
}

export function fetchVtxoOperation(vaultId: string, operationId: string): Promise<VtxoOperationView> {
  return vaultCosignerClient.spending.operation(vaultId, operationId).then(vtxoOperationViewFromWire)
}

function operationNotFound(err: unknown): boolean {
  return err instanceof VaultRequestError && err.status === 404
}

const VTXO_SPEND_STAGE_RANK: Record<PersistedVtxoSpendStage, number> = {
  'pre-reserve': -1,
  reserved: 0,
  authorized: 1,
  'operator-submitted': 2,
  'checkpoints-authorized': 3,
  'operator-finalized': 4,
}

export function laterVtxoSpendStage(
  current: PersistedVtxoSpendStage,
  incoming: PersistedVtxoSpendStage,
): PersistedVtxoSpendStage {
  return VTXO_SPEND_STAGE_RANK[incoming] > VTXO_SPEND_STAGE_RANK[current] ? incoming : current
}

function stageFloorFromOperationView(state: VtxoOperationState): PersistedVtxoSpendStage | undefined {
  switch (state) {
    case 'reserved':
      return 'reserved'
    case 'signed':
      return 'authorized'
    case 'submitted':
      return 'checkpoints-authorized'
    case 'finalized':
      return 'operator-finalized'
    default:
      return undefined
  }
}

function requireRecoveryProofForAuthorizedSpend(pending: PersistedVtxoSpend) {
  if (VTXO_SPEND_STAGE_RANK[pending.stage] >= VTXO_SPEND_STAGE_RANK.authorized && !pending.authorizedPendingProof) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
}

/** Map a read-only operation view onto the local durable record. Never moves stage backward. */
export function applyVtxoOperationView(
  pending: PersistedVtxoSpend,
  view: VtxoOperationView,
): PersistedVtxoSpend | undefined {
  if (view.operationId !== pending.operationId) throw new Error('VTXO operation id mismatch')
  if (pending.stage === 'pre-reserve') {
    if (view.state === 'aborted') {
      clearPersistedVtxoSpend(pending.vaultId, pending.operationId)
      return undefined
    }
    if (view.state === 'reserved') return pending
    persistVtxoSpend(pending)
    throw new VtxoSpendUnresolvedError(view.arkTxid || '', pending.operationId)
  }
  if (view.bundleDigest && view.bundleDigest !== pending.bundleDigest) {
    throw new Error('VTXO operation digest mismatch')
  }
  const arkTxid = view.arkTxid || pending.arkTxid
  switch (view.state) {
    case 'aborted':
      clearPersistedVtxoSpend(pending.vaultId, pending.operationId)
      return undefined
    case 'unresolved':
      persistVtxoSpend({ ...pending, arkTxid })
      throw new VtxoSpendUnresolvedError(arkTxid, pending.operationId)
    default: {
      const floor = stageFloorFromOperationView(view.state)
      if (!floor) return pending
      const checkpointPsbts = view.checkpointPsbts?.length
        ? orderAuthorizedCheckpoints(pending.unsignedCheckpointPsbts || [], view.checkpointPsbts)
        : pending.checkpointPsbts
      const next: PersistedVtxoSpend = {
        ...pending,
        arkTxid,
        authorizedPsbt: view.authorizedPsbt || pending.authorizedPsbt,
        authorizedPendingProof: view.authorizedPendingProof || pending.authorizedPendingProof,
        checkpointPsbts,
        stage: laterVtxoSpendStage(pending.stage, floor),
      }
      persistVtxoSpend(next)
      return next
    }
  }
}

async function syncPersistedSpendWithOperation(pending: PersistedVtxoSpend): Promise<PersistedVtxoSpend | undefined> {
  let view: VtxoOperationView
  try {
    view = await fetchVtxoOperation(pending.vaultId, pending.operationId)
  } catch (err) {
    if (err instanceof UnknownVtxoOperationStateError) throw err
    if (operationNotFound(err)) {
      return pending
    }
    return pending
  }
  return applyVtxoOperationView(pending, view)
}

async function reservePersistedVtxoSpend(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  providedPhoneSecret?: Uint8Array,
): Promise<PersistedVtxoSpend> {
  if (!pending.reservePhoneSignature) {
    if (
      !sameBytes(
        xOnly(enrollment.phoneBip340Pub, 'enrollment phone pubkey'),
        xOnly(status.phoneBip340Pub, 'phone pubkey'),
      )
    ) {
      throw new Error('enrollment phone key does not match this vault')
    }
    const phoneSecret = providedPhoneSecret || (await unlockPhoneBip340(enrollment, status))
    try {
      pending = persistVtxoReserveSignature(pending, status, phoneSecret)
    } finally {
      if (!providedPhoneSecret) zeroBytes(phoneSecret)
    }
  }
  const reserve: VtxoReserveResponse = await vaultCosignerClient.spending.reserve(vtxoReserveRequest(pending, status))
  if (reserve.operationId !== pending.operationId) throw new Error('VTXO reservation returned a different operation id')
  const operator = new RestArkProvider(vaultArkServer(status.network))
  const info = await requirePinnedOperator(operator, status, reserve.checkpointTapscript)
  const expectedFeePolicyDigest = arkadeIntentFeePolicyDigest(info.fees.intentFee)
  const offchain = buildReservedVtxoSpend(
    status,
    reserve,
    pending.amountSats,
    pending.destAddress,
    expectedFeePolicyDigest,
  )
  const next: PersistedVtxoSpend = {
    ...pending,
    bundleDigest: reserve.bundleDigest,
    arkTxid: offchain.arkTx.id,
    reservationExpires: reserve.reservationExpires,
    checkpointTapscript: reserve.checkpointTapscript,
    stage: 'reserved',
    unsignedArkPsbt: base64.encode(offchain.arkTx.toPSBT()),
    unsignedCheckpointPsbts: offchain.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    feePolicyDigest: reserve.feePolicyDigest,
    feeSats: reserve.feeSats,
    changeSats: reserve.changeSats,
    ...(typeof reserve.changeVout === 'number' ? { changeVout: reserve.changeVout } : {}),
    sdkBundleVersion: 1,
    reservedInputs: reserve.inputs.map((input) => ({ ...input, scriptHex: input.scriptHex.toLowerCase() })),
    reservedOutputs: [
      { scriptHex: reserve.destScript.toLowerCase(), amountSats: pending.amountSats },
      ...(reserve.changeSats === 0
        ? []
        : [{ scriptHex: reserve.changeScript.toLowerCase(), amountSats: reserve.changeSats }]),
    ],
  }
  persistVtxoSpend(next)
  return next
}

export function quoteFromPersistedVtxoSpend(pending: PersistedVtxoSpend): VaultVtxoSpendQuote {
  if (
    !/^[0-9a-f]{64}$/.test(pending.bundleDigest) ||
    !pending.feePolicyDigest ||
    pending.feeSats === undefined ||
    !pending.reservationExpires ||
    !Number.isFinite(Date.parse(pending.reservationExpires)) ||
    pending.changeSats === undefined ||
    !persistedReservationFactsAreValid(pending)
  ) {
    throw new Error('persisted VTXO reservation is missing review facts')
  }
  return {
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    destAddress: pending.destAddress,
    amountSats: pending.amountSats,
    feeSats: pending.feeSats,
    feePolicyDigest: pending.feePolicyDigest,
    reservationExpires: pending.reservationExpires,
    changeSats: pending.changeSats,
    ...(pending.changeVout === undefined ? {} : { changeVout: pending.changeVout }),
  }
}

function reviewedReservationError(): never {
  throw new VtxoReviewedReservationError()
}

function sameExpiry(left: string | undefined, right: string): boolean {
  const leftMs = Date.parse(String(left || ''))
  const rightMs = Date.parse(right)
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs
}

function requireLocalReviewedVtxoQuote(
  pending: PersistedVtxoSpend | undefined,
  reviewed: VaultVtxoSpendQuote,
  nowMs = Date.now(),
): PersistedVtxoSpend {
  if (
    !pending ||
    pending.stage === 'pre-reserve' ||
    pending.operationId !== reviewed.operationId ||
    pending.bundleDigest !== reviewed.bundleDigest ||
    pending.destAddress.trim() !== reviewed.destAddress.trim() ||
    pending.amountSats !== reviewed.amountSats ||
    pending.feeSats !== reviewed.feeSats ||
    pending.feePolicyDigest !== reviewed.feePolicyDigest ||
    !sameExpiry(pending.reservationExpires, reviewed.reservationExpires) ||
    pending.changeSats !== reviewed.changeSats ||
    pending.changeVout !== reviewed.changeVout ||
    (pending.stage === 'reserved' && Date.parse(reviewed.reservationExpires) <= nowMs)
  ) {
    reviewedReservationError()
  }
  return pending
}

/** Verify the durable and server-side facts shown on Review before Operator submit. */
export function requireReviewedVtxoReservation(
  pending: PersistedVtxoSpend | undefined,
  view: VtxoOperationView,
  reviewed: VaultVtxoSpendQuote,
  nowMs = Date.now(),
): PersistedVtxoSpend {
  if (
    !pending ||
    pending.stage === 'pre-reserve' ||
    pending.operationId !== reviewed.operationId ||
    pending.bundleDigest !== reviewed.bundleDigest ||
    pending.destAddress.trim() !== reviewed.destAddress.trim() ||
    pending.amountSats !== reviewed.amountSats ||
    pending.feeSats !== reviewed.feeSats ||
    pending.feePolicyDigest !== reviewed.feePolicyDigest ||
    !sameExpiry(pending.reservationExpires, reviewed.reservationExpires) ||
    view.operationId !== reviewed.operationId ||
    view.bundleDigest !== reviewed.bundleDigest ||
    view.feeSats !== reviewed.feeSats ||
    view.feePolicyDigest !== reviewed.feePolicyDigest ||
    pending.changeSats !== reviewed.changeSats ||
    pending.changeVout !== reviewed.changeVout ||
    view.changeSats !== reviewed.changeSats ||
    view.changeVout !== reviewed.changeVout ||
    !sameExpiry(view.expiresAt, reviewed.reservationExpires) ||
    view.state === 'aborted' ||
    (view.state === 'reserved' && Date.parse(reviewed.reservationExpires) <= nowMs)
  ) {
    reviewedReservationError()
  }
  return pending
}

export async function abortPersistedVtxoSpend(
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  phoneSecret?: Uint8Array,
): Promise<void> {
  if (!vtxoSpendIsAbortable(pending)) {
    throw new VtxoLivePendingError([pending.operationId])
  }
  if (pending.stage === 'pre-reserve') {
    clearPersistedVtxoSpend(pending.vaultId, pending.operationId)
    return
  }
  if (!phoneSecret) throw new VtxoAbortFailedError('The reserved send could not be aborted.')
  try {
    const result = await vaultCosignerClient.spending.abort({
      vaultId: pending.vaultId,
      operationId: pending.operationId,
      purpose: 'spend',
      phoneSignature: hex.encode(
        signVtxoAbortDigest({ operationId: pending.operationId, vaultId: pending.vaultId }, phoneSecret),
      ),
    })
    if (result.operationId !== pending.operationId || result.state !== 'aborted') {
      throw new VtxoAbortFailedError()
    }
  } catch (err) {
    if (isVtxoAbortFailedError(err) || isVtxoLivePendingError(err)) throw err
    throw new VtxoAbortFailedError(err instanceof Error ? err.message : 'The reserved send could not be aborted.')
  }
  clearPersistedVtxoSpend(pending.vaultId, pending.operationId)
}

async function prepareVtxoSpendLocked(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  destAddress: string,
  amountSats: number,
  replaceExisting = false,
  phoneSecret?: Uint8Array,
): Promise<PersistedVtxoSpend> {
  const operations = listPersistedVtxoSpends(status.vaultId)
  const synced: PersistedVtxoSpend[] = []
  for (const record of operations) {
    const next = await syncPersistedSpendWithOperation(record)
    if (next) synced.push(next)
  }
  const matching = synced.find((record) => isSameVtxoPayment(record, destAddress, amountSats))
  const action = vtxoJournalSendAction(synced, destAddress, amountSats)
  if (action === 'warn' && matching && !replaceExisting) throw new VtxoSameSendInProgressError(matching)
  if (action === 'live-pending') {
    throw new VtxoLivePendingError(synced.filter(vtxoSpendIsLivePending).map((record) => record.operationId))
  }
  if (action === 'abort-reserved' && !replaceExisting) {
    throw new VtxoReservedReplaceError(synced.find(vtxoSpendIsAbortable)?.operationId || '')
  }
  if (action === 'abort-reserved' && replaceExisting) {
    for (const record of synced.filter(vtxoSpendIsAbortable)) {
      await abortPersistedVtxoSpend(record, status, phoneSecret)
    }
  }
  let pending =
    matching && action === 'resume' ? matching : loadPersistedVtxoSpendById(status.vaultId, matching?.operationId || '')
  if (action === 'abort-reserved' || !pending) pending = preReserveVtxoSpend(status.vaultId, destAddress, amountSats)
  if (pending.stage === 'pre-reserve') {
    pending = await reservePersistedVtxoSpend(enrollment, status, pending, phoneSecret)
  }
  return pending
}

export async function previewVaultVtxoSend(
  status: VaultStatus,
  destAddress: string,
  amountSats: number,
  options?: { replaceExisting?: boolean },
): Promise<VaultVtxoSpendQuote> {
  requireEnrolledSpendingStatus(status)
  if (!Number.isSafeInteger(amountSats) || amountSats < VTXO_DUST_SATS) throw new Error('VTXO amount is below dust')
  vtxoDestinationScript(status, destAddress)
  const operations = listPersistedVtxoSpends(status.vaultId)
  const action = vtxoJournalSendAction(operations, destAddress, amountSats)
  const pending = operations.find((record) => isSameVtxoPayment(record, destAddress, amountSats))
  if ((action === 'warn' || action === 'resume') && pending && !options?.replaceExisting) {
    return quoteFromPersistedVtxoSpend(pending)
  }
  if (action === 'live-pending') {
    throw new VtxoLivePendingError(operations.filter(vtxoSpendIsLivePending).map((record) => record.operationId))
  }
  if (action === 'abort-reserved' && !options?.replaceExisting) {
    throw new VtxoReservedReplaceError(operations.find(vtxoSpendIsAbortable)?.operationId || '')
  }
  return {
    operationId: '',
    bundleDigest: '',
    destAddress: destAddress.trim(),
    amountSats,
    feeSats: 0,
    feePolicyDigest: '',
    reservationExpires: '',
    changeSats: 0,
  }
}

/** Reserve and validate the authoritative fee. Pass an already-unlocked phone key to avoid a second Face ID. */
export async function reserveVaultVtxo(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  destAddress: string,
  amountSats: number,
  options?: { replaceExisting?: boolean; phoneSecret?: Uint8Array },
): Promise<VaultVtxoSpendQuote> {
  requireEnrolledSpendingStatus(status)
  if (!Number.isSafeInteger(amountSats) || amountSats < VTXO_DUST_SATS) throw new Error('VTXO amount is below dust')
  return withVtxoSendLock(status.vaultId, async () =>
    quoteFromPersistedVtxoSpend(
      await prepareVtxoSpendLocked(
        enrollment,
        status,
        destAddress,
        amountSats,
        Boolean(options?.replaceExisting),
        options?.phoneSecret,
      ),
    ),
  )
}

export type VtxoSpendReconcile =
  | { kind: 'idle' }
  | { kind: 'pending'; operationId: string; stage: PersistedVtxoSpendStage }
  | { kind: 'receipt-finalized'; txid: string; operationId: string }

/** Finish vault-service receipt only. Never invents a newly approved payment. */
export async function reconcilePersistedVtxoSpend(status: VaultStatus): Promise<VtxoSpendReconcile> {
  requireEnrolledSpendingStatus(status)
  return withVtxoSendLock(status.vaultId, () => reconcilePersistedVtxoSpendLocked(status))
}

async function reconcileOnePersistedVtxoSpend(
  status: VaultStatus,
  initial: PersistedVtxoSpend,
): Promise<VtxoSpendReconcile> {
  let pending: PersistedVtxoSpend | undefined = initial
  const stageBeforeSync = pending.stage
  let view: VtxoOperationView
  try {
    view = await fetchVtxoOperation(pending.vaultId, pending.operationId)
  } catch (err) {
    if (operationNotFound(err)) {
      if (vtxoSpendIsAbortable(pending)) {
        clearPersistedVtxoSpend(status.vaultId, pending.operationId)
        return { kind: 'idle' }
      }
    }
    return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
  }
  if (view.state === 'finalized') {
    if (!view.arkTxid || view.arkTxid !== pending.arkTxid) {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
    clearPersistedVtxoSpend(status.vaultId, pending.operationId)
    return { kind: 'receipt-finalized', txid: view.arkTxid, operationId: pending.operationId }
  }
  try {
    pending = applyVtxoOperationView(pending, view)
  } catch (err) {
    if (err instanceof VtxoSpendUnresolvedError) {
      return { kind: 'pending', operationId: err.operationId, stage: stageBeforeSync }
    }
    throw err
  }
  if (!pending) return { kind: 'idle' }
  try {
    requireRecoveryProofForAuthorizedSpend(pending)
  } catch {
    return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
  }
  if (pending.stage === 'operator-finalized') {
    try {
      await finalizeVaultOperation(pending.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
      clearPersistedVtxoSpend(status.vaultId, pending.operationId)
      return { kind: 'receipt-finalized', txid: pending.arkTxid, operationId: pending.operationId }
    } catch {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
  }
  if (pending.stage === 'checkpoints-authorized' && pending.checkpointPsbts?.length) {
    try {
      const operator = new RestArkProvider(vaultArkServer(status.network))
      const info = await requireCurrentReservationPolicy(operator, status, pending)
      const checkpointPsbts = requireFullyAuthorizedCheckpoints(
        pending,
        status,
        xOnly(info.signerPubkey, 'Operator signer pubkey'),
      )
      await operator.finalizeTx(pending.arkTxid, checkpointPsbts)
      persistVtxoSpend({ ...pending, stage: 'operator-finalized', checkpointPsbts })
      await finalizeVaultOperation(pending.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
      clearPersistedVtxoSpend(status.vaultId, pending.operationId)
      return { kind: 'receipt-finalized', txid: pending.arkTxid, operationId: pending.operationId }
    } catch {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
  }
  if (pending.stage === 'authorized' && pending.authorizedPsbt && pending.unsignedCheckpointPsbts?.length) {
    try {
      const operator = new RestArkProvider(vaultArkServer(status.network))
      const operatorInfo = await requireCurrentReservationPolicy(operator, status, pending)
      pending = await advanceAuthorizedVtxoSpend(
        operator,
        pending,
        status,
        xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey'),
      )
      return { kind: 'pending', operationId: pending.operationId, stage: 'operator-submitted' }
    } catch {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
  }
  return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
}

async function reconcilePersistedVtxoSpendLocked(status: VaultStatus): Promise<VtxoSpendReconcile> {
  const operations = listPersistedVtxoSpends(status.vaultId)
  if (!operations.length) return { kind: 'idle' }
  let result: VtxoSpendReconcile = { kind: 'idle' }
  for (const operation of operations) {
    const current = await reconcileOnePersistedVtxoSpend(status, operation)
    if (current.kind === 'receipt-finalized') result = current
    else if (current.kind === 'pending' && result.kind === 'idle') result = current
  }
  return result
}

async function finishOperatorFinalized(pending: PersistedVtxoSpend): Promise<VaultVtxoSpendResult> {
  const { feeSats } = quoteFromPersistedVtxoSpend(pending)
  await finalizeVaultOperation(pending.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
  clearPersistedVtxoSpend(pending.vaultId, pending.operationId)
  return { txid: pending.arkTxid, operationId: pending.operationId, feeSats }
}

async function authorizeReservedVtxoSpend(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  auth: VtxoSpendPasskey,
): Promise<PersistedVtxoSpend> {
  if (!pending.unsignedArkPsbt || !pending.unsignedCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  await requireCurrentReservationPolicy(new RestArkProvider(vaultArkServer(status.network)), status, pending)
  const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
  const arkTx = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const userSignedArk = await identity.sign(arkTx)
  requireUserSignedArkInputs(userSignedArk, xOnly(status.phoneBip340Pub, 'phone pubkey'))
  const unsignedArkPsbt = base64.encode(userSignedArk.toPSBT())
  const pendingProof = await createPhoneSignedPendingProof(
    pending.unsignedCheckpointPsbts,
    identity,
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
  )
  persistVtxoSpend({ ...pending, unsignedArkPsbt })
  const authorized: VtxoAuthorizeResponse = await vaultCosignerClient.spending.authorize({
    vaultId: status.vaultId,
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    unsignedArkPsbt,
    unsignedCheckpointPsbts: pending.unsignedCheckpointPsbts,
    pendingProof,
    ...auth.assertion,
    directSig: vtxoSpendDirectSig(auth, pending.bundleDigest),
  })
  if (
    authorized.operationId !== pending.operationId ||
    authorized.bundleDigest !== pending.bundleDigest ||
    !authorized.authorizedPsbt ||
    !authorized.authorizedPendingProof ||
    !authorized.arkTxid
  ) {
    throw new Error('invalid VTXO authorization response')
  }
  if (pending.arkTxid && authorized.arkTxid !== pending.arkTxid) {
    throw new Error('Vault authorization changed the Ark transaction')
  }
  const authorizedPendingProof = requireAuthorizedPendingProof(
    pending.unsignedCheckpointPsbts,
    authorized.authorizedPendingProof,
    status,
  )
  const next: PersistedVtxoSpend = {
    ...pending,
    unsignedArkPsbt,
    arkTxid: authorized.arkTxid,
    stage: 'authorized',
    authorizedPsbt: authorized.authorizedPsbt,
    authorizedPendingProof,
  }
  // The Guardian and SDK may order PSBT fields differently. Validate the
  // complete signed bundle, then persist the same serialization the SDK uses.
  next.authorizedPsbt = requireVaultAuthorizedArk(next, status)
  persistVtxoSpend(next)
  const persisted = loadPersistedVtxoSpendById(next.vaultId, next.operationId)
  if (
    persisted?.operationId !== next.operationId ||
    persisted.stage !== 'authorized' ||
    persisted.authorizedPendingProof !== authorizedPendingProof
  ) {
    throw new Error('authorized pending proof was not durably persisted')
  }
  return persisted
}

function persistOperatorSubmission(
  pending: PersistedVtxoSpend,
  matched: ReturnType<typeof matchPendingOperatorSubmission>,
): PersistedVtxoSpend {
  const next: PersistedVtxoSpend = {
    ...pending,
    arkTxid: matched.arkTxid,
    stage: 'operator-submitted',
    operatorArkPsbt: matched.operatorArkPsbt,
    operatorCheckpointPsbts: matched.operatorCheckpointPsbts,
  }
  persistVtxoSpend(next)
  return next
}

async function recoverAuthorizedVtxoSpend(
  operator: ArkProvider,
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  operatorPub: Uint8Array,
  proof: string,
): Promise<PersistedVtxoSpend> {
  const lookup = { proof, message: VTXO_GET_PENDING_MESSAGE }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidates = await operator.getPendingTxs(lookup)
    if (candidates.length > 0) {
      return persistOperatorSubmission(
        pending,
        matchPendingOperatorSubmission(pending, candidates, status, operatorPub),
      )
    }
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Operator pending lookup did not return exactly one transaction')
}

async function submitAuthorizedVtxoSpendOnce(
  operator: ArkProvider,
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  operatorPub: Uint8Array,
): Promise<PersistedVtxoSpend> {
  if (!pending.authorizedPsbt || !pending.unsignedCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const submitted = await operator.submitTx(pending.authorizedPsbt, pending.unsignedCheckpointPsbts)
  return persistOperatorSubmission(pending, matchPendingOperatorSubmission(pending, [submitted], status, operatorPub))
}

function persistOperatorSubmitAttempt(pending: PersistedVtxoSpend): PersistedVtxoSpend {
  const next = { ...pending, operatorSubmitAttempted: true }
  persistVtxoSpend(next)
  const persisted = loadPersistedVtxoSpendById(next.vaultId, next.operationId)
  if (
    persisted?.operationId !== next.operationId ||
    persisted.stage !== 'authorized' ||
    persisted.operatorSubmitAttempted !== true
  ) {
    throw new Error('Operator submission attempt was not durably persisted')
  }
  return persisted
}

export async function advanceAuthorizedVtxoSpend(
  operator: ArkProvider,
  pending: PersistedVtxoSpend,
  status: VaultStatus,
  operatorPub: Uint8Array,
): Promise<PersistedVtxoSpend> {
  if (!pending.authorizedPendingProof) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const authorizedPendingProof = pending.authorizedPendingProof
  pending = { ...pending, authorizedPsbt: requireVaultAuthorizedArk(pending, status) }
  const proof = requireAuthorizedPendingProof(pending.unsignedCheckpointPsbts || [], authorizedPendingProof, status)
  if (pending.operatorSubmitAttempted) {
    return recoverAuthorizedVtxoSpend(operator, pending, status, operatorPub, proof)
  }
  const attempted = persistOperatorSubmitAttempt(pending)
  try {
    return await submitAuthorizedVtxoSpendOnce(operator, attempted, status, operatorPub)
  } catch {
    return recoverAuthorizedVtxoSpend(operator, attempted, status, operatorPub, proof)
  }
}

async function authorizeSubmittedVtxoCheckpoints(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  operatorPub: Uint8Array,
  auth: VtxoSpendPasskey,
): Promise<PersistedVtxoSpend> {
  if (pending.stage !== 'operator-submitted' || !pending.operatorCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
  const userAndOperatorCheckpoints: string[] = []
  for (const [index, raw] of pending.operatorCheckpointPsbts.entries()) {
    const checkpoint = Transaction.fromPSBT(base64.decode(raw))
    const original = pending.unsignedCheckpointPsbts?.[index]
      ? Transaction.fromPSBT(base64.decode(pending.unsignedCheckpointPsbts[index]))
      : checkpoint
    requireOperatorSignedCheckpoint(original, checkpoint, operatorPub)
    userAndOperatorCheckpoints.push(base64.encode((await identity.sign(checkpoint)).toPSBT()))
  }
  const checkpoints: VtxoCheckpointAuthorizeResponse = await vaultCosignerClient.spending.authorizeCheckpoints({
    vaultId: status.vaultId,
    operationId: pending.operationId,
    bundleDigest: pending.bundleDigest,
    checkpointPsbts: userAndOperatorCheckpoints,
  })
  if (
    checkpoints.operationId !== pending.operationId ||
    checkpoints.bundleDigest !== pending.bundleDigest ||
    checkpoints.arkTxid !== pending.arkTxid
  ) {
    throw new Error('invalid checkpoint authorization response')
  }
  const checkpointPsbts = requireFullyAuthorizedCheckpoints(
    pending,
    status,
    operatorPub,
    orderAuthorizedCheckpoints(userAndOperatorCheckpoints, checkpoints.checkpointPsbts),
  )
  const next: PersistedVtxoSpend = { ...pending, stage: 'checkpoints-authorized', checkpointPsbts }
  persistVtxoSpend(next)
  const persisted = loadPersistedVtxoSpendById(next.vaultId, next.operationId)
  if (
    persisted?.operationId !== next.operationId ||
    persisted.stage !== 'checkpoints-authorized' ||
    persisted.checkpointPsbts?.length !== checkpointPsbts.length
  ) {
    throw new Error('authorized checkpoints were not durably persisted')
  }
  return persisted
}

async function completeFreshSdkVtxoSpend(
  status: VaultStatus,
  initial: PersistedVtxoSpend,
  unlocker: VtxoSpendUnlocker,
): Promise<VaultVtxoSpendResult> {
  const bundle = buildPersistedVtxoSdkBundle(status, initial)
  const operator = new RestArkProvider(vaultArkServer(status.network))
  const operatorInfo = await requireCurrentReservationPolicy(operator, status, initial)
  const operatorPub = xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey')
  let pending = initial
  const feeSats = quoteFromPersistedVtxoSpend(initial).feeSats
  const txid = await submitExactVaultSdkOperation({
    inputs: bundle.inputs,
    outputs: bundle.outputs,
    serverUnrollScript: bundle.serverUnrollScript,
    verifyServerSignatures: { serverPubkey: operatorPub },
    validation: createVaultSdkOperationValidation(status, bundle.rebuilt.arkTx, operatorPub),
    timeoutMs: 3 * 60_000,
    callbacks: {
      async authorizeArk({ unsignedArkPsbt, unsignedCheckpointPsbts, signal }) {
        if (signal.aborted) throw signal.reason
        if (
          unsignedArkPsbt !== pending.unsignedArkPsbt ||
          !sameStrings(unsignedCheckpointPsbts, pending.unsignedCheckpointPsbts)
        ) {
          throw new Error('SDK rebuilt a different reserved transaction bundle')
        }
        pending = await authorizeReservedVtxoSpend(status, pending, await unlocker.unlock())
        if (!pending.authorizedPsbt) throw new Error('Vault authorization omitted the Ark PSBT')
        return { authorizedArkPsbt: pending.authorizedPsbt }
      },
      async submitOperator({ authorizedArkPsbt, unsignedCheckpointPsbts, signal }) {
        if (signal.aborted) throw signal.reason
        if (
          authorizedArkPsbt !== pending.authorizedPsbt ||
          !sameStrings(unsignedCheckpointPsbts, pending.unsignedCheckpointPsbts)
        ) {
          throw new Error('SDK submitted a different Vault-authorized bundle')
        }
        pending = await advanceAuthorizedVtxoSpend(operator, pending, status, operatorPub)
        if (!pending.authorizedPsbt || !pending.operatorArkPsbt || !pending.operatorCheckpointPsbts?.length) {
          throw new Error('Operator submission was not durably persisted')
        }
        return {
          arkTxid: pending.arkTxid,
          finalArkTx: pending.operatorArkPsbt,
          signedCheckpointTxs: pending.operatorCheckpointPsbts,
        }
      },
      async authorizeCheckpoints({ signal }) {
        if (signal.aborted) throw signal.reason
        pending = await authorizeSubmittedVtxoCheckpoints(status, pending, operatorPub, await unlocker.unlock())
        return { authorizedCheckpointPsbts: pending.checkpointPsbts! }
      },
      dispose: unlocker.dispose,
      async finalize({ authorizedCheckpointPsbts }) {
        pending = { ...pending, checkpointPsbts: authorizedCheckpointPsbts }
        await requireCurrentReservationPolicy(operator, status, pending)
        await operator.finalizeTx(pending.arkTxid, authorizedCheckpointPsbts)
        pending = { ...pending, stage: 'operator-finalized', checkpointPsbts: authorizedCheckpointPsbts }
        persistVtxoSpend(pending)
        try {
          await finalizeVaultOperation(status.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
        } catch {
          throw new VtxoReceiptPendingError(pending.arkTxid, pending.operationId, feeSats)
        }
        clearPersistedVtxoSpend(status.vaultId, pending.operationId)
      },
    },
  })
  return { txid, operationId: initial.operationId, feeSats }
}

async function continueSameVtxoSpend(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  unlocker: VtxoSpendUnlocker,
): Promise<VaultVtxoSpendResult> {
  if (pending.stage === 'pre-reserve') {
    pending = await reservePersistedVtxoSpend(enrollment, status, pending, (await unlocker.unlock()).phoneSecret)
  }
  if (pending.stage === 'reserved' && pending.sdkBundleVersion === 1) {
    return completeFreshSdkVtxoSpend(status, pending, unlocker)
  }
  requireRecoveryProofForAuthorizedSpend(pending)
  const operator = new RestArkProvider(vaultArkServer(status.network))
  if (pending.stage === 'operator-finalized') return finishOperatorFinalized(pending)
  if (pending.stage === 'checkpoints-authorized' && pending.checkpointPsbts?.length) {
    const info = await requireCurrentReservationPolicy(operator, status, pending)
    const checkpointPsbts = requireFullyAuthorizedCheckpoints(
      pending,
      status,
      xOnly(info.signerPubkey, 'Operator signer pubkey'),
    )
    await operator.finalizeTx(pending.arkTxid, checkpointPsbts)
    persistVtxoSpend({ ...pending, stage: 'operator-finalized', checkpointPsbts })
    return finishOperatorFinalized({ ...pending, stage: 'operator-finalized', checkpointPsbts })
  }
  if (pending.stage === 'reserved') {
    pending = await authorizeReservedVtxoSpend(status, pending, await unlocker.unlock())
  }
  if (pending.stage === 'authorized' && pending.authorizedPsbt && pending.unsignedCheckpointPsbts?.length) {
    const operatorInfo = await requireCurrentReservationPolicy(operator, status, pending)
    const operatorPub = xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey')
    pending = await advanceAuthorizedVtxoSpend(operator, pending, status, operatorPub)
  }
  if (pending.stage !== 'operator-submitted' || !pending.operatorCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const operatorInfo = await requireCurrentReservationPolicy(operator, status, pending)
  pending = await authorizeSubmittedVtxoCheckpoints(
    status,
    pending,
    xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey'),
    await unlocker.unlock(),
  )
  const checkpointPsbts = pending.checkpointPsbts!
  await requireCurrentReservationPolicy(operator, status, pending)
  await operator.finalizeTx(pending.arkTxid, checkpointPsbts)
  persistVtxoSpend({ ...pending, stage: 'operator-finalized', checkpointPsbts })
  try {
    await finalizeVaultOperation(status.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
  } catch {
    throw new VtxoReceiptPendingError(
      pending.arkTxid,
      pending.operationId,
      quoteFromPersistedVtxoSpend(pending).feeSats,
    )
  }
  clearPersistedVtxoSpend(status.vaultId, pending.operationId)
  return {
    txid: pending.arkTxid,
    operationId: pending.operationId,
    feeSats: quoteFromPersistedVtxoSpend(pending).feeSats,
  }
}

export async function sendVaultVtxo(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  reviewed: VaultVtxoSpendQuote,
  createUnlocker: typeof createVtxoSpendUnlocker = createVtxoSpendUnlocker,
): Promise<VaultVtxoSpendResult> {
  requireEnrolledSpendingStatus(status)
  if (!Number.isSafeInteger(reviewed.amountSats) || reviewed.amountSats < VTXO_DUST_SATS) {
    throw new VtxoReviewedReservationError()
  }
  const local = requireLocalReviewedVtxoQuote(
    loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId) || loadPersistedVtxoSpend(status.vaultId),
    reviewed,
  )
  const unlocker = createUnlocker(enrollment, status, reviewed.bundleDigest)
  try {
    if (vtxoSpendNeedsPasskey(local.stage)) await unlocker.unlock()
    return await withVtxoSendLock(status.vaultId, async () => {
      const pending =
        loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId) || loadPersistedVtxoSpend(status.vaultId)
      if (!pending) throw new VtxoReviewedReservationError()
      let view: VtxoOperationView
      try {
        view = await fetchVtxoOperation(status.vaultId, reviewed.operationId)
      } catch (err) {
        if (operationNotFound(err) || (err instanceof Error && err.message.toLowerCase().includes('expired'))) {
          clearPersistedVtxoSpend(status.vaultId, reviewed.operationId)
          throw new VtxoReviewedReservationError()
        }
        throw err
      }
      requireReviewedVtxoReservation(pending, view, reviewed)
      const synced = applyVtxoOperationView(pending, view)
      if (!synced) throw new VtxoReviewedReservationError()
      return continueSameVtxoSpend(enrollment, status, synced, unlocker)
    })
  } finally {
    unlocker.dispose()
  }
}
