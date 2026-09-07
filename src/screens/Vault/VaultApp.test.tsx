import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { VaultProvider } from '../../providers/vault'
import VaultApp from '../../VaultApp'
import { SAVINGS_TEMPLATE } from '../../lib/vault/program/constants'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../lib/vault/spendingPolicy'
import { REQUIRED_CONNECTOR_CAPABILITY } from '../../lib/vault/program/connectorEnroll'

vi.mock('../../lib/vault/status', async (original) => ({
  ...(await original<typeof import('../../lib/vault/status')>()),
  fetchPublicStatus: vi.fn(async () => ({
    network: 'mutinynet',
    clientOrigin: location.origin,
    rpId: location.hostname,
    templateVersion: SAVINGS_TEMPLATE,
    policyVersion: 'vault-spending-policy-v1',
    enrollmentMode: 'open',
    spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
    connectorCapability: REQUIRED_CONNECTOR_CAPABILITY,
    vtxoBoardingProgram: 'vault-board-v1',
  })),
}))
const signerDescriptor = `wpkh([12345678/84h/1h/0h/0/0]${PROGRAM_FIXTURE.hardwarePub})`

function renderVault() {
  window.localStorage.clear()
  return render(
    <ToastProvider>
      <VaultProvider>
        <VaultApp />
      </VaultProvider>
    </ToastProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('VaultApp onboarding', () => {
  it('requires hardware, rules, and a passkey enrollment before the wallet home', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('blockchain.info')
          ? new Response(JSON.stringify({ USD: { last: 100_000 } }), { status: 200 })
          : new Response('{}', { status: 503 }),
      ),
    )
    renderVault()

    expect(await screen.findByRole('heading', { name: /Everyday spending/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Look around first' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Get started' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in to an existing vault' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Get started' }))

    await user.click(await screen.findByRole('button', { name: /^Standard/ }))

    expect(await screen.findByRole('heading', { name: 'Add your hardware key' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Paste' }))
    fireEvent.change(screen.getByTestId('hardware-pub'), { target: { value: signerDescriptor } })
    await user.click(screen.getByRole('button', { name: 'Use this hardware key' }))

    expect(await screen.findByRole('heading', { name: 'Set your spending limits' })).toBeTruthy()
    expect(screen.getByTestId('policy-tx-cap')).toBeTruthy()
    expect(screen.getByTestId('policy-period-allowance')).toBeTruthy()
    expect(screen.queryByTestId('policy-fee-cap')).toBeNull()
    expect(screen.queryByTestId('policy-feerate-cap')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Review setup' }))

    expect(await screen.findByRole('heading', { name: 'Review your Vault' })).toBeTruthy()
    expect(screen.getByText('50,000 sats')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Create your passkey' })).toBeTruthy()
    expect(screen.queryByTestId('enrollment-token')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Vault' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create Vault' })).toBeTruthy()
    expect(screen.getByTestId('passkey-unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
    expect(screen.queryByTestId('vault-balance')).toBeNull()
  }, 20_000)

  it('requires a recovery key for Advanced and reviews its consequence', async () => {
    const user = userEvent.setup()
    renderVault()
    await user.click(await screen.findByRole('button', { name: 'Get started' }))
    await user.click(await screen.findByRole('button', { name: /^Advanced/ }))
    await user.click(await screen.findByRole('button', { name: 'Paste' }))
    fireEvent.change(await screen.findByTestId('hardware-pub'), {
      target: { value: signerDescriptor },
    })
    await user.click(screen.getByRole('button', { name: 'Use this hardware key' }))

    expect(screen.getByRole('button', { name: 'Use this recovery key' })).toBeDisabled()
    fireEvent.change(screen.getByTestId('recovery-pub'), { target: { value: PROGRAM_FIXTURE.recoveryPub } })
    await user.click(screen.getByRole('button', { name: 'Use this recovery key' }))
    await user.click(await screen.findByRole('button', { name: 'Review setup' }))

    expect(await screen.findByText('Advanced')).toBeTruthy()
    expect(screen.getByText(/The separate recovery key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  }, 20_000)
})
