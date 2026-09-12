import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createVaultSession, type VaultSession, type SessionOutcome } from '../lib/vault/session'
import type { VaultScreen } from './context'

/** The binding owns no account state; session transitions select presentation destinations. */
export function useVaultSession() {
  const owner = useRef<VaultSession>()
  if (!owner.current) owner.current = createVaultSession()
  const session = owner.current
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  useEffect(() => session.retain(), [session])
  return { session, ...snapshot }
}

const destinations: Record<SessionOutcome, VaultScreen> = {
  authenticated: 'home',
  'unlock-required': 'unlock',
  'signin-required': 'signin',
  'signed-out': 'welcome',
  'hardware-required': 'hardware',
  'recovery-required': 'recovery',
  'conditions-required': 'conditions',
  'passkey-required': 'passkey',
  'registration-required': 'ledger-register',
  enrolling: 'creating',
  created: 'created',
  'setup-failed': 'problem',
}
export const sessionScreen = (outcome: SessionOutcome) => destinations[outcome]
