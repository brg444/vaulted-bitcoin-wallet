import { afterEach, expect, it, vi } from 'vitest'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime, vaultAccountRuntime } from './accountRuntime'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'

const status = sharedSpendingStatus()
afterEach(async () => {
  const account = activeVaultAccountRuntime(status.vaultId)
  if (account) await disposeVaultAccountRuntime(account)
})

it('owns maintenance before any SDK connection and reuses the retained account identity', async () => {
  const account = vaultAccountRuntime(status)
  expect(vaultAccountRuntime(structuredClone(status))).toBe(account)
  expect(account.connection).toBeUndefined()
  expect(account.initialization).toBeUndefined()
  const read = account.maintenance.observe('bitcoin-payment', async () => 'confirmed', { intervalMs: 15_000 })
  expect(await read.refresh()).toBe('confirmed')
  expect(account.connection).toBeUndefined()
})

it('invalidates old task authority on a network round trip and drains it before closing its connection', async () => {
  const first = vaultAccountRuntime(status)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const publish = vi.fn()
  first.closeConnection = vi.fn(async () => undefined)
  const work = first.maintenance.observe(
    'recovery-archive',
    async (signal) => {
      await gate
      if (!signal.aborted) publish()
    },
    { intervalMs: 30_000 },
  )
  const pending = work.refresh()
  await Promise.resolve()
  const second = vaultAccountRuntime({ ...status, network: 'mainnet' })
  const third = vaultAccountRuntime(status)
  expect(third).not.toBe(first)
  expect(first.disposed).toBe(true)
  expect(second.disposed).toBe(true)
  expect(first.closeConnection).not.toHaveBeenCalled()
  finish()
  await Promise.all([pending, third.previous])
  expect(first.closeConnection).toHaveBeenCalledOnce()
  expect(publish).not.toHaveBeenCalled()
  const current = third.maintenance.observe('recovery-archive', async () => 'current', { intervalMs: 30_000 })
  expect(await current.refresh()).toBe('current')
})
