import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { isServerCovered, useNativePaymentNotifications } from './useNativePaymentNotifications'
import type { VaultHistoryItem } from '../lib/vault/history'
import { loadArrivalBaseline, saveArrivalBaseline } from '../lib/vault/arrivalBaseline'
import { paymentIdentityForItem } from '../lib/vault/payments'

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

  it('coalesces a burst of verified receipts into one notice and claims every key', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const first = { ...savingsReceive, txid: 'a1'.repeat(32) }
    const second = { ...savingsReceive, txid: 'a2'.repeat(32) }
    const hook = renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), d), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    })
    hook.rerender({ rows: [first, second] })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    // Both arriving keys were claimed, so resupplying the same rows stays silent.
    hook.rerender({ rows: [first, second] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('flushes a buffered burst as one notice on unlock', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const first = { ...savingsReceive, txid: 'b1'.repeat(32) }
    const second = { ...savingsReceive, txid: 'b2'.repeat(32) }
    const hook = renderHook(
      ({ rows, paused }) => useNativePaymentNotifications(rows, scope, paused, true, new Set(), d),
      { initialProps: { rows: [] as VaultHistoryItem[], paused: true } },
    )
    hook.rerender({ rows: [first, second], paused: true })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(showNotification).not.toHaveBeenCalled()
    hook.rerender({ rows: [first, second], paused: false })
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
    hook.rerender({ rows: rowsA, current: scopeA })
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

describe('native arrival freshness and interruption', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('ignores partial hydration, seeds every first fresh row quietly, and does not replay on reload', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const stored = { ...savingsReceive, txid: 'old' }
    const omitted = { ...savingsReceive, txid: 'omitted' }
    saveArrivalBaseline(scope, new Map([[paymentIdentityForItem(stored, scope).key, true]]))
    const hook = renderHook(
      ({ rows, ready }) => useNativePaymentNotifications(rows, scope, false, ready, new Set(), d),
      {
        initialProps: { rows: [stored], ready: false },
      },
    )
    hook.rerender({ rows: [stored, omitted], ready: false })
    expect(loadArrivalBaseline(scope).has(paymentIdentityForItem(omitted, scope).key)).toBe(false)
    hook.rerender({ rows: [stored, omitted], ready: true })
    const rows = [stored, omitted, savingsReceive]
    hook.rerender({ rows, ready: true })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    hook.unmount()
    const reloaded = renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), d), {
      initialProps: { rows: [] as VaultHistoryItem[] },
    })
    reloaded.rerender({ rows: [stored] })
    reloaded.rerender({ rows })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('announces known pending Savings confirmations after reopen while excluding older browsing', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const pending = { ...savingsReceive, confirmed: false }
    const first = renderHook(() => useNativePaymentNotifications([pending], scope, false, true, new Set(), d))
    first.unmount()
    const older = { ...savingsReceive, txid: 'older', confirmed: false }
    const excluded = new Set(['savings:older:received'])
    const reopened = renderHook(({ rows }) => useNativePaymentNotifications(rows, scope, false, true, excluded, d), {
      initialProps: { rows: [savingsReceive, older] },
    })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    reopened.rerender({ rows: [savingsReceive, { ...older, confirmed: true }] })
    excluded.clear()
    reopened.rerender({ rows: [savingsReceive, { ...older, confirmed: true }] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('drops a notice across disable and re-enable while registration is pending', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    let resolveRegistration!: (value: ServiceWorkerRegistration) => void
    const registration = new Promise<ServiceWorkerRegistration>((resolve) => {
      resolveRegistration = resolve
    })
    const getRegistration = vi.fn(() => registration)
    const { showNotification, deps: d } = deps({ getRegistration })
    const hook = renderHook(
      ({ rows, enabled }) => useNativePaymentNotifications(rows, scope, false, true, new Set(), { ...d, enabled }),
      {
        initialProps: { rows: [] as VaultHistoryItem[], enabled: true },
      },
    )
    hook.rerender({ rows: [savingsReceive], enabled: true })
    await waitFor(() => expect(getRegistration).toHaveBeenCalledTimes(1))
    hook.rerender({ rows: [savingsReceive], enabled: false })
    hook.rerender({ rows: [savingsReceive], enabled: true })
    await act(async () => {
      resolveRegistration({ showNotification } as unknown as ServiceWorkerRegistration)
      await registration
    })
    expect(showNotification).not.toHaveBeenCalled()
    hook.rerender({ rows: [savingsReceive, { ...savingsReceive, txid: 'later' }], enabled: true })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
  })

  it('discards locked notices when disabled and does not replay disabled-period receipts', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const hook = renderHook(
      ({ rows, enabled, paused }) =>
        useNativePaymentNotifications(rows, scope, paused, true, new Set(), { ...d, enabled }),
      {
        initialProps: { rows: [] as VaultHistoryItem[], enabled: true, paused: true },
      },
    )
    hook.rerender({ rows: [savingsReceive], enabled: true, paused: true })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    hook.rerender({ rows: [savingsReceive], enabled: false, paused: true })
    const rows = [savingsReceive, { ...savingsReceive, txid: 'disabled' }]
    hook.rerender({ rows, enabled: false, paused: true })
    hook.rerender({ rows, enabled: true, paused: false })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(showNotification).not.toHaveBeenCalled()
    hook.rerender({ rows: [...rows, { ...savingsReceive, txid: 'later' }], enabled: true, paused: false })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
  })

  it('seeds a new scope when history and excluded keys retain the same references', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    const { showNotification, deps: d } = deps()
    const rows = [savingsReceive]
    const excluded = new Set<string>()
    const other = { ...scope, vaultId: 'other' }
    const hook = renderHook(({ current }) => useNativePaymentNotifications(rows, current, false, true, excluded, d), {
      initialProps: { current: scope },
    })
    hook.rerender({ current: other })
    expect(loadArrivalBaseline(other).get(paymentIdentityForItem(savingsReceive, other).key)).toBe(true)
    expect(showNotification).not.toHaveBeenCalled()
  })
})
