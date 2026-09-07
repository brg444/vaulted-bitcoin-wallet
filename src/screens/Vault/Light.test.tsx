import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import VaultLight from './Light'

const mocks = vi.hoisted(() => ({ pending: vi.fn(), verify: vi.fn() }))
vi.mock('../../lib/vault/status', async (original) => ({
  ...(await original<typeof import('../../lib/vault/status')>()),
  fetchPublicStatus: vi.fn(async () => ({ network: 'mutinynet', supportedSetups: ['light'], enrollmentMode: 'open' })),
}))
vi.mock('../../lib/vault/light/enrollment', async (original) => ({
  ...(await original<typeof import('../../lib/vault/light/enrollment')>()),
  loadLightEnrollment: () => null,
  loadPendingLightEnrollment: mocks.pending,
  verifySavedLightRecoveryFile: mocks.verify,
}))
beforeEach(() => {
  localStorage.clear()
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
