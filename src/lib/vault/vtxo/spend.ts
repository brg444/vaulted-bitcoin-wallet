import { ArkAddress, ChainedTxType, RestArkProvider, SingleKey, Transaction, type ArkProvider } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { VaultRequestError } from '../api'
import { deriveDirectP256, signDirectP256, zeroBytes } from '../ceremony/directauth'
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
  type VtxoReserveResponse,
} from '../cosignerClient'
import { networkPins, vaultOperatorOrigin } from '../networkPins'
import { PRF_SALT, unwrapPhoneSecret } from '../prfEnvelope'
import { readCommittedRecoveryCoverage, type CommittedRecoveryCoverage } from '../recovery/committedCoverage'
import { validateExitArchive, type ExitArchive } from '../recovery/exitArchive'
import { recoveryFileStore } from '../recovery/fileStore'
import { retainFinalizationRecovery } from '../recovery/finalization'
import { unlockPhoneBip340 } from '../savingsSpend'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { deviceSigningOptions, prfExtension, prfFrom } from '../webauthn'
import { arkadeIntentFeePolicyDigest } from './feePolicy'
import { withVtxoSendLock } from './lock'
import { signVtxoAbortDigest, signVtxoReserveDigest, verifyVtxoReserveSignature } from './reserveAuth'
import { submitExactVaultSdkOperation } from './sdkOperationAdapter'
import {
  isVtxoAbortFailedError,
  isVtxoLivePendingError,
  VtxoAbortFailedError,
  VtxoLivePendingError,
  VtxoReceiptPendingError,
  VtxoReservedReplaceError,
  VtxoReviewedReservationError,
  VtxoSameSendInProgressError,
  VtxoSpendInFlightError,
  VtxoSpendUnresolvedError,
} from './spendingErrors'
import {
  clearPersistedVtxoSpend,
  laterVtxoSpendStage,
  listPersistedVtxoSpends,
  loadPersistedVtxoSpend,
  loadPersistedVtxoSpendById,
  persistVtxoSpend,
  preReserveVtxoSpend,
  VTXO_SPEND_STAGE_RANK,
  vtxoReserveRequest,
} from './spendingJournal'
import {
  buildPersistedVtxoSdkBundle,
  buildReservedVtxoSpend,
  checkpointPairsInCanonicalOrder,
  createPhoneSignedPendingProof,
  createVaultSdkOperationValidation,
  matchPendingOperatorSubmission,
  orderAuthorizedCheckpoints,
  persistedReservationFactsAreValid,
  requireAuthorizedPendingProof,
  requireEnrolledSpendingStatus,
  requireFullyAuthorizedCheckpoints,
  requireHex,
  requireNonemptyHex,
  requireOperatorSignedCheckpoint,
  requireUserSignedArkInputs,
  requireVaultAuthorizedArk,
  reserveDigestInput,
  reserveSignatureMatches,
  sameBytes,
  sameStrings,
  VTXO_DUST_SATS,
  VTXO_GET_PENDING_MESSAGE,
  vtxoDestinationScript,
  xOnly,
  type PersistedVtxoSpend,
  type PersistedVtxoSpendStage,
} from './spendingTransaction'
import { fetchVaultWalletVtxoSnapshot } from './walletWorker'
import { vaultExitRepository } from './exitRepository'
export type { VtxoOperationState, VtxoOperationView, VtxoReserveResponse } from '../cosignerClient'

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
  signal?: AbortSignal,
): Promise<VtxoSpendPasskey> {
  signal?.throwIfAborted()
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
    signal,
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
  let phoneSecret: Uint8Array | undefined
  let transferred = false
  let scalar: Uint8Array | undefined
  try {
    signal?.throwIfAborted()
    const derived = await deriveDirectP256(prf)
    scalar = derived.scalar
    if (hex.encode(derived.pub) !== enrollment.phoneDirectP256 || hex.encode(derived.pub) !== status.phoneDirectP256) {
      throw new Error('passkey direct key does not match this vault')
    }
    signal?.throwIfAborted()
    phoneSecret = await unwrapPhoneSecret(prf, enrollment.nonce, enrollment.ciphertext)
    const identity = SingleKey.fromPrivateKey(phoneSecret)
    if (hex.encode(await identity.compressedPublicKey()) !== enrollment.phoneBip340Pub) {
      zeroBytes(phoneSecret)
      throw new Error('phone key does not match this vault')
    }
    signal?.throwIfAborted()
    const response = credential.response as AuthenticatorAssertionResponse
    const scalarCopy = new Uint8Array(scalar)
    transferred = true
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
    if (!transferred && phoneSecret) zeroBytes(phoneSecret)
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
    signal?: AbortSignal,
  ) => Promise<VtxoSpendPasskey> = authorizeWithPasskey,
  signal?: AbortSignal,
) {
  let session: VtxoSpendPasskey | undefined
  let pending: Promise<VtxoSpendPasskey> | undefined
  let disposed = false
  const requireOpen = () => {
    signal?.throwIfAborted()
    if (disposed) throw new DOMException('Signing approval ended', 'AbortError')
  }
  return {
    async unlock() {
      requireOpen()
      if (session) return session
      if (!pending)
        pending = unlockPasskey(enrollment, status, digestHex, signal)
          .then((auth) => {
            try {
              requireOpen()
            } catch (error) {
              zeroBytes(auth.phoneSecret, auth.scalar)
              throw error
            }
            session = auth
            return auth
          })
          .finally(() => {
            pending = undefined
          })
      return pending
    },
    dispose() {
      disposed = true
      if (session) zeroBytes(session.phoneSecret, session.scalar)
      session = undefined
    },
  }
}

