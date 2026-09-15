import { describe, expect, it } from 'vitest'
import { BitcoinPaymentError, bitcoinPaymentCredentialError, bitcoinPaymentRejected } from './bitcoinPaymentError'

describe('bitcoin payment rejection copy', () => {
  it('keeps the Guardian reason as details with a not_sent outcome', () => {
    const error = bitcoinPaymentRejected('Guardian rejected: input already reserved')
    expect(error).toBeInstanceOf(BitcoinPaymentError)
    expect(error.outcome).toBe('not_sent')
    expect(error.details).toContain('input already reserved')
  })
})

describe('passkey credential classification', () => {
  it('maps cancellation to retryable not_sent', () => {
    const error = bitcoinPaymentCredentialError(new DOMException('The operation was aborted.', 'AbortError'))
    expect(error).toBeInstanceOf(BitcoinPaymentError)
    expect((error as BitcoinPaymentError).outcome).toBe('not_sent')
  })

  it('maps platform refusal to retryable not_sent', () => {
    const error = bitcoinPaymentCredentialError(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    expect(error).toBeInstanceOf(BitcoinPaymentError)
    expect((error as BitcoinPaymentError).outcome).toBe('not_sent')
  })

  it('passes unexpected ceremony errors through untouched', () => {
    const original = new Error('deployment RP ID does not match this signing client host')
    expect(bitcoinPaymentCredentialError(original)).toBe(original)
  })
})
