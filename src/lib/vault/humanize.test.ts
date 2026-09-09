import { describe, expect, it } from 'vitest'
import { humanizeVaultError, isRecoverableVaultBoardingError } from './humanize'
import { VaultConcurrencyUnavailableError } from './vtxo/lock'

describe('humanizeVaultError', () => {
  it('renders the canonical missing Web Locks capability error', () => {
    expect(humanizeVaultError(new VaultConcurrencyUnavailableError())).toBe(
      'This browser can’t safely coordinate wallet activity. Update it or use a supported browser.',
    )
  })

  it('turns a network failure into a service message', () => {
    expect(humanizeVaultError(new Error('Failed to fetch'))).toMatch(/can’t reach|try again/i)
  })

  it('turns an empty proxy 500 into a service message', () => {
    expect(humanizeVaultError(new Error('Request failed (500)'))).toMatch(/can’t reach|try again/i)
    expect(humanizeVaultError(new Error('vault service is not running'))).toMatch(/can’t reach|try again/i)
  })

  it('does not expose Operator intent internals during boarding', () => {
    expect(
      humanizeVaultError(new Error('INVALID_INTENT_PROOF (23): no matching intents found for intent proof')),
    ).toMatch(/Moving received Bitcoin.*approve with passkey/i)
    expect(humanizeVaultError(new Error('INTERNAL_ERROR (0): not enough intent confirmations received'))).toMatch(
      /Moving received Bitcoin.*approve with passkey/i,
    )
    expect(isRecoverableVaultBoardingError(new Error('EventSource error'))).toBe(true)
    expect(
      isRecoverableVaultBoardingError(new Error('duplicated input, 11:0 already registered by another intent')),
    ).toBe(true)
    expect(isRecoverableVaultBoardingError(new Error('Failed to fetch'))).toBe(false)
  })

  it('does not surface issuance-binding or mutated Phone internals', () => {
    expect(humanizeVaultError(new Error('issuance aa is already bound to a different exact request'))).toMatch(
      /already in progress/i,
    )
    expect(humanizeVaultError(new Error('Authorized response mutated the PhoneBIP340 signature'))).toMatch(
      /rejected a changed signature/i,
    )
  })

  it('does not expose VTXO receipt internals after submission', () => {
    expect(humanizeVaultError(new Error('Reserved outpoint not spent by ark txid'))).toMatch(
      /send was submitted.*confirmed/i,
    )
    expect(humanizeVaultError(new Error('Operator pending lookup did not return exactly one transaction'))).toMatch(
      /send was submitted.*confirmed/i,
    )
    expect(humanizeVaultError(new Error('VTXO spend is unresolved'))).toMatch(/did not finish/i)
    expect(humanizeVaultError(new Error('VTXO reservation expired'))).toMatch(/did not finish/i)
  })

  it('explains an exact-amount send that is still in progress', () => {
    expect(humanizeVaultError(new Error('A send of this exact amount to this address is still in progress.'))).toMatch(
      /reserved.*resume payment/i,
    )
  })

  it('keeps active-operation, unsafe-abort, and lookup failures specific', () => {
    expect(humanizeVaultError(new Error('A send is already with the operator and cannot be cancelled.'))).toMatch(
      /cannot be cancelled.*resume payment/i,
    )
    expect(humanizeVaultError(new Error('vtxo operation already active'))).toMatch(
      /with the operator.*cannot be cancelled/i,
    )
    expect(humanizeVaultError(new Error('The reserved send could not be aborted.'))).toMatch(/could not be aborted/i)
    expect(
      humanizeVaultError(
        new Error('Pending send lookup failed: Operator pending lookup did not return exactly one transaction'),
      ),
    ).toMatch(/status could not be confirmed.*remain blocked/i)
  })

  it('keeps an expired reviewed quote actionable', () => {
    expect(humanizeVaultError(new Error('This fee quote expired or changed. Review the send again.'))).toBe(
      'This fee quote expired or changed. Review the send again.',
    )
  })

  it('does not expose signing scalar internals', () => {
    expect(humanizeVaultError(new Error('Invalid scalar: out of range'))).toBe(
      'Couldn’t unlock Spending. Sign in again.',
    )
  })

  it('explains a cancelled passkey', () => {
    expect(humanizeVaultError(new Error('The operation was aborted.'))).toMatch(/wasn.t created|try again/i)
  })

  it('explains an unsupported platform authenticator', () => {
    const error = new Error('Authenticator is not available')
    error.name = 'NotSupportedError'
    expect(humanizeVaultError(error)).toMatch(/can.t create the device key.*Safari or Chrome/i)
  })

  it('explains a missing recovery envelope', () => {
    expect(
      humanizeVaultError(new Error('passkey sign-in must first be enabled on the original enrolled device')),
    ).toMatch(/first browser|Enable sign-in/i)
  })

  it('explains an origin mismatch', () => {
    expect(humanizeVaultError(new Error('deployment origin does not match this signing client origin'))).toMatch(
      /wrong site/i,
    )
  })

  it('explains a swapped deposit address pin', () => {
    expect(humanizeVaultError(new Error('status deposit address does not match the local pin'))).toMatch(/don.t send/i)
  })

  it('explains a server that cannot enroll the current program', () => {
    expect(humanizeVaultError(new Error('enroll needs the current Vault Program descriptor'))).toMatch(
      /doesn.t match|update/i,
    )
  })

  it('explains a rejected Chrome passkey as a different credential store', () => {
    expect(humanizeVaultError(new Error('this passkey did not return its 32-byte PRF secret on this device'))).toMatch(
      /unlock secret|device that created/i,
    )
    expect(humanizeVaultError(new Error('passkey authentication failed'))).toMatch(/scan the QR|original/i)
    expect(humanizeVaultError(new Error('this passkey does not belong to this vault'))).toMatch(/scan the QR|original/i)
  })

  it('distinguishes a verified PRF whose saved phone-key envelope cannot be opened', () => {
    expect(
      humanizeVaultError(new Error('passkey PRF authentication succeeded but could not decrypt the saved phone key')),
    ).toMatch(/passkey was verified.*saved Spending key.*same sign-in button/i)
  })

  it('does not mislabel a vault script mismatch as a passkey failure', () => {
    expect(humanizeVaultError(new Error('savings tree does not match this vault’s address'))).toBe(
      'This app doesn’t match the vault. Update and try again.',
    )
  })

  it('never exposes an unknown implementation error in the wallet UI', () => {
    expect(humanizeVaultError(new Error('INTERNAL_ERROR (0): opaque SDK detail'))).toBe(
      'Something went wrong. Try again.',
    )
  })

  it('sends a split-host passkey to the authorizer signing origin', () => {
    expect(humanizeVaultError(new Error('deployment RP ID does not match this signing client host'))).toMatch(
      /rc\.getvaulted\.xyz/,
    )
    expect(humanizeVaultError(new Error('Open this vault from its signing address.'))).toMatch(/rc\.getvaulted\.xyz/)
  })

  it('explains a failed Spending worker start without asking the user to tap Retry', () => {
    const message = humanizeVaultError(new Error('SDK worker did not register the Spending contract'))
    expect(message).toMatch(/Spending could not start/)
    expect(message).not.toMatch(/tap retry/i)
    expect(humanizeVaultError(new Error('Unsupported network: mainnet'))).toMatch(/Spending could not start/)
    expect(
      humanizeVaultError(
        new AggregateError(
          [new Error('SDK worker derived a different boarding address'), new Error('teardown failed')],
          'Vault wallet initialization and teardown failed',
        ),
      ),
    ).toMatch(/Spending could not start/)
  })
})

