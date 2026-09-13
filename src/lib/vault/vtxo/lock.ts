export const VAULT_CONCURRENCY_CAPABILITY_CODE = 'VAULT_CONCURRENCY_UNAVAILABLE'

export class VaultConcurrencyUnavailableError extends Error {
  readonly code = VAULT_CONCURRENCY_CAPABILITY_CODE

  constructor() {
    super('Secure wallet coordination requires the Web Locks API')
    this.name = 'VaultConcurrencyUnavailableError'
  }
}

export interface VaultLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

export function browserVaultLockManager(): VaultLockManager | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return undefined
  return navigator.locks as unknown as VaultLockManager
}

export function requireVaultLockManager(locks: VaultLockManager | null | undefined): VaultLockManager {
  if (!locks) throw new VaultConcurrencyUnavailableError()
  return locks
}

export function isVaultConcurrencyUnavailableError(err: unknown): err is VaultConcurrencyUnavailableError {
  return (
    err instanceof VaultConcurrencyUnavailableError ||
    (typeof err === 'object' && err !== null && 'code' in err && err.code === VAULT_CONCURRENCY_CAPABILITY_CODE)
  )
}

export async function withVtxoSendLock<T>(
  vaultId: string,
  run: () => Promise<T>,
  locks: VaultLockManager | null | undefined = browserVaultLockManager(),
): Promise<T> {
  return requireVaultLockManager(locks).request(
    `arkade-vault-vtxo-send:${vaultId}`,
    { mode: 'exclusive' },
    async (lock) => {
      if (!lock) throw new Error('Web Locks API returned no exclusive send lock')
      return run()
    },
  )
}
