import { useEffect, useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import { hapticLight } from '../../lib/haptics'
import {
  backgroundPushState,
  disableBackgroundPush,
  enableBackgroundPush,
  reconcilePushState,
} from '../../lib/vault/pushSubscription'
import { needsInstallForPush, requestNativePermission } from '../../lib/vault/nativeNotifications'
import type { VaultStatus } from '../../lib/vault/types'
import { HubGroup, HubRow } from './ui'
import QgScreen from './qg/QgScreen'

function isStandalone(): boolean {
  try {
    if (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches) return true
  } catch {
    // matchMedia unavailable: fall through to the iOS property.
  }
  try {
    return (navigator as unknown as { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

/**
 * Native device notification settings. Ordinary Hub styling, truthful
 * states, and gesture-only permission: nothing here prompts on load or on
 * view open — reconcile is a same-origin list read, and the enable button
 * requests OS permission directly in the click before any network or
 * passkey await consumes the activation.
 */
export default function NativeNotifications({ status, onBack }: { status: VaultStatus | null; onBack: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [subscribed, setSubscribed] = useState(false)
  const [checking, setChecking] = useState(true)
  const scope = status ? `${status.network}:${status.vaultId}` : ''
  const lifecycle = useRef({ scope, generation: 0, mounted: true })
  if (lifecycle.current.scope !== scope)
    lifecycle.current = { scope, generation: lifecycle.current.generation + 1, mounted: true }
  const state = backgroundPushState(status)
  const installRequired = typeof navigator !== 'undefined' && needsInstallForPush(navigator.userAgent, isStandalone())

  useEffect(() => {
    let alive = true
    lifecycle.current.mounted = true
    setChecking(true)
    setSubscribed(false)
    setBusy(false)
    setError('')
    if (!status) {
      setChecking(false)
      return () => {
        alive = false
        lifecycle.current.mounted = false
      }
    }
    void reconcilePushState(status)
      .then((reconciled) => {
        if (alive) setSubscribed(reconciled.subscribed)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not check notifications.')
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
      lifecycle.current.mounted = false
      lifecycle.current.generation += 1
    }
    // Reconcile once per view open, never on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const run = async (action: (isCurrent: () => boolean) => Promise<unknown>, done: string, next: boolean) => {
    if (busy || !status) return
    const generation = lifecycle.current.generation
    const isCurrent = () =>
      lifecycle.current.mounted && lifecycle.current.generation === generation && lifecycle.current.scope === scope
    setBusy(true)
    setError('')
    try {
      await action(isCurrent)
      if (!isCurrent()) return
      setSubscribed(next)
      hapticLight()
      toast(done)
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : 'Notifications are temporarily unavailable.')
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const enableAction = async (isCurrent: () => boolean) => {
    if (!status) return
    // Permission first, directly in the gesture: no network or passkey await
    // may consume the user activation on iPhone.
    const permission = await requestNativePermission()
    if (permission !== 'granted') {
      throw new Error('Allow notifications to get payment alerts on this device.')
    }
    if (!isCurrent()) return
    await enableBackgroundPush(status, isCurrent)
  }

  const disableAction = async () => {
    if (!status) return
    await disableBackgroundPush(status)
  }

  const summary = installRequired
    ? 'Install the app first'
    : !state.capable
      ? 'Not supported in this browser'
      : state.permission === 'denied'
        ? 'Off — enable in system settings'
        : subscribed
          ? 'On'
          : 'Off'
  const actionable =
    !installRequired &&
    state.capable &&
    state.permission !== 'unsupported' &&
    state.permission !== 'denied' &&
    state.vapidConfigured

  const toggleNotifications = () => {
    if (busy || checking) return
    if (subscribed) void run(disableAction, 'Notifications off', false)
    else void run(enableAction, 'Notifications on', true)
  }

  return (
    <QgScreen title='Notifications' back={onBack}>
      <HubGroup label='Payment alerts'>
        <HubRow
          title='Device notifications'
          status={busy ? 'Working…' : checking ? 'Checking…' : summary}
          chevron={false}
          testId='native-notifications-status'
          onClick={actionable ? toggleNotifications : undefined}
          disabled={actionable ? busy || checking : false}
        />
      </HubGroup>
      {installRequired ? (
        <p className='qg-copy'>
          iPhone shows payment alerts only in the installed app. Install Vaulted to your Home Screen, open it, and
          return here to enable.
        </p>
      ) : !state.capable || state.permission === 'unsupported' ? (
        <p className='qg-copy'>
          This browser cannot show device notifications. Payments, history, and recovery work the same without them.
        </p>
      ) : state.permission === 'denied' ? (
        <p className='qg-copy'>
          Notifications are off for Vaulted in your system settings. Turn them on there to get payment alerts.
        </p>
      ) : !state.vapidConfigured ? (
        <p className='qg-copy'>
          Background alerts are not configured for this release yet. Payments, history, and recovery work the same
          without them.
        </p>
      ) : error ? (
        <p className='qg-copy' role='alert' data-testid='native-notifications-error'>
          {error}
        </p>
      ) : null}
    </QgScreen>
  )
}
