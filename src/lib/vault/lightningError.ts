/** Locally authored Lightning messages that are safe to display in the wallet. */
export class LightningPaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LightningPaymentError'
  }
}
