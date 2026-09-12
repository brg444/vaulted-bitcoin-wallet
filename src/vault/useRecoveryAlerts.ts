import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { vaultRecoveryWatch, type VaultRecoveryWatch } from '../lib/vault/accountRecoveryWatch'
import { vaultWalletRuntimeKey } from '../lib/vault/accountRuntime'
import { LEDGER_NATIVE_TEMPLATE } from '../lib/vault/program/ledgerNativeKeys'
import { alertCopy } from '../lib/vault/program/watch'
import type { VaultStatus } from '../lib/vault/types'

/** React consumes account-owned alerts; locking releases observation demand. */
export function useRecoveryAlerts(status: VaultStatus | null, locked: boolean) {
  const current = useRef(status)
  current.current = status
  const scope =
    !locked && status?.enrolled && status.templateVersion === LEDGER_NATIVE_TEMPLATE
      ? JSON.stringify([vaultWalletRuntimeKey(status), status.ledgerSavings?.descriptorHash])
      : ''
  const [owner, setOwner] = useState<VaultRecoveryWatch>()
  useLayoutEffect(() => {
    setOwner(scope && current.current ? vaultRecoveryWatch(current.current) : undefined)
  }, [scope])
  const subscribe = useCallback((listener: () => void) => owner?.subscribe(listener) || (() => {}), [owner])
  const getSnapshot = useCallback(() => owner?.getSnapshot() || null, [owner])
  const alert = useSyncExternalStore(subscribe, getSnapshot)
  return alert ? alertCopy(alert) : ''
}
