import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import ConnectorDeposit from './ConnectorDeposit'
import type { VaultStatus } from '../../lib/vault/types'

vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }))
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  create: vi.fn(),
  submit: vi.fn(),
  finish: vi.fn(),
  abandon: vi.fn(),
  read: vi.fn(),
  accept: vi.fn(),
}))
vi.mock('../../lib/vault/connectorFunding', () => ({
  loadFunding: mocks.load,
  createFunding: mocks.create,
  submitFunding: mocks.submit,
  finishFunding: mocks.finish,
  abandonFunding: mocks.abandon,
}))
vi.mock('../../lib/vault/connectorSignerFile', () => ({ readConnectorSignerFile: mocks.read }))
const status = { vaultId: 'test' } as VaultStatus
const saved = {
  draft: {},
  prepared: { savings: 98000, reserve: 1000, fee: 1000, psbt: '00', txid: 'aa', accept: mocks.accept },
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockReturnValue(null)
  mocks.create.mockResolvedValue(saved)
  mocks.read.mockResolvedValue('unsigned')
})
it('imports a funding draft, shows the split, verifies the signed file and requires submission approval', async () => {
  const user = userEvent.setup()
  render(<ConnectorDeposit status={status} />)
  fireEvent.change(screen.getByLabelText('Unsigned deposit file'), {
    target: { files: [new File(['x'], 'draft.psbt')] },
  })
  await screen.findByText('98,000 sats')
  expect(screen.getByText('1,000 sats included')).toBeTruthy()
  expect(mocks.submit).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Continue to signing' }))
  mocks.read.mockResolvedValue('signed')
  fireEvent.change(screen.getByLabelText('Signed deposit file'), {
    target: { files: [new File(['y'], 'signed.psbt')] },
  })
  await screen.findByRole('button', { name: 'Submit deposit' })
  expect(mocks.accept).toHaveBeenCalledWith('signed')
  expect(mocks.submit).not.toHaveBeenCalled()
  mocks.submit.mockResolvedValue('aa')
  mocks.load.mockReturnValue({ ...saved, draft: { signed: 'raw', submitted: true } })
  await user.click(screen.getByRole('button', { name: 'Submit deposit' }))
  await screen.findByRole('heading', { name: 'Deposit submitted' })
  expect(mocks.submit).toHaveBeenCalledWith(status, 'signed')
})
it('restores a lost broadcast for exact-byte retry and keeps its signed file fixed', async () => {
  mocks.load.mockReturnValue({ ...saved, draft: { signed: 'raw' } })
  render(<ConnectorDeposit status={status} />)
  expect(await screen.findByRole('button', { name: 'Retry deposit submission' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Import signed deposit' })).toBeNull()
  expect(screen.queryByText(/Deposit submitted/)).toBeNull()
  mocks.finish.mockRejectedValue(new Error('Wait for Bitcoin confirmation'))
  await userEvent.click(screen.getByRole('button', { name: 'Check confirmation' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: 'Import unsigned deposit' })).toBeNull()
  mocks.finish.mockResolvedValue('aa')
  await userEvent.click(screen.getByRole('button', { name: 'Check confirmation' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Done' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import unsigned deposit' })).toBeTruthy())
})
