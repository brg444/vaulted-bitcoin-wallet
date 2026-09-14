import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import type { VaultHistoryItem } from '../lib/vault/history'

const delivery = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('../lib/vault/nativeNotifications', () => ({ showForegroundPaymentNotice: delivery.show }))

import { useNativePaymentNotifications } from './useNativePaymentNotifications'

const scope = { network: 'mainnet', vaultId: 'vault-1' }
const savingsReceive: VaultHistoryItem = {
  txid: 'cd'.repeat(32),
  type: 'received',
  amount: 7000,
  confirmed: true,
  account: 'savings',
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('swallows an advisory delivery rejection without an unhandled rejection', async () => {
  vi.stubGlobal('Notification', { permission: 'granted' })
  delivery.show.mockRejectedValue(new Error('delivery failed'))
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const hook = renderHook(
      ({ rows }: { rows: VaultHistoryItem[] }) =>
        useNativePaymentNotifications(rows, scope, false, true, new Set(), {
          getRegistration: () => Promise.resolve({ showNotification: vi.fn() } as unknown as ServiceWorkerRegistration),
          idbFactory: new IDBFactory() as unknown as IDBFactory,
        }),
      { initialProps: { rows: [] as VaultHistoryItem[] } },
    )
    hook.rerender({ rows: [savingsReceive] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(delivery.show).toHaveBeenCalledOnce()
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
