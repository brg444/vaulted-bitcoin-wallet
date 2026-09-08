import { ConnectorUserError } from './connectorError'
import { hex, base64 } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { vaultGet, vaultPost } from './api'
import { zeroBytes } from './ceremony/directauth'
import { fetchAddressUtxos, fetchTxHex, fetchFeeEstimates, broadcastTx } from './esplora'
import { beginPasskeySession, decryptPhoneSecret } from './signIn'
import type { EnrollmentSecrets } from './tenantEnrollment'
import type { VaultStatus } from './types'
import { validateSpendingPolicy } from './spendingPolicy'
import { DUAL_CONNECTOR_TEMPLATE, buildConnectorFamily } from './program/connector'
import { loadConnectorEnrollmentPin, verifyConnectorStatus } from './program/connectorEnroll'
import { prepareConnectorPayment } from './program/connectorPayment'
import {
  loadPendingConnectorOperation,
  markConnectorSignaturesMayHaveIssued,
  storeConnectorHardwareApproval,
  preparePendingConnectorOperation,
  cancelPendingConnectorOperation,
  storeConnectorPhoneStage,
  storeConnectorOperationId,
  storeConnectorSavingsWitness,
  storeConnectorSignedTx,
  archiveResolvedConnectorOperation,
  restoreUnresolvedConnectorOperation,
  loadConnectorHistory,
  type ConnectorPendingInput,
} from './program/connectorStore'

const OPTIONS = { allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true } as const
export type PendingConnector = NonNullable<Awaited<ReturnType<typeof loadPendingConnectorOperation>>>
interface OperationView {
  operationId: string
  phase: 'authorized' | 'guardian_signed' | 'emulator_signed'
  resolution: 'none' | 'confirmed' | 'conflicted'
  candidateTxid: string
  verified: boolean
  signedPsbt?: string
}

export function connectorIdentity(status: VaultStatus) {
  const pin = loadConnectorEnrollmentPin(status.vaultId)
  if (!pin) throw new ConnectorUserError('Sign in again to verify this Savings signer.')
  verifyConnectorStatus(status, pin)
  return { vaultId: status.vaultId, enrollmentDigest: pin.enrollmentDigest }
}

export function connectorContract(status: VaultStatus): ConnectorPendingInput['contract'] {
  connectorIdentity(status)
  const origin = status.connectorEnrollment!
  if (status.protectionTier !== 'standard' && status.protectionTier !== 'advanced')
    throw new ConnectorUserError('connector tier required')
  const spendingPolicy = validateSpendingPolicy(
    status.spendingPolicy,
    status.network === 'mainnet' ? 'mainnet' : 'mutinynet',
  )
  return {
    vaultId: status.vaultId,
    network: status.network,
    templateVersion: status.templateVersion,
    phonePub: status.phoneBip340Pub!,
    hardwarePub: origin.connectorPub,
    phoneDirectP256: status.phoneDirectP256!,
    vaultCosignerBase: status.vaultCosignerBasePub!,
    arkadeCosignerBase: status.arkadeCosignerBasePub!,
    recoveryPub: status.recoveryPub || status.recoveryKeyPub,
    protectionTier: status.protectionTier,
    spendingPolicy,
    absoluteFeeCapSats: spendingPolicy.absoluteFeeCapSats,
    feerateCapSatPerV: spendingPolicy.feerateCapSatPerV,
    connectorType: origin.connectorType,
  }
}

export function loadConnectorWithdrawal(status: VaultStatus) {
  return loadPendingConnectorOperation(connectorIdentity(status), localStorage)
}

async function operationView(status: VaultStatus, pending: Pick<PendingConnector, 'record' | 'candidateTxid'>) {
  const operationId = pending.record.operationId
  if (!operationId) return null
  const view = await vaultGet<OperationView>(
    `/v1/connector/operation?vaultId=${encodeURIComponent(status.vaultId)}&operationId=${operationId}`,
  )
  if (
    view.operationId !== operationId ||
    view.candidateTxid !== pending.candidateTxid ||
    typeof view.verified !== 'boolean' ||
    !['none', 'confirmed', 'conflicted'].includes(view.resolution)
  )
    throw new ConnectorUserError('Connector operation response does not match this payment.')
  return view
}

