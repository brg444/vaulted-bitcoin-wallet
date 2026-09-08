/** Only explicit payment outcomes may bypass the generic error copy. */
export class BitcoinPaymentError extends Error {
  constructor(
    readonly outcome: 'not_sent' | 'pending',
    message: string,
  ) {
    super(message)
    this.name = 'BitcoinPaymentError'
  }
}
