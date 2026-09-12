import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createVaultBalanceController, type VaultBalancesOptions } from '../lib/vault/accountBalances'

/** React binds the session to the controller and consumes its published snapshot. */
export function useVaultBalances(options: VaultBalancesOptions) {
  const controllerRef = useRef<ReturnType<typeof createVaultBalanceController>>()
  const controller = controllerRef.current || (controllerRef.current = createVaultBalanceController(options))
  useLayoutEffect(() => controller.update(options))
  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { ...snapshot, refreshBalance: controller.refreshBalance, loadOlderActivity: controller.loadOlderActivity }
}