// A terminal observation is used only when the Guardian has just revalidated
// canonical chain evidence. Outages retain the active operation and its coins.
export async function reconcileConnectorWithdrawal(status: VaultStatus) {
  const identity = connectorIdentity(status)
  const pending = await loadPendingConnectorOperation(identity, localStorage)
  if (!pending) return null
  const view = await operationView(status, pending)
  if (view?.verified && view.resolution !== 'none') {
    await archiveResolvedConnectorOperation(identity, pending.candidateTxid, view.operationId, localStorage)
    return null
  }
  return pending
}

export async function prepareConnectorWithdrawal(status: VaultStatus, recipient: string, amountSats: number) {
  const identity = connectorIdentity(status)
  const existing = await reconcileConnectorWithdrawal(status)
  if (existing) {
    if (existing.record.recipient === recipient && existing.record.amountSats === amountSats) return existing
    if (existing.record.signaturesMayHaveIssued)
      throw new ConnectorUserError('A Savings transfer is pending. Open it to continue.')
    await cancelPendingConnectorOperation(identity, existing.candidateTxid, localStorage)
  }
  const contract = connectorContract(status)
  const family = buildConnectorFamily(contract)
  const enrollment = status.connectorEnrollment!
  const [savingsCoins, reserves, estimates] = await Promise.all([
    fetchAddressUtxos(status.savingsAddress),
    fetchAddressUtxos(family.connector.address!),
    fetchFeeEstimates(),
  ])
  const dual = contract.templateVersion === DUAL_CONNECTOR_TEMPLATE
  const selectedReserves = reserves
    .filter((coin) => coin.status.confirmed && coin.value === (dual ? 500 : 1000))
    .sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
    .slice(0, dual ? 2 : 1)
  const [reserve, secondReserve] = selectedReserves
  if (selectedReserves.length !== (dual ? 2 : 1))
    throw new ConnectorUserError(
      `Open Security → Savings signer setup to fund the approval outputs, then wait for Bitcoin confirmation.`,
    )
  const rate = estimates['3'] ?? estimates['6']
  if (!Number.isFinite(rate) || rate <= 0 || rate > contract.feerateCapSatPerV)
    throw new ConnectorUserError('The current Bitcoin fee rate is outside this vault’s limit. Try again later.')
  const reserveParent = await fetchTxHex(reserve.txid)
  const secondParent = secondReserve ? await fetchTxHex(secondReserve.txid) : undefined
  const origin = {
    publicKey: hex.decode(enrollment.connectorPub),
    fingerprint: enrollment.connectorFingerprint,
    path: [...enrollment.connectorPath],
  }
  const candidates = savingsCoins
    .filter((coin) => coin.status.confirmed && Number.isSafeInteger(coin.value) && coin.value >= amountSats + 240)
    .sort((a, b) => a.value - b.value || a.txid.localeCompare(b.txid) || a.vout - b.vout)
  for (const coin of candidates) {
    const input: ConnectorPendingInput = {
      contract,
      origin: { ...origin, publicKey: enrollment.connectorPub },
      savings: { parentHex: await fetchTxHex(coin.txid), txid: coin.txid, vout: coin.vout },
      reserve: { parentHex: reserveParent, txid: reserve.txid, vout: reserve.vout },
      ...(secondReserve
        ? { secondReserve: { parentHex: secondParent!, txid: secondReserve.txid, vout: secondReserve.vout } }
        : {}),
      recipient,
      amountSats,
      feeSats: 0,
    }
    // Probe with non-dust change. Actual prevout values/scripts are checked by
    // the pure constructor; the Guardian checks canonical unspent confirmation.
    const available = coin.value - amountSats - 240
    if (available <= 0) continue
    const probeFee = available < 330 ? available : 0
    const probe = prepareConnectorPayment({
      ...input,
      origin,
      enrollmentDigest: identity.enrollmentDigest,
      feeSats: probeFee,
    })
    let feeSats = Math.ceil(probe.estimatedVbytes * rate)
    if (feeSats > available) continue
    if (available - feeSats > 0 && available - feeSats < 330) feeSats = available
    const finalInput = { ...input, feeSats }
    prepareConnectorPayment({ ...finalInput, origin, enrollmentDigest: identity.enrollmentDigest })
    // Reorg-sensitive historical reservations must be re-proved before these
    // same inputs can be reused. The server independently enforces this too.
    for (const row of await loadConnectorHistory(identity, localStorage)) {
      if (
        (row.record.savings.txid === coin.txid && row.record.savings.vout === coin.vout) ||
        [row.record.reserve, row.record.secondReserve].some(
          (previous) =>
            previous && selectedReserves.some((next) => previous.txid === next.txid && previous.vout === next.vout),
        )
      ) {
        const view = await operationView(status, row)
        if (view?.verified && view.resolution === 'none') {
          await restoreUnresolvedConnectorOperation(identity, row.candidateTxid, view.operationId, localStorage)
          throw new ConnectorUserError('An earlier Savings transfer is pending again. Open it to continue.')
        }
        if (!view?.verified || view.resolution === 'none')
          throw new ConnectorUserError(
            'An earlier Savings transfer needs chain confirmation before these inputs can be reused.',
          )
      }
    }
    await preparePendingConnectorOperation(finalInput, identity, localStorage)
    return (await loadPendingConnectorOperation(identity, localStorage))!
  }
  throw new ConnectorUserError(
    'No single confirmed Savings coin covers this transfer and its fee. Use a smaller amount.',
  )
}

