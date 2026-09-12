import { LEDGER_NATIVE_TEMPLATE } from '../../../lib/vault/program/ledgerNativeKeys'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SavingsAvailability from './SavingsAvailability'

afterEach(cleanup)
describe('Savings availability follows the enrolled program', () => {
  it('states the single Guardian recovery trust boundary for Ledger Savings', () => {
    render(<SavingsAvailability templateVersion={LEDGER_NATIVE_TEMPLATE} />)
    expect(screen.getByText(/ordinary Savings payments without the Guardian/)).toBeVisible()
    expect(screen.getByText(/can bypass the recovery delay/)).toBeVisible()
    expect(screen.queryByText(/requires both services/)).toBeNull()
  })
  it('does not guess the program for a visitor without a kit', () => {
    render(<SavingsAvailability />)
    expect(screen.queryByText(/Guardian/)).toBeNull()
    expect(screen.queryByText(/ordinary Savings transfer without/)).toBeNull()
  })
})
