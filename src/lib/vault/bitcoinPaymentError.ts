/** Only explicit payment outcomes may bypass the generic error copy. */
export class BitcoinPaymentError extends Error {
  constructor(
    readonly outcome: 'not_sent' | 'pending',
    message: string,
    readonly details?: string,
    readonly retryAt?: number,
  ) {
    super(message)
    this.name = 'BitcoinPaymentError'
  }
}

/** Operator diagnostics are support information, never the primary payment copy. */
export function bitcoinPaymentRejected(reason?: string, retryAt?: number): BitcoinPaymentError {
  const text = (reason || '').toLowerCase()
  let message = 'The Bitcoin payment was not sent. Review the payment and try again. If it repeats, contact support.'
  if (text.includes('expires after') && text.includes('minexpirygap:')) {
    return bitcoinPaymentWait(retryAt, reason)
  } else if (text.includes('already spent') || text.includes('duplicated input')) {
    message =
      'The Bitcoin payment was not sent because its funds changed or are in use. Refresh your balance and review the payment again.'
  } else if (text.includes('fee')) {
    message =
      'The Bitcoin payment was not sent because its fee could not be accepted. Review the payment to get a new fee.'
  }
  return new BitcoinPaymentError('not_sent', message, reason?.slice(0, 500), retryAt)
}

/**
 * Classify a passkey ceremony failure. Cancellation and platform context
 * rejections (expired user activation after a long setup, backgrounded page,
 * dismissed prompt) are actionable retry states: no journal exists yet, so
 * nothing was sent or reserved. Anything else propagates untouched so real
 * ceremony bugs stay loud.
 */
export function bitcoinPaymentCredentialError(error: unknown): unknown {
  const name =
    error instanceof DOMException
      ? error.name
      : error instanceof Error && /NotAllowedError|AbortError/.test(error.name)
        ? error.name
        : undefined
  if (name === 'AbortError')
    return new BitcoinPaymentError(
      'not_sent',
      'The passkey step was cancelled. Review the payment and try again when ready.',
    )
  if (name === 'NotAllowedError')
    return new BitcoinPaymentError(
      'not_sent',
      'The passkey step did not complete. Keep this page open and try again, and approve the prompt on this device.',
    )
  return error
}

export function bitcoinPaymentWait(retryAt?: number, details?: string): BitcoinPaymentError {
  const message = retryAt
    ? `Expected availability: ${new Date(retryAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Nothing was sent or queued.`
    : 'These funds need to wait before another onchain payment. Nothing was sent or queued.'
  return new BitcoinPaymentError('not_sent', message, details?.slice(0, 500), retryAt)
}