function savingsWitness(pending: PendingConnector, response: string) {
  if (response.length > 4_000_000) throw new ConnectorUserError('connector response too large')
  const packet = Transaction.fromPSBT(
    /^[0-9a-f]+$/i.test(response) ? hex.decode(response) : base64.decode(response),
    OPTIONS,
  )
  if (packet.id !== pending.candidateTxid) throw new ConnectorUserError('Guardian changed the Savings transaction.')
  const family = buildConnectorFamily(pending.record.contract)
  const leafHash = hex.encode(tapLeafHash(family.savings.normal))
  const sigs =
    packet.getInput(pending.record.contract.templateVersion === DUAL_CONNECTOR_TEMPLATE ? 2 : 0).tapScriptSig || []
  const keys = [family.normalTweaks.arkade, family.normalTweaks.vault, pending.record.contract.phonePub]
  const witness = keys.map((pub) => {
    const found = sigs.filter(
      ([key]) => hex.encode(key.pubKey) === pub.slice(2) && hex.encode(key.leafHash) === leafHash,
    )
    if (found.length !== 1) throw new ConnectorUserError('Savings cosigner signature missing or duplicated.')
    return found[0][1]
  })
  witness.push(family.savings.normal, family.savings.control)
  pending.prepared.forHardware(witness) // validates every signature on the retained candidate
  return witness
}

