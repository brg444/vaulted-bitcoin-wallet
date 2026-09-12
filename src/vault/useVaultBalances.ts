import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  vaultBalanceController,
  EMPTY_BALANCE_VIEW,
  type VaultBalanceController,
  type VaultBalancesOptions,
} from '../lib/vault/accountBalances'

/** Session inputs bind the account-owned controller; React consumes its snapshots. */
export function useVaultBalances(options: VaultBalancesOptions) {
  const [controller, setController] = useState<VaultBalanceController>()
  const binding = useRef<{ controller: VaultBalanceController; release: () => void }>()
  useLayoutEffect(() => {
    const selected = vaultBalanceController(options)
    if (binding.current?.controller !== selected) {
      binding.current?.release()
      binding.current = selected ? { controller: selected, release: selected.retain() } : undefined
      setController(selected)
    }
    selected?.update(options)
  })
  useLayoutEffect(
    () => () => {
      binding.current?.release()
      binding.current = undefined
    },
    [],
  )
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) || (() => {}), [controller])
  const getSnapshot = useCallback(() => controller?.getSnapshot() || EMPTY_BALANCE_VIEW, [controller])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const refreshBalance = useCallback(
    (id?: string) => binding.current?.controller.refreshBalance(id) || Promise.resolve(),
    [],
  )
  const loadOlderActivity = useCallback(
    () => binding.current?.controller.loadOlderActivity() || Promise.resolve({ added: 0, exhausted: false }),
    [],
  )
  return { ...snapshot, refreshBalance, loadOlderActivity }
}
