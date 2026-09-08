import { beforeEach, expect, it, vi } from 'vitest'
import { checkConnectorSetup } from './connectorSetup'
import { DUAL_CONNECTOR_TEMPLATE, CONNECTOR_TEMPLATE } from './program/connector'
import type { VaultStatus } from './types'

const mocks = vi.hoisted(() => ({ contract: vi.fn(), pending: vi.fn(), funding: vi.fn(), coins: vi.fn() }))
vi.mock('./connectorWithdrawal', () => ({
  connectorContract: mocks.contract,
  reconcileConnectorWithdrawal: mocks.pending,
}))
vi.mock('./connectorFunding', () => ({ loadFunding: mocks.funding }))
vi.mock('./esplora', () => ({ fetchAddressUtxos: mocks.coins }))
vi.mock('./program/connector', async (original) => ({
  ...(await original<object>()),
  buildConnectorFamily: () => ({ connector: { address: 'bc1qverifiedsigner' } }),
}))
const status = { vaultId: 'setup-test' } as VaultStatus
const coin = (vout: number, confirmed = true, value = 500) => ({
  txid: 'ab'.repeat(32),
  vout,
  value,
  status: { confirmed },
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.contract.mockReturnValue({ templateVersion: DUAL_CONNECTOR_TEMPLATE })
  mocks.pending.mockResolvedValue(null)
  mocks.funding.mockReturnValue(null)
  mocks.coins.mockResolvedValue([])
})

it('requires two distinct 500-sat outputs, including separate funding transactions', async () => {
  mocks.coins.mockResolvedValue([coin(0, true, 1000)])
  expect(await checkConnectorSetup(status)).toMatchObject({ required: 2, amount: 500, missing: 2, confirmed: 0 })
  mocks.coins.mockResolvedValue([coin(0), { ...coin(0), txid: 'cd'.repeat(32) }])
  expect(await checkConnectorSetup(status)).toMatchObject({ missing: 0, confirmed: 2 })
  expect(mocks.coins).toHaveBeenCalledWith('bc1qverifiedsigner')
})

it('counts pending outputs toward funding without marking them confirmed', async () => {
  mocks.coins.mockResolvedValue([coin(0), coin(1, false)])
  expect(await checkConnectorSetup(status)).toMatchObject({ missing: 0, confirmed: 1, pending: 1 })
  mocks.coins.mockResolvedValue([coin(0, false)])
  expect(await checkConnectorSetup(status)).toMatchObject({ missing: 1, confirmed: 0, pending: 1 })
})

it('retains the one-reserve requirement for existing v1 wallets', async () => {
  mocks.contract.mockReturnValue({ templateVersion: CONNECTOR_TEMPLATE })
  mocks.coins.mockResolvedValue([coin(0, true, 1000)])
  expect(await checkConnectorSetup(status)).toMatchObject({ amount: 1000, required: 1, missing: 0, confirmed: 1 })
})

it('blocks fresh funding while an existing deposit or transfer may use the reserves', async () => {
  mocks.funding.mockReturnValue({ draft: {} })
  expect(await checkConnectorSetup(status)).toEqual({ state: 'deposit' })
  expect(mocks.coins).not.toHaveBeenCalled()
  mocks.funding.mockReturnValue(null)
  mocks.pending.mockResolvedValue({ record: {} })
  expect(await checkConnectorSetup(status)).toEqual({ state: 'withdrawal' })
  expect(mocks.coins).not.toHaveBeenCalled()
})

it('does not turn failed verification, unavailable data or duplicate outputs into a funding request', async () => {
  mocks.contract.mockImplementationOnce(() => {
    throw new Error('Enrollment mismatch')
  })
  await expect(checkConnectorSetup(status)).rejects.toThrow('Enrollment mismatch')
  expect(mocks.coins).not.toHaveBeenCalled()
  mocks.coins.mockRejectedValueOnce(new Error('Offline'))
  await expect(checkConnectorSetup(status)).rejects.toThrow('Offline')
  mocks.coins.mockResolvedValue([coin(0), coin(0)])
  await expect(checkConnectorSetup(status)).rejects.toThrow('Could not check')
  mocks.coins.mockResolvedValue([{ ...coin(0), status: {} }])
  await expect(checkConnectorSetup(status)).rejects.toThrow('Could not check')
})
