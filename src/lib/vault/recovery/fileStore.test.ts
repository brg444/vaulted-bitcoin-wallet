import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { recoveryFileStore, storeRecoveryImport } from './fileStore'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('retains the previous complete generation in the same database transaction', async () => {
  await recoveryFileStore('wallet', { generation: 1 })
  await recoveryFileStore('wallet', { generation: 2 })
  expect(await recoveryFileStore('wallet')).toEqual({ generation: 2 })
  expect(await recoveryFileStore('previous:wallet')).toEqual({ generation: 1 })
})

it('retains the current and previous generations if the replacement write fails', async () => {
  await recoveryFileStore('wallet', { generation: 1 })
  await recoveryFileStore('wallet', { generation: 2 })
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (key === 'wallet') throw new DOMException('Storage is full', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  await expect(recoveryFileStore('wallet', { generation: 3 })).rejects.toThrow('Storage is full')
  expect(await recoveryFileStore('wallet')).toEqual({ generation: 2 })
  expect(await recoveryFileStore('previous:wallet')).toEqual({ generation: 1 })
})

it('does not replace local evidence when importing an older file, including after restart', async () => {
  await recoveryFileStore('wallet', { generation: 2 })
  await storeRecoveryImport('wallet', { generation: 1 })
  expect(await recoveryFileStore('wallet')).toEqual({ generation: 2 })
  await storeRecoveryImport('fresh-wallet', { generation: 1 })
  expect(await recoveryFileStore('fresh-wallet')).toEqual({ generation: 1 })
})
