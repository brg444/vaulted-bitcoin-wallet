import { SOLO_REFUND_HEADROOM_SECONDS, unilateralRefundWithoutReceiverDelay } from '@arkade-os/swap'

/**
 * Validation and derivation adapter for the solver's quoted solo-refund delay.
 *
 * The current solver advertises `quote.profile.refund_without_receiver_delay`
 * (`packages/solver-corridors`' send quote payload) and derives it with
 * `refundWithoutReceiverDelayFor`:
 *
 *   horizon  = max(0, refundLocktime - quotedAt)   // refundLocktime is unix seconds
 *   required = ceil to the next BIP68 512s unit
 *   delay    = max(baseDelay, required)
 *
 * `baseDelay` is the same fixed derivation this wallet already applies
 * (`unilateralRefundWithoutReceiverDelay(claimDelay)`), so when the quote's
 * refund horizon is shorter than the base the two agree and the field is a
 * no-op. When it is longer — the case that produced the live
 * `solver lockup address does not match local derivation` refusal — the quote
 * raises the solo CSV delay above the base.
 *
 * Older solvers do not advertise the field at all; their fixed derivation is
 * the independently verified contract, so absence keeps the existing bytes.
 * A present value is untrusted contract input: it must be a whole BIP68 value
 * in the ladder's own unit, no shorter than the base that guards the claim
 * window, and no longer than the quote's own refund horizon. It is never used
 * to derive a script until these hold, and the resulting script still has to
 * match `lockup_address` byte for byte.
 *
 * The wallet's lightning-send package helper (`@arkade-os/swap`'s
 * `lightningSendVtxoScript`) builds a SECONDS-typed ladder unconditionally and
 * refuses an exit delay below 512s, so block-typed profiles are outside this
 * release: a below-512 advertised value is refused as an unencodable
 * seconds timelock rather than silently reinterpreted as blocks.
 */

/** BIP68 relative time is encoded in 512-second units. */
export const BIP68_REFUND_GRANULARITY_SECONDS = 512

const MAX_BIP68_SECONDS = 0xffff * BIP68_REFUND_GRANULARITY_SECONDS

/**
 * Absolute ceiling on both the quoted refund horizon and the solo CSV delay,
 * seconds (thirty days).
 *
 * Far above the solver's own worst case: `refundLocktimeFor` tops out at the
 * uncapped-route budget (`MAX_CLIENT_CLTV_BLOCKS` + `UNENFORCED_ROUTE_CLTV_
 * BUDGET_BLOCKS` blocks at 600s) plus a 2h funding window and the 2h refund
 * safety margin, about seventeen days. Enforced, not documented: a quote whose
 * absolute refund horizon or advertised delay reaches beyond it is refused, so
 * a distant `refund_locktime` cannot smuggle an unbounded sender recovery
 * window in under a smaller CSV.
 */
export const MAX_QUOTED_REFUND_HORIZON_SECONDS = 30 * 24 * 60 * 60

/**
 * Clock and transport slack above the solver's own horizon rounding.
 *
 * The solver derives the delay a moment before this wallet receives the quote,
 * so its horizon can exceed the wallet's by the request round trip. This is a
 * limited allowance, deliberately separate from (and far below) the absolute
 * recovery ceiling.
 */
export const QUOTED_REFUND_DELAY_CLOCK_SLACK_SECONDS = SOLO_REFUND_HEADROOM_SECONDS

function wholePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Lightning quote ${field} must be a finite positive whole number.`)
  }
  return value
}

function ceilToGranularity(seconds: number): number {
  return Math.ceil(seconds / BIP68_REFUND_GRANULARITY_SECONDS) * BIP68_REFUND_GRANULARITY_SECONDS
}

/**
 * Resolve and validate a quote's advertised `refund_without_receiver_delay`.
 *
 * @returns the raw delay to bind into the candidate trees, or `undefined` when
 *          the quote omits the field (an older solver whose fixed derivation is
 *          already correct).
 * @throws when the field is present but malformed, below the locally derived
 *         solo-refund floor, beyond the solver's own horizon (plus limited
 *         slack), or when any timing input is not a finite positive safe
 *         integer.
 */
export function resolveQuotedRefundWithoutReceiverDelay(input: {
  quoted: unknown
  claimDelay: number
  refundLocktime: number
  nowSeconds: number
}): number | undefined {
  const { quoted } = input
  if (quoted === undefined) return undefined

  const claimDelay = wholePositive(input.claimDelay, 'claim delay')
  const refundLocktime = wholePositive(input.refundLocktime, 'refund locktime')
  const nowSeconds = wholePositive(input.nowSeconds, 'quote time')
  const value = wholePositive(quoted, 'refund_without_receiver_delay')

  // The ladder is seconds-typed on every supported deployment. A value that
  // BIP68 would read as blocks (< 512) is not this ladder's unit; a value off
  // the 512s boundary is not encodable at all.
  if (value < BIP68_REFUND_GRANULARITY_SECONDS || value % BIP68_REFUND_GRANULARITY_SECONDS !== 0) {
    throw new Error(
      `Lightning quote refund_without_receiver_delay ${value} is not a whole multiple of ` +
        `${BIP68_REFUND_GRANULARITY_SECONDS}s and cannot be encoded as this ladder's seconds timelock.`,
    )
  }
  if (value > MAX_BIP68_SECONDS) {
    throw new Error('Lightning quote refund_without_receiver_delay exceeds the longest BIP68 timelock.')
  }

  const base = unilateralRefundWithoutReceiverDelay(claimDelay)
  if (value < base) {
    throw new Error(
      `Lightning quote refund_without_receiver_delay ${value} is below the independently derived ` +
        `solo-refund floor ${base}; the sender's refund could open before the claim window.`,
    )
  }

  // Enforce the absolute recovery ceiling on the quote's own deadline first: a
  // distant refund_locktime is refused however small the advertised CSV is.
  // The floor is allowed to exceed the nominal ceiling so an operator whose
  // verified exit delay is itself longer still accepts its own base.
  const ceiling = Math.max(base, MAX_QUOTED_REFUND_HORIZON_SECONDS)
  const horizon = refundLocktime - nowSeconds
  if (horizon > ceiling) {
    throw new Error(
      `Lightning quote refund locktime is ${horizon}s away, beyond the ${ceiling}s sender recovery ceiling.`,
    )
  }

  // The advertised delay may exceed the solver's own horizon rounding only by
  // the limited clock/transport slack, and never beyond the ceiling.
  const required = ceilToGranularity(Math.max(0, horizon))
  const maximum = Math.min(ceiling, Math.max(base, required + QUOTED_REFUND_DELAY_CLOCK_SLACK_SECONDS))
  if (value > maximum) {
    throw new Error(
      `Lightning quote refund_without_receiver_delay ${value} is beyond the bounded refund horizon ${maximum}.`,
    )
  }
  return value
}
