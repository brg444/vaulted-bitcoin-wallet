import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { WebHaptics } from 'web-haptics'
import type { VaultHistoryItem } from '../lib/vault/history'
import { usePaymentArrivals } from './usePaymentArrivals'

/**
 * Haptic invocation uses the real web-haptics library (never mocked here)
 * to prove the wallet calls into the fallback path on arrival. Whether
 * anything vibrates is a device capability outside this code: only browsers
 * exposing navigator.vibrate produce physical feedback, so this test asserts
 * invocation alone and never claims verified on-device behavior.
 */
describe('arrival haptic invocation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it('invokes the haptic fallback when a verified arrival delivers', async () => {
    const trigger = vi.spyOn(WebHaptics.prototype, 'trigger')
    try {
      const scope = { network: 'mutinynet', vaultId: 'vault-haptic' }
      const stored: VaultHistoryItem = {
        txid: 'stored',
        type: 'received',
        amount: 1,
        confirmed: true,
        account: 'spend',
      }
      const fresh: VaultHistoryItem = { ...stored, txid: 'fresh', amount: 12_000 }
      const { result, rerender } = renderHook(
        ({ rows }) =>
          usePaymentArrivals(rows, scope, false, true, new Set(), {
            bannersEnabled: true,
            hapticsEnabled: true,
          }),
        { initialProps: { rows: [stored] } },
      )
      rerender({ rows: [stored, fresh] })
      await waitFor(() => expect(result.current.arrivals.map((arrival) => arrival.item.txid)).toEqual(['fresh']))
      await waitFor(() => expect(trigger).toHaveBeenCalledWith('selection'))
    } finally {
      trigger.mockRestore()
    }
  })
})
