import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { isServerCovered, useNativePaymentNotifications } from './useNativePaymentNotifications'
import type { VaultHistoryItem } from '../lib/vault/history'

const scope = { network: 'mainnet', vaultId: 'vault-1' }
const arkadeReceive: VaultHistoryItem = {
  txid: 'ab'.repeat(32),
  type: 'received',
  amount: 5000,
  confirmed: true,
  account: 'spend',
}
const savingsReceive: VaultHistoryItem = {
  txid: 'cd'.repeat(32),
  type: 'received',
  amount: 7000,
  confirmed: true,
  account: 'savings',
}
const lightningReceive: VaultHistoryItem = {
  txid: 'ef'.repeat(32),
  type: 'received',
  amount: 9000,
  confirmed: true,
  account: 'spend',
  activity: 'lightning',
  lightningState: 'settled',
  lightningRfqId: 'rfq-1',
}

function deps(overrides: Partial<Parameters<typeof useNativePaymentNotifications>[5]> = {}) {
  const showNotification = vi.fn().mockResolvedValue(undefined)
  return {
    showNotification,
    deps: {
      getRegistration: () => Promise.resolve({ showNotification } as unknown as ServiceWorkerRegistration),
      idbFactory: new IDBFactory() as unknown as IDBFactory,
      ...overrides,
    },
  }
}

describe('server coverage classification', () => {
  it('covers Spending Arkade and Lightning receipts, never Savings', () => {
    expect(isServerCovered(arkadeReceive, scope)).toBe(true)
    expect(isServerCovered(lightningReceive, scope)).toBe(true)
    expect(isServerCovered(savingsReceive, scope)).toBe(false)
    expect(isServerCovered({ ...arkadeReceive, type: 'sent' }, scope)).toBe(false)
  })
})

describe('foreground native notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('announces an uncovered Savings receipt natively', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), d), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    }).rerender({ rows: [savingsReceive] })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    const [title, options] = showNotification.mock.calls[0] as [string, Record<string, unknown>]
    expect(title).toBe('Payment received')
    expect(options.body).toBe('Open Vaulted to view your activity')
    expect(options.tag).toBe('vaulted-payment')
    expect(JSON.stringify(options)).not.toMatch(/[0-9a-f]{8}/)
  })

  it('stays silent for server-owned receipts under every subscription state', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const hook = renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), d), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    })
    // Server push owns these — even with the app open, even unsubscribed.
    hook.rerender({ rows: [arkadeReceive, lightningReceive] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(showNotification).not.toHaveBeenCalled()
    hook.rerender({ rows: [arkadeReceive, lightningReceive, savingsReceive] })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
  })

  it('arbitrates one announcement across tabs sharing the claim domain', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const factory = new IDBFactory() as unknown as IDBFactory
    const first = deps({ idbFactory: factory })
    const second = deps({ idbFactory: factory })
    const renderFirst = renderHook(
      ({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), first.deps),
      {
        initialProps: { rows: [] as VaultHistoryItem[] },
      },
    )
    const renderSecond = renderHook(
      ({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), second.deps),
      {
        initialProps: { rows: [] as VaultHistoryItem[] },
      },
    )
    renderFirst.rerender({ rows: [savingsReceive] })
    renderSecond.rerender({ rows: [savingsReceive] })
    await waitFor(() =>
      expect(first.showNotification.mock.calls.length + second.showNotification.mock.calls.length).toBe(1),
    )
  })

  it('buffers while locked and flushes once on unlock', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const hook = renderHook(
      ({ rows, paused }) => useNativePaymentNotifications(rows, scope, paused, true, new Set(), d),
      { initialProps: { rows: [] as VaultHistoryItem[], paused: true } },
    )
    hook.rerender({ rows: [savingsReceive], paused: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(showNotification).not.toHaveBeenCalled()
    hook.rerender({ rows: [savingsReceive], paused: false })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
  })

  it('drops stale scope work after an A-B-A change', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const scopeA = { network: 'mainnet', vaultId: 'vault-a' }
    const scopeB = { network: 'mainnet', vaultId: 'vault-b' }
    const rowsA = [{ ...savingsReceive, txid: 'aa'.repeat(32) }]
    const hook = renderHook(
      ({ rows, current }) => useNativePaymentNotifications(rows, current, false, true, new Set(), d),
      { initialProps: { rows: [] as VaultHistoryItem[], current: scopeA } },
    )
    hook.rerender({ rows: rowsA, current: scopeA })
    // Switch scope before async delivery resolves: A work must not show.
    hook.rerender({ rows: [], current: scopeB })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('never prompts and never shows amounts', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const { showNotification, deps: d } = deps()
    renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), d), {
      initialProps: { rows: [savingsReceive] },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requestPermission).not.toHaveBeenCalled()
    expect(showNotification).not.toHaveBeenCalled()
  })
})
