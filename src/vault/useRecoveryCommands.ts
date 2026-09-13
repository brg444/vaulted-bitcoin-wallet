import { useEffect, useSyncExternalStore } from 'react'
import { recoveryCommandsForSession } from '../lib/vault/recoveryCommands'
import type { VaultSession } from '../lib/vault/session'

export function useRecoveryCommands(session: Pick<VaultSession, 'getSnapshot' | 'subscribe'>) {
  const commands = recoveryCommandsForSession(session)
  const snapshot = useSyncExternalStore(commands.subscribe, commands.getSnapshot)
  useEffect(() => commands.retain(), [commands])
  return { commands, ...snapshot }
}
