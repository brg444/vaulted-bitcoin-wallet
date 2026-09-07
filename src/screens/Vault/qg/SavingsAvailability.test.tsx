import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SavingsAvailability from './SavingsAvailability'
import { SAVINGS_TEMPLATE } from '../../../lib/vault/program/constants'
import { CONNECTOR_TEMPLATE } from '../../../lib/vault/program/connector'

afterEach(cleanup)
describe('Savings availability follows the enrolled program', () => {
  it('limits the service-independent ordinary transfer to the legacy program', () => {
    render(<SavingsAvailability templateVersion={SAVINGS_TEMPLATE} />)
    expect(screen.getByText(/ordinary Savings transfer without the recovery services/)).toBeVisible()
  })
  it('explains retained approvals for connector Savings', () => {
    render(<SavingsAvailability templateVersion={CONNECTOR_TEMPLATE} />)
    expect(screen.getByText(/Connector Savings needs service approvals/)).toBeVisible()
    expect(screen.queryByText(/ordinary Savings transfer without/)).toBeNull()
  })
  it('does not guess the program for a visitor without a kit', () => {
    render(<SavingsAvailability />)
    expect(screen.getByText(/depend on the enrolled program/)).toBeVisible()
    expect(screen.queryByText(/ordinary Savings transfer without/)).toBeNull()
  })
})
