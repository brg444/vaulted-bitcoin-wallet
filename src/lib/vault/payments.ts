import type { VaultHistoryItem } from './history'

/**
 * Shared payment presentation: one identity, one state vocabulary, and one
 * attention rule for every wallet surface that renders activity or details.
 *
 * This module derives display data only. It never authorizes a spend, claims
 * funds, retries a broadcast, or changes a lifecycle. The SDK activities, RFQ
 * records, Bitcoin journals, boarding outputs, Savings transactions, and
 * local approval records remain the authoritative sources; history rows are
 * their projection.
 *
 * Identity continuity:
 * - Lightning payments follow the RFQ id, so funding, claim, refund, and
 *   replacement rows resolve to one payment even when the displayed funding
 *   transaction id changes.
 * - Bitcoin sends follow the journal operation id, so the retained
 *   `bitcoin:<operationId>` row and the later commitment transaction row
 *   resolve to one payment.
 * - Boarding and Savings rows follow account plus transaction id. A replaced
 *   Bitcoin transaction surfaces as a new payment; the old row is superseded
 *   by refresh rather than silently merged, because no local link proves the
 *   replacement.
 *
 * Native Savings compatibility: `savings-ledger` rows and `ledgerStage`
 * values are accepted here so a later integration can render Ledger
 * approval, signer, broadcast, and unknown stages without changing this
 * mapping. Unknown stages never offer a retry.
 */
export type PaymentRoute =
  | 'arkade'
  | 'bitcoin-spending'
  | 'bitcoin-savings'
  | 'lightning-send'
  | 'lightning-receive'
  | 'boarding'
  | 'savings-handoff'
  | 'savings-connector'
  | 'savings-ledger'

export type PaymentAttention = 'none' | 'action' | 'check'

/**
 * Provenance of an incoming payment, used to decide arrival feedback.
 * `verified-external` means the row carries evidence its funds arrived from
 * outside the wallet's own movement. `uncertain` means the row is honestly
 * rendered in activity but must never raise an arrival alert until a
 * classified source proves otherwise. Outflows never raise arrivals either
 * way.
 */
export type PaymentOrigin = 'verified-external' | 'uncertain'

export interface PaymentScope {
  network: string
  vaultId: string
}

export interface PaymentIdentity {
  /** Stable within one network and vault; never reused across payments. */
  key: string
  kind: 'lightning-rfq' | 'bitcoin-operation' | 'transaction'
  /** The reference that produced the key: RFQ id, operation id, or txid. */
  ref: string
}

export interface PaymentDescription {
  route: PaymentRoute
  /** Row title shared by activity and details. */
  title: string
  /** Status line shared by activity and details. */
  state: string
  /** Longer explanation used by the details screen. */
  copy: string
  attention: PaymentAttention
  complete: boolean
  /** True only for the verified passkey-backed refund path. */
  canRetry: boolean
  /** True only when the row proves funds arrived from outside the wallet. */
  origin: PaymentOrigin
  /** Internal movement, change, renewal, and outflows never raise arrivals. */
  suppressArrival: boolean
}

const BITCOIN_STAGES_AWAITING_APPROVAL = new Set(['preparing', 'prepared'])
const BITCOIN_STAGES_SENDING = new Set(['registering', 'registered', 'finalizing'])

