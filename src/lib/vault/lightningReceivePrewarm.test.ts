import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  discover: vi.fn(),
  operator: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('./lightning', () => ({ discoverVaultLightningSolver: mocks.discover }))
vi.mock('./vtxo/walletWorker', () => ({ ensureVaultWalletWorker: mocks.worker }))
vi.mock('./operatorInfoCache', () => ({
  getOperatorInfo: mocks.operator,
  invalidateOperatorInfo: mocks.invalidate,
}))

import {
  forgetLightningReceivePrewarm,
  lightningReceivePrewarmState,
  prewarmLightningReceive,
} from './lightningReceivePrewarm'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'

const status = sharedSpendingStatus()

beforeEach(() => {
  forgetLightningReceivePrewarm()
  mocks.worker.mockReset().mockResolvedValue({})
  mocks.discover.mockReset().mockResolvedValue({ pubkey: 'aa'.repeat(32) })
  mocks.operator.mockReset().mockResolvedValue({ signerPubkey: '02'.repeat(33) })
  mocks.invalidate.mockReset()
})

it('warms worker, solver and Operator info once for repeated mounts', async () => {
  await prewarmLightningReceive(status)
  await prewarmLightningReceive(status)
  await prewarmLightningReceive(status)
  expect(mocks.worker).toHaveBeenCalledOnce()
  expect(mocks.discover).toHaveBeenCalledOnce()
  expect(mocks.operator).toHaveBeenCalledOnce()
})

it('shares one in-flight warm across concurrent mounts', async () => {
  let release!: () => void
  mocks.worker.mockReturnValue(new Promise<void>((resolve) => (release = () => resolve())))
  const first = prewarmLightningReceive(status)
  const second = prewarmLightningReceive(status)
  expect(first).toBe(second)
  release()
  await Promise.all([first, second])
  expect(mocks.worker).toHaveBeenCalledOnce()
})

it('clears a failed warm so the next mount or click retries', async () => {
  mocks.worker.mockRejectedValueOnce(new Error('cold worker'))
  await expect(prewarmLightningReceive(status)).rejects.toThrow('cold worker')
  await Promise.resolve()
  expect(lightningReceivePrewarmState().warming).toBe(0)
  mocks.worker.mockResolvedValue({})
  await prewarmLightningReceive(status)
  expect(mocks.worker).toHaveBeenCalledTimes(2)
})

it('drops warm state for the scope on an account or network change', async () => {
  await prewarmLightningReceive(status)
  forgetLightningReceivePrewarm(status)
  expect(mocks.invalidate).toHaveBeenCalled()
  expect(lightningReceivePrewarmState().warming).toBe(0)
  await prewarmLightningReceive(status)
  expect(mocks.worker).toHaveBeenCalledTimes(2)
})
