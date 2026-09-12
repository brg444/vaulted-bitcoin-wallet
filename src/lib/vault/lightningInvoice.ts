import type { NetworkName } from '@arkade-os/sdk'
import type { InvoiceFacts } from '@arkade-os/swap'
import bolt11 from 'light-bolt11-decoder'
import { LightningPaymentError } from './lightningError'

const NETWORK_PREFIX: Record<NetworkName, string> = {
  bitcoin: 'bc',
  testnet: 'tb',
  signet: 'tbs',
  mutinynet: 'tbs',
  regtest: 'bcrt',
}

export class LightningInvoiceRejected extends LightningPaymentError {
  constructor(
    readonly reason:
      | 'unparseable'
      | 'wrong_network'
      | 'expired'
      | 'zero_amount'
      | 'fractional_amount'
      | 'no_payment_hash',
    message: string,
  ) {
    super(message)
    this.name = 'LightningInvoiceRejected'
  }
}

export function wholeSatsFromMillisats(amountMillisats: number): number {
  if (!Number.isSafeInteger(amountMillisats) || amountMillisats <= 0) {
    throw new LightningInvoiceRejected('zero_amount', 'Enter a Lightning invoice with an amount.')
  }
  if (amountMillisats % 1000 !== 0) {
    throw new LightningInvoiceRejected('fractional_amount', 'This invoice amount is smaller than one whole satoshi.')
  }
  const amountSats = amountMillisats / 1000
  if (!Number.isSafeInteger(amountSats)) {
    throw new LightningInvoiceRejected('unparseable', 'This Lightning invoice amount is too large.')
  }
  return amountSats
}

export function decodeVaultLightningInvoice(
  rawInvoice: string,
  network: NetworkName,
  nowSeconds = Math.floor(Date.now() / 1000),
): InvoiceFacts {
  const invoice = rawInvoice.trim().replace(/^lightning:/i, '')
  let decoded: ReturnType<typeof bolt11.decode>
  try {
    decoded = bolt11.decode(invoice)
  } catch {
    throw new LightningInvoiceRejected('unparseable', 'Enter a valid Lightning invoice.')
  }
  const amountMillisats = Number(decoded.sections.find((section) => section.name === 'amount')?.value ?? '0')
  const timestamp = Number(decoded.sections.find((section) => section.name === 'timestamp')?.value ?? 0)
  const paymentHash = String(decoded.sections.find((section) => section.name === 'payment_hash')?.value ?? '')
  const coinNetwork = decoded.sections.find((section) => section.name === 'coin_network')
  const prefix = coinNetwork && 'value' in coinNetwork ? String(coinNetwork.value?.bech32 ?? '') : ''
  const expiresAt = timestamp + (decoded.expiry ?? 3600)
  if (prefix !== NETWORK_PREFIX[network]) {
    throw new LightningInvoiceRejected('wrong_network', `This invoice is not for ${network}.`)
  }
  if (!timestamp || nowSeconds >= expiresAt) {
    throw new LightningInvoiceRejected('expired', 'This Lightning invoice has expired.')
  }
  const amountSats = wholeSatsFromMillisats(amountMillisats)
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new LightningInvoiceRejected('no_payment_hash', 'This Lightning invoice has no payment hash.')
  }
  return { raw: invoice, paymentHash, amountSats, expiresAt }
}
