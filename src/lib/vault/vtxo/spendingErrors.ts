import { type PersistedVtxoSpend } from './spendingTransaction'

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