export async function approveConnectorWithdrawal(
  status: VaultStatus,
  enrollment: EnrollmentSecrets,
  candidateTxid: string,
) {
  const identity = connectorIdentity(status)
  let pending = await loadPendingConnectorOperation(identity, localStorage)
  if (!pending || pending.candidateTxid !== candidateTxid)
    throw new ConnectorUserError('Review this Savings transfer again.')
  if (pending.record.contract.templateVersion === DUAL_CONNECTOR_TEMPLATE && !pending.record.hardwareSignatures) {
    await markConnectorSignaturesMayHaveIssued(identity, candidateTxid, localStorage)
    return (await loadPendingConnectorOperation(identity, localStorage))!
  }
  if (pending.record.savingsWitness) return pending
  if (pending.record.operationId) {
    const view = await operationView(status, pending)
    if (view?.signedPsbt && view.phase === 'emulator_signed') {
      await storeConnectorSavingsWitness(
        identity,
        candidateTxid,
        savingsWitness(pending, view.signedPsbt).map((item) => hex.encode(item)),
        localStorage,
      )
      return (await loadPendingConnectorOperation(identity, localStorage))!
    }
  }
  // One candidate-bound passkey approval supplies both the HTTP assertion and
  // the PRF needed for the phone signature. No second approval on success.
  const session = await beginPasskeySession('connector-withdraw', status, enrollment.credId, candidateTxid)
  let phone: Uint8Array | undefined
  try {
    if (!pending.record.phoneSignedPsbt) {
      phone = await decryptPhoneSecret(session.prf, enrollment.nonce, enrollment.ciphertext)
      await storeConnectorPhoneStage(identity, candidateTxid, pending.prepared.signPhone(phone), localStorage)
    }
    pending = (await loadPendingConnectorOperation(identity, localStorage))!
    const result = await vaultPost<{ operationId: string; signedPsbt: string }>('/v1/connector/withdraw/authorize', {
      vaultId: status.vaultId,
      psbt: pending.record.phoneSignedPsbt,
      ...session.assertion,
    })
    const witness = savingsWitness(pending, result.signedPsbt)
    await storeConnectorOperationId(identity, candidateTxid, result.operationId, localStorage)
    await storeConnectorSavingsWitness(
      identity,
      candidateTxid,
      witness.map((item) => hex.encode(item)),
      localStorage,
    )
    return (await loadPendingConnectorOperation(identity, localStorage))!
  } finally {
    zeroBytes(phone, session.prf, session.scalar)
  }
}

export function connectorHandoff(pending: PendingConnector): string {
  if (pending.record.contract.templateVersion === DUAL_CONNECTOR_TEMPLATE) return pending.prepared.hardwareApproval()
  if (!pending.record.savingsWitness) throw new ConnectorUserError('Savings approval is still pending.')
  return pending.prepared.forHardware(pending.record.savingsWitness.map((item) => hex.decode(item))).psbt()
}

export async function completeConnectorWithdrawal(
  status: VaultStatus,
  candidateTxid: string,
  response: string,
  enrollment?: EnrollmentSecrets,
) {
  const identity = connectorIdentity(status)
  let pending = await loadPendingConnectorOperation(identity, localStorage)
  if (!pending || pending.candidateTxid !== candidateTxid)
    throw new ConnectorUserError('The Savings transfer changed. Reopen the pending payment.')
  const dual = pending.record.contract.templateVersion === DUAL_CONNECTOR_TEMPLATE
  if (dual) {
    if (!pending.record.hardwareSignatures) {
      await storeConnectorHardwareApproval(identity, candidateTxid, response, localStorage)
      pending = (await loadPendingConnectorOperation(identity, localStorage))!
      candidateTxid = pending.candidateTxid
    }
    if (!pending.record.savingsWitness) {
      if (!enrollment) throw new ConnectorUserError('Sign in to approve this Savings transfer.')
      pending = await approveConnectorWithdrawal(status, enrollment, candidateTxid)
    }
  }
  if (!pending.record.savingsWitness) throw new ConnectorUserError('Savings approval is still pending.')
  const signer = pending.prepared.forHardware(pending.record.savingsWitness.map((item) => hex.decode(item)))
  const accepted = signer.accept(dual ? pending.prepared.psbt() : response)
  const saved = await storeConnectorSignedTx(identity, candidateTxid, accepted.txHex, localStorage)
  const txid = await broadcastTx(saved.txHex)
  if (txid !== saved.txid) throw new ConnectorUserError('Broadcast response did not match the Savings transaction.')
  return saved.txid
}