describe('Ledger enrollment errors', () => {
  it.each([
    [
      'Finish or cancel the Ledger setup already in progress.',
      'Finish or cancel the Ledger setup already in progress.',
    ],
    [
      'Ledger Savings enrollment is not available on this deployment yet.',
      'This Guardian does not support Ledger Savings setup yet. Your passkey has not been created.',
    ],
    [
      'Spending recovery key does not match the selected Ledger account',
      'The selected Ledger account does not match the recovery key. Import the intended public account again.',
    ],
    [
      'Ledger recovery account does not match the selected protection',
      'The selected protection does not match your Ledger accounts. Review your hardware and recovery accounts.',
    ],
    [
      'Guardian changed the selected Ledger Savings enrollment',
      'The returned vault does not match your selected Ledger setup. Setup has not completed.',
    ],
    [
      'Ledger enrollment changed while completing setup',
      'The returned vault does not match your saved Ledger setup. Keep this browser data and retry the original setup.',
    ],
    [
      'Staged Ledger enrollment changed',
      'The saved Ledger setup could not be verified. Keep this browser data and review the original setup.',
    ],
    [
      'Ledger registration does not match this Savings wallet. Register the original policy again.',
      'The Ledger registration does not match this vault. Register the original Savings policy again.',
    ],
  ])('keeps the known enrollment condition actionable: %s', (message, expected) => {
    expect(humanizeVaultError(new Error(message))).toBe(expected)
  })

  it('does not expose arbitrary Ledger error details', () => {
    expect(humanizeVaultError(new Error('Ledger internal detail: 012345'))).toBe('Something went wrong. Try again.')
    expect(humanizeVaultError(new Error('Staged Ledger enrollment changed: opaque server detail'))).toBe(
      'Something went wrong. Try again.',
    )
  })
})