export type VtxoSpendUnlocker = ReturnType<typeof createVtxoSpendUnlocker>

function vtxoSpendNeedsPasskey(stage: PersistedVtxoSpendStage): boolean {
  return stage !== 'checkpoints-authorized' && stage !== 'operator-finalized'
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

export function fetchVtxoOperation(vaultId: string, operationId: string): Promise<VtxoOperationView> {
  return vaultCosignerClient.spending.operation(vaultId, operationId).then(vtxoOperationViewFromWire)
}

function operationNotFound(err: unknown): boolean {
  return err instanceof VaultRequestError && err.status === 404
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
      // Aborted releases pre-signing reservations. A signed operation the
      // service reports as aborted is contradictory: retain the exact
      // immutable operation and signed bytes for attention instead.
      if (!vtxoSpendIsAbortable(pending)) {
        persistVtxoSpend({ ...pending, arkTxid })
        throw new VtxoSpendUnresolvedError(arkTxid, pending.operationId)
      }
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
  signal?: AbortSignal,
): Promise<PersistedVtxoSpend> {
  signal?.throwIfAborted()
  if (!pending.reservePhoneSignature) {
    if (
      !sameBytes(
        xOnly(enrollment.phoneBip340Pub, 'enrollment phone pubkey'),
        xOnly(status.phoneBip340Pub, 'phone pubkey'),
      )
    ) {
      throw new Error('enrollment phone key does not match this vault')
    }
    const phoneSecret = providedPhoneSecret || (await unlockPhoneBip340(enrollment, status, signal))
    try {
      signal?.throwIfAborted()
      pending = persistVtxoReserveSignature(pending, status, phoneSecret)
    } finally {
      if (!providedPhoneSecret) zeroBytes(phoneSecret)
    }
  }
  signal?.throwIfAborted()
  const reserve: VtxoReserveResponse = await vaultCosignerClient.spending.reserve(vtxoReserveRequest(pending, status))
  if (reserve.operationId !== pending.operationId) throw new Error('VTXO reservation returned a different operation id')
  const operator = new RestArkProvider(vaultOperatorOrigin(status.network))
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
  signal?: AbortSignal,
  replacementIds?: readonly string[],
): Promise<PersistedVtxoSpend> {
  signal?.throwIfAborted()
  const operations = listPersistedVtxoSpends(status.vaultId)
  const synced: PersistedVtxoSpend[] = []
  for (const record of operations) {
    const next = await syncPersistedSpendWithOperation(record)
    signal?.throwIfAborted()
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
    if (
      replacementIds &&
      JSON.stringify(
        synced
          .filter(vtxoSpendIsAbortable)
          .map((r) => r.operationId)
          .sort(),
      ) !== JSON.stringify([...replacementIds].sort())
    )
      throw new VtxoReservedReplaceError(synced.find(vtxoSpendIsAbortable)?.operationId || '')
    for (const record of synced.filter(vtxoSpendIsAbortable)) {
      signal?.throwIfAborted()
      await abortPersistedVtxoSpend(record, status, phoneSecret)
      signal?.throwIfAborted()
    }
  }
  signal?.throwIfAborted()
  let pending =
    matching && action === 'resume' ? matching : loadPersistedVtxoSpendById(status.vaultId, matching?.operationId || '')
  if (action === 'abort-reserved' || !pending) pending = preReserveVtxoSpend(status.vaultId, destAddress, amountSats)
  if (pending.stage === 'pre-reserve') {
    pending = await reservePersistedVtxoSpend(enrollment, status, pending, phoneSecret, signal)
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
  options?: {
    replaceExisting?: boolean
    phoneSecret?: Uint8Array
    signal?: AbortSignal
    replacementIds?: readonly string[]
  },
): Promise<VaultVtxoSpendQuote> {
  options?.signal?.throwIfAborted()
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
        options?.signal,
        options?.replacementIds,
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
    // The service receipt is observed, but the journal retires only through
    // the coverage acknowledgment below so reload and independent completion
    // keep the exact immutable operation and signed bytes.
    try {
      const synced = applyVtxoOperationView(pending, view)
      if (synced) pending = synced
    } catch (err) {
      if (!(err instanceof VtxoSpendUnresolvedError)) throw err
    }
    try {
      await retireFinalizedVtxoSpendLocked(status, pending.operationId)
    } catch {
      // Evidence lag keeps the journal; the next reconcile resumes retirement.
    }
    return { kind: 'receipt-finalized', txid: pending.arkTxid, operationId: pending.operationId }
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
      await retireFinalizedVtxoSpendLocked(status, pending.operationId).catch(() => false)
      return { kind: 'receipt-finalized', txid: pending.arkTxid, operationId: pending.operationId }
    } catch {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
  }
  if (pending.stage === 'checkpoints-authorized' && pending.checkpointPsbts?.length) {
    try {
      const operator = new RestArkProvider(vaultOperatorOrigin(status.network))
      const info = await requireCurrentReservationPolicy(operator, status, pending)
      const checkpointPsbts = requireFullyAuthorizedCheckpoints(
        pending,
        status,
        xOnly(info.signerPubkey, 'Operator signer pubkey'),
      )
      await retainFinalizationRecovery(status, { ...pending, checkpointPsbts })
      await operator.finalizeTx(pending.arkTxid, checkpointPsbts)
      persistVtxoSpend({ ...pending, stage: 'operator-finalized', checkpointPsbts })
      await finalizeVaultOperation(pending.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
      // Retirement is independently retried; evidence lag must not mask success here.
      await retireFinalizedVtxoSpendLocked(status, pending.operationId).catch(() => false)
      return { kind: 'receipt-finalized', txid: pending.arkTxid, operationId: pending.operationId }
    } catch {
      return { kind: 'pending', operationId: pending.operationId, stage: pending.stage }
    }
  }
  if (pending.stage === 'authorized' && pending.authorizedPsbt && pending.unsignedCheckpointPsbts?.length) {
    try {
      const operator = new RestArkProvider(vaultOperatorOrigin(status.network))
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

function spendingSuccessorChangeCovered(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  coverage: CommittedRecoveryCoverage,
): boolean {
  if ((pending.changeSats ?? 0) <= 0) return true
  if (pending.changeVout === undefined) return false
  return coverage.outputs.some(
    (coin) =>
      coin.txid === pending.arkTxid &&
      coin.vout === pending.changeVout &&
      coin.value === pending.changeSats &&
      coin.script === status.spendingArkScript,
  )
}

/** Bind the service receipt to the exact immutable local operation. Optional
 * review-time economics must agree when the service reports them; absent
 * fields cannot establish economics and are covered by history and the
 * committed file instead. */
function receiptBindsImmutableOperation(pending: PersistedVtxoSpend, view: VtxoOperationView): boolean {
  if (view.operationId !== pending.operationId) return false
  if (view.bundleDigest !== pending.bundleDigest) return false
  if (!view.arkTxid || view.arkTxid !== pending.arkTxid) return false
  if (view.feeSats !== undefined && view.feeSats !== pending.feeSats) return false
  if (view.feePolicyDigest !== undefined && view.feePolicyDigest !== pending.feePolicyDigest) return false
  if (view.changeSats !== undefined && view.changeSats !== pending.changeSats) return false
  if ((view.changeVout ?? undefined) !== pending.changeVout) return false
  return true
}

/** Prove the signed successor is independently durable.
 *
 * When this device holds the operator-signed successor, the stored
 * finalization archive must validate against the enrolled account and its
 * archived bytes must pass the retained phone/vault/operator signature
 * validation anchored on the pinned Operator identity. When the operation
 * finalized without a local operator result, the exit repository must hold
 * the exact validated successor and its required ancestors instead. Anything
 * short of that retains the journal for recovery. */
async function spendingSuccessorArchiveCovers(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
): Promise<boolean> {
  if (!pending.operatorArkPsbt) return exitRepositorySuccessorCovers(status, pending)
  const archive = await recoveryFileStore<ExitArchive>(
    `finalization:${status.network}:${status.vaultId}:${pending.arkTxid}`,
  )
  if (!archive) return false
  try {
    validateExitArchive(archive, {
      network: status.network,
      scriptPubKey: String(status.spendingArkScript),
      descriptorHash: status.vaultId,
    })
    if (
      !pending.unsignedArkPsbt ||
      !pending.unsignedCheckpointPsbts?.length ||
      !pending.checkpointPsbts?.length
    )
      return false
    const operatorPub = await spendingOperatorPub(status, pending.checkpointTapscript)
    const unsignedArk = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
    const validation = createVaultSdkOperationValidation(status, unsignedArk, operatorPub)
    const storedArk = archive.transactions[pending.arkTxid]
    if (!storedArk) return false
    const archivedArk = Transaction.fromPSBT(base64.decode(storedArk))
    if (archivedArk.id !== pending.arkTxid) return false
    validation.assertArkTransaction(archivedArk, 'operator-signed')
    const archivedCheckpoints: string[] = []
    for (const raw of pending.checkpointPsbts) {
      const id = Transaction.fromPSBT(base64.decode(raw)).id
      const stored = archive.transactions[id]
      if (!stored) return false
      archivedCheckpoints.push(stored)
    }
    const pairs = checkpointPairsInCanonicalOrder(
      pending.unsignedCheckpointPsbts,
      archivedCheckpoints,
      'Recovery',
    )
    for (const { original, candidate } of pairs)
      validation.assertCheckpointTransaction(candidate, original, 'vault-authorized')
    if (!successorCarriesChange(status, pending, archivedArk)) return false
  } catch {
    return false
  }
  return true
}

/** Resolve the pinned Operator identity exactly like every other sensitive
 * step, so archived signatures verify against the enrolled release. */
async function spendingOperatorPub(
  status: VaultStatus,
  checkpointTapscript: string | undefined,
): Promise<Uint8Array> {
  const info = await requirePinnedOperator(
    new RestArkProvider(vaultOperatorOrigin(status.network)),
    status,
    checkpointTapscript,
  )
  return xOnly(info.signerPubkey, 'Operator signer pubkey')
}

/** Fallback for operations that finalized without a local operator result:
 * the exit repository must hold the exact successor, its required ancestors
 * and the change output. Absence from a saved output list alone proves
 * nothing, and a stale file never satisfies this tier. */
async function exitRepositorySuccessorCovers(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
): Promise<boolean> {
  if (!pending.unsignedArkPsbt) return false
  const repository = vaultExitRepository(status.vaultId, status.network)
  try {
    const operatorPub = await spendingOperatorPub(status, pending.checkpointTapscript)
    const stored = await repository.getVirtualTx(pending.arkTxid)
    if (!stored?.psbt) return false
    const successor = Transaction.fromPSBT(base64.decode(stored.psbt))
    if (successor.id !== pending.arkTxid) return false
    const unsignedArk = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
    const validation = createVaultSdkOperationValidation(status, unsignedArk, operatorPub)
    try {
      validation.assertArkTransaction(successor, 'operator-signed')
    } catch {
      return false
    }
    if (pending.checkpointPsbts?.length) {
      for (const raw of pending.checkpointPsbts) {
        const node = await repository.getVirtualTx(Transaction.fromPSBT(base64.decode(raw)).id)
        if (!node) return false
      }
    }
    const seen = new Set<string>([successor.id])
    const queue: string[] = []
    const enqueueInputs = (tx: Transaction): boolean => {
      for (let index = 0; index < tx.inputsLength; index++) {
        const prev = tx.getInput(index).txid
        if (!prev?.length) return false
        queue.push(hex.encode(prev))
      }
      return true
    }
    if (!enqueueInputs(successor)) return false
    while (queue.length) {
      if (seen.size > 512) return false
      const txid = queue.shift()!
      if (seen.has(txid)) continue
      const node = await repository.getVirtualTx(txid)
      if (!node) return false
      if (node.type === ChainedTxType.Commitment) {
        seen.add(txid)
        continue
      }
      if (!node.psbt) return false
      let ancestor: Transaction
      try {
        ancestor = Transaction.fromPSBT(base64.decode(node.psbt))
      } catch {
        return false
      }
      if (ancestor.id !== txid) return false
      seen.add(txid)
      if (!enqueueInputs(ancestor)) return false
    }
    if (!successorCarriesChange(status, pending, successor)) return false
  } catch {
    return false
  } finally {
    await repository[Symbol.asyncDispose]()
  }
  return true
}

function successorCarriesChange(status: VaultStatus, pending: PersistedVtxoSpend, successor: Transaction): boolean {
  const changeSats = pending.changeSats ?? 0
  if (changeSats <= 0) return true
  if (pending.changeVout === undefined) return false
  const output = successor.getOutput(pending.changeVout)
  return (
    !!output && output.amount === BigInt(changeSats) && hex.encode(output.script!) === status.spendingArkScript
  )
}

/** Owner-side retirement predicate for a finalized Spending successor.
 *
 * Retires the journal only when the service receipt, the durable
 * signed-successor archive, the wallet history and the committed recovery
 * coverage agree on the exact immutable operation. Anything short of that
 * keeps the pending journal for resume, reload and independent completion.
 * Failed capture preserves the previous complete archive by construction:
 * readCommittedRecoveryCoverage only observes committed files. */
async function retireFinalizedVtxoSpendLocked(
  status: VaultStatus,
  operationId: string,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  const pending = loadPersistedVtxoSpendById(status.vaultId, operationId)
  if (!pending || !pending.arkTxid) return false
  let view: VtxoOperationView
  try {
    view = await fetchVtxoOperation(pending.vaultId, pending.operationId)
  } catch {
    return false
  }
  if (view.state !== 'finalized' || !receiptBindsImmutableOperation(pending, view)) return false
  signal?.throwIfAborted()
  const snapshot = await fetchVaultWalletVtxoSnapshot(status)
  const outflow = pending.amountSats + (pending.feeSats ?? 0)
  if (
    !snapshot.history.some(
      (row) =>
        row.account === 'spend' &&
        row.type === 'sent' &&
        row.txid === pending.arkTxid &&
        row.amount === outflow,
    )
  )
    return false
  signal?.throwIfAborted()
  const coverage = await readCommittedRecoveryCoverage(status)
  if (
    !coverage ||
    (evidence &&
      (evidence.vaultId !== coverage.vaultId ||
        evidence.network !== coverage.network ||
        evidence.descriptorHash !== coverage.descriptorHash ||
        evidence.fileDigest !== coverage.fileDigest)) ||
    !spendingSuccessorChangeCovered(status, pending, coverage) ||
    !(await spendingSuccessorArchiveCovers(status, pending))
  )
    return false
  // A stale observation cannot retire a replacement or rewritten operation.
  if (JSON.stringify(loadPersistedVtxoSpendById(status.vaultId, operationId)) !== JSON.stringify(pending)) return false
  signal?.throwIfAborted()
  clearPersistedVtxoSpend(status.vaultId, operationId)
  return true
}

/** Retire one finalized Spending operation under the existing send lock. */
export async function acknowledgeSpendingVtxoRecovery(
  status: VaultStatus,
  operationId: string,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<boolean> {
  return withVtxoSendLock(status.vaultId, () =>
    retireFinalizedVtxoSpendLocked(status, operationId, evidence, signal),
  )
}

/** Best-effort retirement of every service-finalized operation. A cancelled
 * caller aborts the sweep; missing evidence keeps the remaining journals. */
export async function acknowledgeSettledVtxoSpends(
  status: VaultStatus,
  evidence?: CommittedRecoveryCoverage,
  signal?: AbortSignal,
): Promise<number> {
  const settled = listPersistedVtxoSpends(status.vaultId)
    .filter((record) => record.arkTxid)
    .map((record) => record.operationId)
  let retired = 0
  for (const operationId of settled) {
    signal?.throwIfAborted()
    try {
      if (await acknowledgeSpendingVtxoRecovery(status, operationId, evidence, signal)) retired++
    } catch (error) {
      signal?.throwIfAborted()
      if (signal?.aborted) throw error
    }
  }
  return retired
}

async function finishOperatorFinalized(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
): Promise<VaultVtxoSpendResult> {
  const { feeSats } = quoteFromPersistedVtxoSpend(pending)
  await finalizeVaultOperation(pending.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
  // Retirement is independently retried; evidence lag must not mask success here.
  await retireFinalizedVtxoSpendLocked(status, pending.operationId).catch(() => false)
  return { txid: pending.arkTxid, operationId: pending.operationId, feeSats }
}

async function authorizeReservedVtxoSpend(
  status: VaultStatus,
  pending: PersistedVtxoSpend,
  auth: VtxoSpendPasskey,
  signal?: AbortSignal,
): Promise<PersistedVtxoSpend> {
  if (!pending.unsignedArkPsbt || !pending.unsignedCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  await requireCurrentReservationPolicy(new RestArkProvider(vaultOperatorOrigin(status.network)), status, pending)
  signal?.throwIfAborted()
  const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
  const arkTx = Transaction.fromPSBT(base64.decode(pending.unsignedArkPsbt))
  const userSignedArk = await identity.sign(arkTx)
  requireUserSignedArkInputs(userSignedArk, xOnly(status.phoneBip340Pub, 'phone pubkey'))
  const unsignedArkPsbt = base64.encode(userSignedArk.toPSBT())
  signal?.throwIfAborted()
  const pendingProof = await createPhoneSignedPendingProof(
    pending.unsignedCheckpointPsbts,
    identity,
    xOnly(status.phoneBip340Pub, 'phone pubkey'),
  )
  signal?.throwIfAborted()
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
  signal?: AbortSignal,
): Promise<PersistedVtxoSpend> {
  if (pending.stage !== 'operator-submitted' || !pending.operatorCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  signal?.throwIfAborted()
  const identity = SingleKey.fromPrivateKey(auth.phoneSecret)
  const userAndOperatorCheckpoints: string[] = []
  for (const [index, raw] of pending.operatorCheckpointPsbts.entries()) {
    signal?.throwIfAborted()
    const checkpoint = Transaction.fromPSBT(base64.decode(raw))
    const original = pending.unsignedCheckpointPsbts?.[index]
      ? Transaction.fromPSBT(base64.decode(pending.unsignedCheckpointPsbts[index]))
      : checkpoint
    requireOperatorSignedCheckpoint(original, checkpoint, operatorPub)
    userAndOperatorCheckpoints.push(base64.encode((await identity.sign(checkpoint)).toPSBT()))
  }
  signal?.throwIfAborted()
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
  signal?: AbortSignal,
): Promise<VaultVtxoSpendResult> {
  const bundle = buildPersistedVtxoSdkBundle(status, initial)
  const operator = new RestArkProvider(vaultOperatorOrigin(status.network))
  const operatorInfo = await requireCurrentReservationPolicy(operator, status, initial)
  const operatorPub = xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey')
  let pending = initial
  const feeSats = quoteFromPersistedVtxoSpend(initial).feeSats
  signal?.throwIfAborted()
  const txid = await submitExactVaultSdkOperation({
    signal,
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
        pending = await authorizeReservedVtxoSpend(status, pending, await unlocker.unlock(), signal)
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
        pending = await authorizeSubmittedVtxoCheckpoints(status, pending, operatorPub, await unlocker.unlock(), signal)
        return { authorizedCheckpointPsbts: pending.checkpointPsbts! }
      },
      dispose: unlocker.dispose,
      async finalize({ authorizedCheckpointPsbts, signal }) {
        pending = { ...pending, checkpointPsbts: authorizedCheckpointPsbts }
        await requireCurrentReservationPolicy(operator, status, pending)
        signal.throwIfAborted()
        await retainFinalizationRecovery(status, pending)
        signal.throwIfAborted()
        await operator.finalizeTx(pending.arkTxid, authorizedCheckpointPsbts)
        pending = { ...pending, stage: 'operator-finalized', checkpointPsbts: authorizedCheckpointPsbts }
        persistVtxoSpend(pending)
        try {
          await finalizeVaultOperation(status.vaultId, pending.operationId, pending.bundleDigest, pending.arkTxid)
        } catch {
          throw new VtxoReceiptPendingError(pending.arkTxid, pending.operationId, feeSats)
        }
        // Retirement is independently retried; evidence lag must not mask success here.
        await retireFinalizedVtxoSpendLocked(status, pending.operationId).catch(() => false)
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
  signal?: AbortSignal,
): Promise<VaultVtxoSpendResult> {
  signal?.throwIfAborted()
  if (pending.stage === 'pre-reserve') {
    pending = await reservePersistedVtxoSpend(
      enrollment,
      status,
      pending,
      (await unlocker.unlock()).phoneSecret,
      signal,
    )
  }
  signal?.throwIfAborted()
  if (pending.stage === 'reserved' && pending.sdkBundleVersion === 1) {
    return completeFreshSdkVtxoSpend(status, pending, unlocker, signal)
  }
  requireRecoveryProofForAuthorizedSpend(pending)
  const operator = new RestArkProvider(vaultOperatorOrigin(status.network))
  if (pending.stage === 'operator-finalized') return finishOperatorFinalized(status, pending)
  if (pending.stage === 'checkpoints-authorized' && pending.checkpointPsbts?.length) {
    const info = await requireCurrentReservationPolicy(operator, status, pending)
    const checkpointPsbts = requireFullyAuthorizedCheckpoints(
      pending,
      status,
      xOnly(info.signerPubkey, 'Operator signer pubkey'),
    )
    signal?.throwIfAborted()
    await retainFinalizationRecovery(status, { ...pending, checkpointPsbts })
    signal?.throwIfAborted()
    await operator.finalizeTx(pending.arkTxid, checkpointPsbts)
    persistVtxoSpend({ ...pending, stage: 'operator-finalized', checkpointPsbts })
    return finishOperatorFinalized(status, { ...pending, stage: 'operator-finalized', checkpointPsbts })
  }
  if (pending.stage === 'reserved') {
    pending = await authorizeReservedVtxoSpend(status, pending, await unlocker.unlock(), signal)
  }
  signal?.throwIfAborted()
  if (pending.stage === 'authorized' && pending.authorizedPsbt && pending.unsignedCheckpointPsbts?.length) {
    const operatorInfo = await requireCurrentReservationPolicy(operator, status, pending)
    const operatorPub = xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey')
    signal?.throwIfAborted()
    pending = await advanceAuthorizedVtxoSpend(operator, pending, status, operatorPub)
  }
  if (pending.stage !== 'operator-submitted' || !pending.operatorCheckpointPsbts?.length) {
    throw new VtxoSpendInFlightError(pending.arkTxid, pending.operationId)
  }
  const operatorInfo = await requireCurrentReservationPolicy(operator, status, pending)
  signal?.throwIfAborted()
  pending = await authorizeSubmittedVtxoCheckpoints(
    status,
    pending,
    xOnly(operatorInfo.signerPubkey, 'Operator signer pubkey'),
    await unlocker.unlock(),
    signal,
  )
  const checkpointPsbts = pending.checkpointPsbts!
  await requireCurrentReservationPolicy(operator, status, pending)
  signal?.throwIfAborted()
  await retainFinalizationRecovery(status, { ...pending, checkpointPsbts })
  signal?.throwIfAborted()
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
  await retireFinalizedVtxoSpendLocked(status, pending.operationId).catch(() => false)
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
  signal?: AbortSignal,
): Promise<VaultVtxoSpendResult> {
  signal?.throwIfAborted()
  requireEnrolledSpendingStatus(status)
  if (!Number.isSafeInteger(reviewed.amountSats) || reviewed.amountSats < VTXO_DUST_SATS) {
    throw new VtxoReviewedReservationError()
  }
  const local = requireLocalReviewedVtxoQuote(
    loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId) || loadPersistedVtxoSpend(status.vaultId),
    reviewed,
  )
  const unlocker = createUnlocker(enrollment, status, reviewed.bundleDigest, undefined, signal)
  try {
    if (vtxoSpendNeedsPasskey(local.stage)) await unlocker.unlock()
    signal?.throwIfAborted()
    return await withVtxoSendLock(status.vaultId, async () => {
      signal?.throwIfAborted()
      const pending =
        loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId) || loadPersistedVtxoSpend(status.vaultId)
      if (!pending) throw new VtxoReviewedReservationError()
      let view: VtxoOperationView
      try {
        view = await fetchVtxoOperation(status.vaultId, reviewed.operationId)
      } catch (err) {
        if (operationNotFound(err) || (err instanceof Error && err.message.toLowerCase().includes('expired'))) {
          // An unknown or expired reservation releases pre-signing stages. A
          // live operation keeps its identity so unsafe reuse stays blocked.
          const current = loadPersistedVtxoSpendById(status.vaultId, reviewed.operationId)
          if (current && !vtxoSpendIsAbortable(current)) throw new VtxoReviewedReservationError()
          if (current) clearPersistedVtxoSpend(status.vaultId, reviewed.operationId)
          throw new VtxoReviewedReservationError()
        }
        throw err
      }
      signal?.throwIfAborted()
      requireReviewedVtxoReservation(pending, view, reviewed)
      const synced = applyVtxoOperationView(pending, view)
      if (!synced) throw new VtxoReviewedReservationError()
      return continueSameVtxoSpend(enrollment, status, synced, unlocker, signal)
    })
  } finally {
    unlocker.dispose()
  }
}