function lightningDescription(item: VaultHistoryItem, received: boolean): PaymentDescription {
  const state = item.lightningState || 'pending'
  if (['claimed', 'settled'].includes(state)) {
    return {
      route: received ? 'lightning-receive' : 'lightning-send',
      title: 'Lightning payment',
      state: received ? 'Received' : 'Paid',
      copy: received ? 'This Lightning payment reached Spending.' : 'This Lightning payment is complete.',
      attention: 'none',
      complete: true,
      canRetry: false,
      // The persisted RFQ record proves direction and completion, so a
      // completed receive is verified external funds.
      origin: received ? 'verified-external' : 'uncertain',
      suppressArrival: !received,
    }
  }
  if (state === 'refunded') {
    return {
      route: received ? 'lightning-receive' : 'lightning-send',
      title: 'Lightning payment',
      state: 'Refunded',
      copy: 'This Lightning payment was refunded.',
      attention: 'none',
      complete: true,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (state === 'needs_counterparty') {
    return {
      route: received ? 'lightning-receive' : 'lightning-send',
      title: 'Lightning payment',
      state: 'Ready to return',
      copy: 'Return the remaining payment funds to Spending.',
      attention: 'action',
      complete: false,
      canRetry: !received && Boolean(item.lightningRfqId),
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (state === 'failed') {
    return {
      route: received ? 'lightning-receive' : 'lightning-send',
      title: 'Lightning payment',
      state: 'Needs recovery',
      copy: 'This Lightning payment needs recovery.',
      attention: 'check',
      complete: false,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  return {
    route: received ? 'lightning-receive' : 'lightning-send',
    title: 'Lightning payment',
    state: 'Processing',
    copy: 'This Lightning payment is still processing.',
    attention: 'none',
    complete: false,
    canRetry: false,
    origin: 'uncertain',
    suppressArrival: true,
  }
}

function bitcoinSendDescription(item: VaultHistoryItem): PaymentDescription {
  const stage = item.bitcoinStage || ''
  const uncertainSend = {
    route: 'bitcoin-spending',
    origin: 'uncertain',
    suppressArrival: true,
  } as const
  if (!stage) {
    // Rows without a journal stage come from the indexed history, except a
    // retained local submission whose journal lost its stage. The two cases
    // need different wording: indexed evidence stands on its own.
    if (item.bitcoinOperationId) {
      return {
        ...uncertainSend,
        title: 'Bitcoin payment',
        state: 'Checking status',
        copy: 'The payment status needs checking. Refresh the wallet before trying anything else.',
        attention: 'check',
        complete: false,
        canRetry: false,
      }
    }
    if (item.confirmed) {
      return {
        ...uncertainSend,
        title: 'Bitcoin payment',
        state: 'Sent',
        copy: 'This Bitcoin payment is confirmed.',
        attention: 'none',
        complete: true,
        canRetry: false,
      }
    }
    return {
      ...uncertainSend,
      title: 'Bitcoin payment',
      state: 'Pending',
      copy: 'This Bitcoin payment is still processing.',
      attention: 'none',
      complete: false,
      canRetry: false,
    }
  }
  if (stage === 'confirmed') {
    return {
      ...uncertainSend,
      title: 'Bitcoin payment',
      state: 'Sent',
      copy: 'This Bitcoin payment is confirmed.',
      attention: 'none',
      complete: true,
      canRetry: false,
    }
  }
  if (stage === 'submitted') {
    return {
      ...uncertainSend,
      title: 'Bitcoin payment',
      state: 'Sent · Awaiting confirmation',
      copy: 'This payment was broadcast and now waits for Bitcoin confirmation.',
      attention: 'none',
      complete: false,
      canRetry: false,
    }
  }
  if (BITCOIN_STAGES_AWAITING_APPROVAL.has(stage)) {
    return {
      ...uncertainSend,
      title: 'Bitcoin payment',
      state: 'Awaiting approval',
      copy: 'Review this Bitcoin payment to continue.',
      attention: 'action',
      complete: false,
      canRetry: false,
    }
  }
  if (BITCOIN_STAGES_SENDING.has(stage)) {
    return {
      ...uncertainSend,
      title: 'Bitcoin payment',
      state: 'Sending',
      copy: 'This Bitcoin payment is on its way.',
      attention: 'none',
      complete: false,
      canRetry: false,
    }
  }
  return {
    ...uncertainSend,
    title: 'Bitcoin payment',
    state: 'Checking status',
    copy: 'The payment status needs checking. Refresh the wallet before trying anything else.',
    attention: 'check',
    complete: false,
    canRetry: false,
  }
}

function ledgerDescription(item: VaultHistoryItem): PaymentDescription {
  // The Savings integration supplies confirmation separately from the stage:
  // a verified broadcast awaits confirmation, and verified confirmation
  // completes. Unknown remains a reconciliation state with no retry.
  const stage = item.ledgerStage || 'unknown'
  const uncertainSend = {
    route: 'savings-ledger',
    origin: 'uncertain',
    suppressArrival: true,
  } as const
  if (item.confirmed) {
    return {
      ...uncertainSend,
      title: 'Savings transfer',
      state: 'Sent',
      copy: 'This Savings transfer is confirmed.',
      attention: 'none',
      complete: true,
      canRetry: false,
    }
  }
  if (stage === 'approval') {
    return {
      ...uncertainSend,
      title: 'Savings transfer',
      state: 'Savings approval pending',
      copy: 'Approve this Savings transfer to continue.',
      attention: 'action',
      complete: false,
      canRetry: false,
    }
  }
  if (stage === 'signer') {
    return {
      ...uncertainSend,
      title: 'Savings transfer',
      state: 'Waiting for signer',
      copy: 'This Savings transfer waits for the hardware signer.',
      attention: 'action',
      complete: false,
      canRetry: false,
    }
  }
  if (stage === 'broadcast') {
    return {
      ...uncertainSend,
      title: 'Savings transfer',
      state: 'Sent · Awaiting confirmation',
      copy: 'This transfer was broadcast and now waits for Bitcoin confirmation.',
      attention: 'none',
      complete: false,
      canRetry: false,
    }
  }
  return {
    ...uncertainSend,
    title: 'Savings transfer',
    state: 'Checking status',
    copy: 'The transfer status needs checking. Refresh the wallet before trying anything else.',
    attention: 'check',
    complete: false,
    canRetry: false,
  }
}

/** One wording for activity rows and the details screen. */
export function describePayment(item: VaultHistoryItem): PaymentDescription {
  const sent = item.type === 'sent'
  if (item.activity === 'lightning') return lightningDescription(item, !sent)
  if (item.activity === 'bitcoin' && sent) return bitcoinSendDescription(item)
  if (item.activity === 'savings-handoff') {
    return {
      route: 'savings-handoff',
      title: 'Waiting for hardware',
      state: 'Complete or cancel',
      copy: 'This Savings transfer waits for the hardware signature. Complete or cancel it.',
      attention: 'action',
      complete: false,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (item.activity === 'savings-connector') {
    if (item.connectorStage === 'broadcast') {
      return {
        route: 'savings-connector',
        title: 'Savings transfer pending',
        state: 'Check or retry broadcast',
        copy: 'This signed Savings transfer still needs to reach Bitcoin. Check its status before trying again.',
        attention: 'check',
        complete: false,
        canRetry: false,
        origin: 'uncertain',
        suppressArrival: true,
      }
    }
    return {
      route: 'savings-connector',
      title: item.connectorStage === 'signer' ? 'Waiting for signer' : 'Savings approval pending',
      state: 'Continue payment',
      copy:
        item.connectorStage === 'signer'
          ? 'This Savings transfer waits for the hardware signer.'
          : 'Approve this Savings transfer to continue.',
      attention: 'action',
      complete: false,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (item.activity === 'savings-ledger') return ledgerDescription(item)
  if (item.activity === 'boarding') {
    // Boarding carries the deposit into Spending, but the same address also
    // receives internal Savings-to-Spending transfers, so activity rows stay
    // visible while arrival alerts wait for a classified source.
    if (!item.confirmed) {
      return {
        route: 'boarding',
        title: 'Received',
        state: 'Pending',
        copy: 'This will update automatically after Bitcoin confirmation.',
        attention: 'none',
        complete: false,
        canRetry: false,
        origin: 'uncertain',
        suppressArrival: true,
      }
    }
    return {
      route: 'boarding',
      title: 'Received',
      state: 'Received',
      copy: 'This deposit is available in Spending.',
      attention: 'none',
      complete: true,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (item.account === 'savings') {
    if (!item.confirmed) {
      return {
        route: 'bitcoin-savings',
        title: sent ? 'Sent' : 'Received',
        state: 'Pending',
        copy: 'This will update automatically after Bitcoin confirmation.',
        attention: 'none',
        complete: false,
        canRetry: false,
        origin: sent ? 'uncertain' : 'verified-external',
        suppressArrival: sent,
      }
    }
    return {
      route: 'bitcoin-savings',
      title: sent ? 'Sent' : 'Received',
      state: sent ? 'Sent' : 'Received',
      copy: sent ? 'This Savings transfer is confirmed.' : 'This Savings deposit is confirmed.',
      attention: 'none',
      complete: true,
      canRetry: false,
      // A confirmed credit to the watched Savings address is a deposit: no
      // wallet flow self-credits that address, and send change nets inside
      // the send row instead of producing a receipt.
      origin: sent ? 'uncertain' : 'verified-external',
      suppressArrival: sent,
    }
  }
  if (item.activity === 'bitcoin') {
    return {
      route: 'bitcoin-spending',
      title: 'Received',
      state: 'Pending',
      copy: 'This will update automatically after Bitcoin confirmation.',
      attention: 'none',
      complete: false,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  if (sent) {
    return {
      route: 'arkade',
      title: 'Sent',
      state: item.confirmed ? 'Sent' : 'Pending',
      copy: 'This payment is available to its recipient.',
      attention: 'none',
      complete: item.confirmed,
      canRetry: false,
      origin: 'uncertain',
      suppressArrival: true,
    }
  }
  return {
    route: 'arkade',
    title: 'Received',
    state: item.confirmed ? 'Received' : 'Pending',
    copy: 'This payment is available in Spending.',
    attention: 'none',
    complete: item.confirmed,
    canRetry: false,
    // A spendable VTXO receipt under the Spending script with positive net
    // value is external funds: renewals settle against existing value and
    // boarding carries its own activity flag. Funded renewal observation
    // remains an open qualification check on this classification.
    origin: 'verified-external',
    suppressArrival: false,
  }
}

/**
 * Stable payment identity scoped to one network and vault. Rows that share a
 * key are one payment even when the displayed transaction id changes across
 * claim, refund, replacement journal, or indexer transitions.
 */
export function paymentIdentityForItem(item: VaultHistoryItem, scope: PaymentScope): PaymentIdentity {
  const network = scope.network || 'unknown'
  const vault = scope.vaultId || 'unknown'
  if (item.activity === 'lightning' && item.lightningRfqId) {
    return {
      key: `lightning:${network}:${vault}:${item.lightningRfqId}`,
      kind: 'lightning-rfq',
      ref: item.lightningRfqId,
    }
  }
  if (item.bitcoinOperationId) {
    return {
      key: `bitcoin-send:${network}:${vault}:${item.bitcoinOperationId}`,
      kind: 'bitcoin-operation',
      ref: item.bitcoinOperationId,
    }
  }
  if (item.txid.startsWith('bitcoin:')) {
    const ref = item.txid.slice('bitcoin:'.length) || item.txid
    return { key: `bitcoin-send:${network}:${vault}:${ref}`, kind: 'bitcoin-operation', ref }
  }
  return {
    key: `tx:${network}:${vault}:${item.account}:${item.txid}:${item.type}`,
    kind: 'transaction',
    ref: item.txid,
  }
}

/** True when two rows are one payment under the same network and vault. */
export function isSamePayment(a: VaultHistoryItem, b: VaultHistoryItem, scope: PaymentScope): boolean {
  if (a === b) return true
  return paymentIdentityForItem(a, scope).key === paymentIdentityForItem(b, scope).key
}
