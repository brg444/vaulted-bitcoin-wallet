import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../components/Toast'
import NativeNotifications from './NativeNotifications'
import type { VaultStatus } from '../../lib/vault/types'

vi.mock('../../lib/vault/pushSubscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/vault/pushSubscription')>()
  return {
    ...actual,
    reconcilePushState: vi.fn().mockResolvedValue({ subscribed: false, expiresAt: null }),
    enableBackgroundPush: vi.fn(),
    disableBackgroundPush: vi.fn().mockResolvedValue(undefined),
  }
})

import { disableBackgroundPush, enableBackgroundPush, reconcilePushState } from '../../lib/vault/pushSubscription'

const status = { network: 'mainnet', vaultId: 'vault-1' } as VaultStatus
const VAPID = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url')

function renderView() {
  render(
    <ToastProvider>
      <NativeNotifications status={status} onBack={() => undefined} />
    </ToastProvider>,
  )
}

describe('native notification settings', () => {
  beforeEach(() => {
    ;(reconcilePushState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ subscribed: false, expiresAt: null })
    ;(enableBackgroundPush as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ subHandle: 'ab'.repeat(32), expiresAt: Date.now() + 1000 })
    ;(disableBackgroundPush as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    localStorage.clear()
  })

  it('never prompts on open and reconciles instead', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    renderView()
    await waitFor(() => expect(reconcilePushState).toHaveBeenCalled())
    expect(requestPermission).not.toHaveBeenCalled()
    expect(screen.getByTestId('native-notifications-status')).toBeVisible()
  })

  it('requests permission in the gesture before any network or enrollment await', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    vi.stubGlobal('navigator', { userAgent: 'desktop', serviceWorker: {} })
    vi.stubGlobal('PushManager', function () {})
    ;(enableBackgroundPush as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ subHandle: 'ab'.repeat(32), expiresAt: Date.now() + 1000 })
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    // Permission first: enable follows only after the gesture resolves it.
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(enableBackgroundPush).toHaveBeenCalledWith(status, expect.any(Function)))
  })

  it('shows truthful denied and unsupported states', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    vi.stubGlobal('Notification', { permission: 'denied' })
    vi.stubGlobal('navigator', { userAgent: 'desktop', serviceWorker: {} })
    vi.stubGlobal('PushManager', function () {})
    renderView()
    await waitFor(() => expect(screen.getByText(/system settings/)).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
  })

  it('shows install guidance in an ordinary iPhone tab', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    vi.stubGlobal('Notification', { permission: 'default' })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', serviceWorker: {} })
    vi.stubGlobal('PushManager', function () {})
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true })
    renderView()
    await waitFor(() => expect(screen.getByText(/Home Screen/)).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
  })

  it('guides absent-API iPhone tabs to the Home Screen app instead of a dead end', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    // No Notification, PushManager, or serviceWorker stubs: an ordinary
    // iPhone Chrome tab commonly lacks all three.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true })
    renderView()
    await waitFor(() => expect(screen.getByText(/Home Screen/)).toBeVisible())
    expect(screen.queryByText(/cannot show device notifications/)).toBeNull()
  })

  it('offers enable in the installed supported app', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    vi.stubGlobal('Notification', { permission: 'default' })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', serviceWorker: {} })
    vi.stubGlobal('PushManager', function () {})
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }), configurable: true })
    renderView()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on' })).toBeVisible())
  })

  it('turns off through an ordinary control', async () => {
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', VAPID)
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('navigator', { userAgent: 'desktop', serviceWorker: {} })
    vi.stubGlobal('PushManager', function () {})
    localStorage.setItem('vaulted:push:v1:mainnet:vault-1', JSON.stringify({ subHandle: 'ab'.repeat(32), expiresAt: Date.now() + 100000 }))
    ;(reconcilePushState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ subscribed: true, expiresAt: Date.now() + 100000 })
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(disableBackgroundPush).toHaveBeenCalledWith(status))
  })
})
