import { Transaction } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { canonicalLedgerValue } from '../program/ledgerEnrollment'
import { acceptRecoveryPsbtSignatures, recoveryPsbtBytes } from '../recovery/signatureImport'
import {
  buildLedgerSpendingRecoveryPsbt,
  inspectLedgerSpendingRecovery,
  type LedgerSpendingRecoveryRequest,
  type LedgerSpendingRecoveryRole,
} from './ledgerSpendingRecovery'
import { inspectLedgerRecoveryFee, type LedgerRecoveryFeeRequest } from './ledgerRecoveryFee'

export interface LedgerOfflineFeeRequest {
  name: 'vaulted-ledger-offline-fee'
  version: 1
  request: LedgerRecoveryFeeRequest
  psbt: string
}
export type LedgerOfflineRequest = LedgerOfflineSpendingRequest | LedgerOfflineFeeRequest
export function validateLedgerOfflineRequest(raw: unknown): LedgerOfflineRequest {
  if ((raw as { name?: string })?.name !== 'vaulted-ledger-offline-fee')
    return validateLedgerOfflineSpendingRequest(raw)
  const f = structuredClone(raw) as LedgerOfflineFeeRequest
  if (f.version !== 1) throw new Error('Unsupported offline fee request')
  const plan = inspectLedgerRecoveryFee(f.request)
  const r = f.request
  const rebuilt: LedgerOfflineFeeRequest = {
    name: f.name,
    version: 1,
    request: {
      role: r.role,
      file: r.file,
      parentTxid: r.parentTxid,
      feeAddress: r.feeAddress,
      feeRate: r.feeRate,
      fundingCoins: r.fundingCoins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        value: c.value,
        parentTxHex: c.parentTxHex,
      })),
    },
    psbt: plan.unsignedPsbt,
  }
  if (canonicalLedgerValue(raw) !== canonicalLedgerValue(rebuilt))
    throw new Error('Offline fee request contains changed or unsupported fields')
  return rebuilt
}

export interface LedgerOfflineSpendingRequest {
  name: 'vaulted-ledger-offline-spending'
  version: 1
  role: LedgerSpendingRecoveryRole
  request: LedgerSpendingRecoveryRequest
  psbt: string
}

/** Public intent and partial signatures only. The seed is never part of this file. */
export function validateLedgerOfflineSpendingRequest(raw: unknown): LedgerOfflineSpendingRequest {
  const f = structuredClone(raw) as LedgerOfflineSpendingRequest
  if (
    !f ||
    f.name !== 'vaulted-ledger-offline-spending' ||
    f.version !== 1 ||
    (f.role !== 'hardware' && f.role !== 'recovery')
  )
    throw new Error('Unsupported offline Spending request')
  const plan = inspectLedgerSpendingRecovery(f.request)
  const selected = plan.requiredKeys.find((k) => k.role === f.role)
  if (!selected) throw new Error('This recovery account is not required')
  const canonical = buildLedgerSpendingRecoveryPsbt(f.request)
  const psbt =
    f.psbt === canonical
      ? canonical
      : acceptRecoveryPsbtSignatures(
          canonical,
          f.psbt,
          plan.requiredKeys.map((k) => k.publicKey),
        )
  const tx = Transaction.fromPSBT(recoveryPsbtBytes(psbt))
  if (tx.getInput(0).tapScriptSig?.some(([key]) => hex.encode(key.pubKey) === selected.publicKey.slice(2)))
    throw new Error('The selected account has already signed')
  const result: LedgerOfflineSpendingRequest = {
    name: f.name,
    version: 1,
    role: f.role,
    request: {
      descriptor: f.request.descriptor,
      coin: {
        txid: f.request.coin.txid,
        vout: f.request.coin.vout,
        value: f.request.coin.value,
        parentTxHex: f.request.coin.parentTxHex,
      },
      destination: f.request.destination,
      feeSats: f.request.feeSats,
    },
    psbt: hex.encode(tx.toPSBT()),
  }
  if (canonicalLedgerValue(f) !== canonicalLedgerValue(result))
    throw new Error('Offline request contains changed or unsupported fields')
  return result
}
