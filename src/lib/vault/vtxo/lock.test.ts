import { describe, expect, it, vi } from 'vitest'
import { VaultConcurrencyUnavailableError, withVtxoSendLock, type VaultLockManager } from './lock'

class DeterministicLockManager implements VaultLockManager {
  private readonly held = new Set<string>()
  private readonly waiters = new Map<string, (() => void)[]>()

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    if (this.held.has(name) && options.ifAvailable) return callback(null)
    while (this.held.has(name)) {
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(name) || []
        waiters.push(resolve)
        this.waiters.set(name, waiters)
      })
    }
    this.held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
      this.waiters.get(name)?.shift()?.()
    }
  }
}

describe('wallet Web Lock boundary', () => {
  it('fails closed for ordinary sends when Web Locks are unavailable', async () => {
    const sending = vi.fn(async () => 'sent')

    await expect(withVtxoSendLock('vault-a', sending, null)).rejects.toBeInstanceOf(VaultConcurrencyUnavailableError)
    expect(sending).not.toHaveBeenCalled()
  })

  it('serializes ordinary sends across two contexts', async () => {
    const locks = new DeterministicLockManager()
    const order: string[] = []
    let release!: () => void
    const first = withVtxoSendLock(
      'vault-a',
      async () => {
        order.push('first-start')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        order.push('first-end')
        return 'first'
      },
      locks,
    )
    await Promise.resolve()
    const second = withVtxoSendLock(
      'vault-a',
      async () => {
        order.push('second-start')
        return 'second'
      },
      locks,
    )
    await Promise.resolve()
    expect(order).toEqual(['first-start'])

    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
})
