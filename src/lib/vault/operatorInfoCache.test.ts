import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  OPERATOR_INFO_TTL_MS,
  getOperatorInfo,
  invalidateOperatorInfo,
  operatorInfoCacheState,
  type OperatorInfoReader,
} from './operatorInfoCache'

const ORIGIN = 'https://ark.example'
const info = (signerPubkey = '02'.repeat(33)) => ({ signerPubkey }) as never

function reader(getInfo: () => Promise<unknown>): OperatorInfoReader {
  return { getInfo: getInfo as OperatorInfoReader['getInfo'] }
}

beforeEach(() => {
  invalidateOperatorInfo()
})

afterEach(() => {
  invalidateOperatorInfo()
})

it('reuses a warm result and reads once', async () => {
  const getInfo = vi.fn(async () => info())
  expect(await getOperatorInfo(ORIGIN, reader(getInfo))).toMatchObject(info())
  expect(await getOperatorInfo(ORIGIN, reader(getInfo))).toMatchObject(info())
  expect(getInfo).toHaveBeenCalledOnce()
})

it('coalesces concurrent in-flight reads for one origin', async () => {
  let resolve!: (value: unknown) => void
  const getInfo = vi.fn(() => new Promise((yes) => (resolve = yes)))
  const first = getOperatorInfo(ORIGIN, reader(getInfo))
  const second = getOperatorInfo(ORIGIN, reader(getInfo))
  expect(getInfo).toHaveBeenCalledOnce()
  resolve(info())
  await expect(first).resolves.toMatchObject(info())
  await expect(second).resolves.toMatchObject(info())
})

it('does not cache failures and retries on the next call', async () => {
  const getInfo = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(info())
  await expect(getOperatorInfo(ORIGIN, reader(getInfo))).rejects.toThrow('temporary')
  await expect(getOperatorInfo(ORIGIN, reader(getInfo))).resolves.toMatchObject(info())
  expect(getInfo).toHaveBeenCalledTimes(2)
})

it('refreshes after the TTL expires', async () => {
  const getInfo = vi.fn(async () => info())
  const start = Date.now()
  await getOperatorInfo(ORIGIN, reader(getInfo), start)
  await getOperatorInfo(ORIGIN, reader(getInfo), start + OPERATOR_INFO_TTL_MS - 1)
  expect(getInfo).toHaveBeenCalledOnce()
  await getOperatorInfo(ORIGIN, reader(getInfo), start + OPERATOR_INFO_TTL_MS + 1)
  expect(getInfo).toHaveBeenCalledTimes(2)
})

it('invalidates one origin or the whole session', async () => {
  const getInfo = vi.fn(async () => info())
  await getOperatorInfo(ORIGIN, reader(getInfo))
  invalidateOperatorInfo(ORIGIN)
  await getOperatorInfo(ORIGIN, reader(getInfo))
  expect(getInfo).toHaveBeenCalledTimes(2)
  invalidateOperatorInfo()
  await getOperatorInfo(ORIGIN, reader(getInfo))
  expect(getInfo).toHaveBeenCalledTimes(3)
})

it('never lets a late result from an old generation populate the new session', async () => {
  let resolve!: (value: unknown) => void
  const getInfo = vi.fn(() => new Promise((yes) => (resolve = yes)))
  const pending = getOperatorInfo(ORIGIN, reader(getInfo))
  // Connection/account change while the read is in flight.
  invalidateOperatorInfo()
  resolve(info('03'.repeat(33)))
  await pending
  expect(operatorInfoCacheState().entries).toBe(0)
  const fresh = vi.fn(async () => info('04'.repeat(33)))
  await getOperatorInfo(ORIGIN, reader(fresh))
  expect(fresh).toHaveBeenCalledOnce()
})
