import { unilateralClaimDelay } from '@arkade-os/swap'
import { describe, expect, it } from 'vitest'
import {
  BIP68_REFUND_GRANULARITY_SECONDS,
  MAX_QUOTED_REFUND_HORIZON_SECONDS,
  QUOTED_REFUND_DELAY_CLOCK_SLACK_SECONDS,
  resolveQuotedRefundWithoutReceiverDelay,
} from './lightningRefundDelay'

const CLAIM_DELAY = unilateralClaimDelay(605_184) // 605_184 (a whole 512s BIP68 value)
const BASE = CLAIM_DELAY + 4096 // 609_280
const NOW = 1_799_387_616
const REFUND_LOCKTIME = 1_800_000_000 // horizon 612_384s -> solver delay 612_864
const SOLVER_DELAY = 612_864
const SOLVER_HORIZON_MAX = SOLVER_DELAY + QUOTED_REFUND_DELAY_CLOCK_SLACK_SECONDS

const resolve = (
  quoted: unknown,
  overrides: Partial<Parameters<typeof resolveQuotedRefundWithoutReceiverDelay>[0]> = {},
) =>
  resolveQuotedRefundWithoutReceiverDelay({
    quoted,
    claimDelay: CLAIM_DELAY,
    refundLocktime: REFUND_LOCKTIME,
    nowSeconds: NOW,
    ...overrides,
  })

describe('quoted refund_without_receiver_delay adapter', () => {
  it('keeps the independently verified fixed derivation when the field is absent', () => {
    expect(resolve(undefined)).toBeUndefined()
  })

  it('accepts the solver horizon delay and the fixed base', () => {
    expect(resolve(SOLVER_DELAY)).toBe(SOLVER_DELAY)
    expect(resolve(BASE)).toBe(BASE)
  })

  it('rejects malformed or non-whole values before any derivation', () => {
    for (const value of [
      null,
      '612864',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      612_864.5,
      0,
      -512,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() => resolve(value)).toThrow(/positive whole number/)
    }
  })

  it('rejects non-finite or non-positive timing inputs', () => {
    expect(() => resolve(SOLVER_DELAY, { claimDelay: 0 })).toThrow(/claim delay/)
    expect(() => resolve(SOLVER_DELAY, { refundLocktime: 0 })).toThrow(/refund locktime/)
    expect(() => resolve(SOLVER_DELAY, { nowSeconds: Number.NaN })).toThrow(/quote time/)
  })

  it('rejects a value that would be read in the wrong BIP68 unit', () => {
    expect(() => resolve(BIP68_REFUND_GRANULARITY_SECONDS - 1)).toThrow(/whole multiple/)
    expect(() => resolve(SOLVER_DELAY + 1)).toThrow(/whole multiple/)
  })

  it('rejects a delay below the locally derived solo-refund floor', () => {
    expect(() => resolve(BASE - 512)).toThrow(/below the independently derived solo-refund floor/)
  })

  it('rejects a delay beyond the bounded refund horizon', () => {
    expect(resolve(SOLVER_HORIZON_MAX)).toBe(SOLVER_HORIZON_MAX)
    expect(() => resolve(SOLVER_HORIZON_MAX + BIP68_REFUND_GRANULARITY_SECONDS)).toThrow(
      /beyond the bounded refund horizon/,
    )
  })

  it('enforces the absolute recovery ceiling on the quoted refund horizon', () => {
    const atCeiling =
      Math.floor(
        (MAX_QUOTED_REFUND_HORIZON_SECONDS - BIP68_REFUND_GRANULARITY_SECONDS) / BIP68_REFUND_GRANULARITY_SECONDS,
      ) * BIP68_REFUND_GRANULARITY_SECONDS
    const requiredAtCeiling = Math.ceil(atCeiling / BIP68_REFUND_GRANULARITY_SECONDS) * BIP68_REFUND_GRANULARITY_SECONDS
    expect(resolve(requiredAtCeiling, { refundLocktime: NOW + atCeiling })).toBe(requiredAtCeiling)
    expect(() => resolve(BASE, { refundLocktime: NOW + MAX_QUOTED_REFUND_HORIZON_SECONDS + 1 })).toThrow(
      /beyond the .*sender recovery ceiling/,
    )
    // A far-future locktime cannot smuggle an unbounded window in under a small CSV.
    expect(() => resolve(BASE, { refundLocktime: NOW + 400 * 24 * 3600 })).toThrow(/sender recovery ceiling/)
  })

  it('rejects a value beyond the longest encodable BIP68 timelock', () => {
    const quoted = 0xffff * BIP68_REFUND_GRANULARITY_SECONDS + BIP68_REFUND_GRANULARITY_SECONDS
    expect(() => resolve(quoted, { refundLocktime: NOW + MAX_QUOTED_REFUND_HORIZON_SECONDS })).toThrow(/longest BIP68/)
  })

  it('rejects a newly advertised block-typed value as an unencodable seconds timelock', () => {
    const blockClaim = 20
    const blockBase = blockClaim + 8
    expect(() =>
      resolveQuotedRefundWithoutReceiverDelay({
        quoted: blockBase,
        claimDelay: blockClaim,
        refundLocktime: 200,
        nowSeconds: NOW,
      }),
    ).toThrow(/whole multiple/)
  })
})
