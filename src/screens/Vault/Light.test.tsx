import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import VaultLight from './Light'

const mocks = vi.hoisted(() => ({ pending: vi.fn(), verify: vi.fn(), status: vi.fn(), begin: vi.fn() }))
vi.mock('../../lib/vault/status', async (original) => ({
  ...(await original<typeof import('../../lib/vault/status')>()),
  fetchPublicStatus: mocks.status,
}))
vi.mock('../../lib/vault/light/enrollment', async (original) => ({
  ...(await original<typeof import('../../lib/vault/light/enrollment')>()),
  loadLightEnrollment: () => null,
  beginLightEnrollment: mocks.begin,
  loadPendingLightEnrollment: mocks.pending,
  verifySavedLightRecoveryFile: mocks.verify,
}))
beforeEach(() => {
  localStorage.clear()
  mocks.status
    .mockReset()
    .mockResolvedValue({ network: 'mutinynet', supportedSetups: ['light'], enrollmentMode: 'open' })
  mocks.begin.mockReset().mockRejectedValue(new Error('Enrollment test stopped before key creation'))
  mocks.pending.mockReset()
  mocks.verify.mockReset()
})
it('keeps Light restore methods in Help and opens local-file verification separately', async () => {
  render(<VaultLight onExit={vi.fn()} />)
  await screen.findByRole('button', { name: 'Create passkey' })
  expect(screen.queryByRole('button', { name: 'Restore with passkey' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Restore with passkey' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Verify file and unlock' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Use a local backup' }))
  expect(screen.getByRole('button', { name: 'Verify file and unlock' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
  expect(screen.getByRole('button', { name: 'Restore with passkey' })).toBeVisible()
})
it('requires the saved file to be verified before asking for the separate recovery secret', async () => {
  mocks.pending.mockReturnValue({ recoveryBackup: {}, descriptor: { vaultId: 'test' } })
  render(<VaultLight onExit={vi.fn()} />)
  const next = await screen.findByRole('button', { name: 'Continue to recovery secret' })
  expect(next).toBeDisabled()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.change(screen.getByLabelText('Choose the saved recovery file to verify it'), {
    target: { files: [{ size: 10, text: async () => '{}' }] },
  })
  await screen.findByText('Recovery file verified')
  expect(mocks.verify).toHaveBeenCalledOnce()
  fireEvent.click(next)
  expect(screen.getByRole('textbox', { name: 'Enter your saved secret to verify' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Verify backup and create wallet' })).toBeDisabled()
})

it('waits for network policy before editing limits and preserves its fee caps', async () => {
  let resolve!: (status: unknown) => void
  mocks.status.mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  render(<VaultLight onExit={vi.fn()} />)
  const payment = screen.getByLabelText('Per-payment limit, in sats')
  const period = screen.getByLabelText('Rolling 24-hour limit, in sats')
  expect(payment).toBeDisabled()
  expect(period).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Create passkey' })).toBeDisabled()
  await act(async () => resolve({ network: 'mutinynet', supportedSetups: ['light'], enrollmentMode: 'open' }))
  expect(payment).toBeEnabled()
  fireEvent.change(payment, { target: { value: '20000' } })
  fireEvent.change(period, { target: { value: '50000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create passkey' }))
  await waitFor(() =>
    expect(mocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        txRecipientCapSats: 20000,
        periodAllowanceSats: 50000,
        absoluteFeeCapSats: 5000,
        feerateCapSatPerV: 10,
      }),
      '',
      true,
    ),
  )
})
