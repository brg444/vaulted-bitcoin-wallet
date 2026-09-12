import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime, vaultAccountRuntime } from './accountRuntime'
import { vaultRecoveryWatch } from './accountRecoveryWatch'
import { fetchAddressUtxos, type EsploraUtxo } from './esplora'
import { saveLocalKit } from './program/kitStore'
import { loadSeenOutpoints } from './program/watch'
import { ledgerRecoveryFacts } from './recovery/testdata/helpers'
import { sharedSpendingStatus } from './vtxo/testdata/sharedSpending'

vi.mock('./esplora', () => ({ fetchAddressUtxos: vi.fn() }))
const read = vi.mocked(fetchAddressUtxos)
const facts = ledgerRecoveryFacts(true, 'mutinynet')
const coin: EsploraUtxo = { txid: 'ab'.repeat(32), vout: 0, value: 20000, status: { confirmed: true } }
const scope = {
  vaultId: facts.status.vaultId,
  network: facts.kit.descriptor.network,
  descriptorHash: facts.kit.descriptorHash,
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  saveLocalKit(facts.kit)
  read.mockImplementation(async (address) =>
    address === facts.kit.descriptor.pending['savings-phone'].address ? [coin] : [],
  )
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const id of [facts.status.vaultId, sharedSpendingStatus().vaultId]) {
    const account = activeVaultAccountRuntime(id)
    if (account) await disposeVaultAccountRuntime(account)
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('account-owned Ledger recovery observation', () => {
  it('shares one foreground read and alert across two views without starting an SDK wallet', async () => {
    const watch = vaultRecoveryWatch(facts.status)!
    expect(vaultRecoveryWatch(structuredClone(facts.status))).toBe(watch)
    const first = vi.fn(),
      second = vi.fn()
    const leaveFirst = watch.subscribe(first),
      leaveSecond = watch.subscribe(second)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(150)
    expect(read).toHaveBeenCalledTimes(3)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(watch.getSnapshot()).toMatchObject({ familyKey: 'savings-phone', txid: coin.txid })
    const account = vaultAccountRuntime(facts.status)
    expect(account.connection).toBeUndefined()
    expect(account.initialization).toBeUndefined()
    // JSDOM dispatches the durable seen-write's storage event on another timer.
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(1)
    leaveFirst()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(6)
    expect(second).toHaveBeenCalledOnce()
    leaveSecond()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(6)
    expect(vaultRecoveryWatch(facts.status)).toBe(watch)
    expect(watch.getSnapshot()?.txid).toBe(coin.txid)
  })

  it('coalesces clock and focus demand while a pending-address read is slow', async () => {
    let finish!: (coins: EsploraUtxo[]) => void
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const watch = vaultRecoveryWatch(facts.status)!
    const listener = vi.fn()
    watch.subscribe(listener)
    await vi.advanceTimersByTimeAsync(150)
    expect(read).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledOnce()
    finish([coin])
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('suspends hidden observation and resumes through the shared visibility listener', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const watch = vaultRecoveryWatch(facts.status)!
    watch.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(150)
    expect(read).toHaveBeenCalledTimes(3)
    expect(watch.getSnapshot()?.txid).toBe(coin.txid)
  })

  it('aborts an old network read before it can acknowledge or publish recovery evidence', async () => {
    let aborted = false
    read.mockImplementationOnce(
      (_address, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal!.reason)
            },
            { once: true },
          )
        }),
    )
    const old = vaultRecoveryWatch(facts.status)!
    const publishOld = vi.fn()
    old.subscribe(publishOld)
    await vi.advanceTimersByTimeAsync(150)
    const next = ledgerRecoveryFacts(true, 'mainnet')
    saveLocalKit(next.kit)
    const selected = vaultRecoveryWatch(next.status)!
    selected.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(150)
    expect(aborted).toBe(true)
    expect(publishOld).not.toHaveBeenCalled()
    expect(loadSeenOutpoints(scope).size).toBe(0)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('preserves complete seen evidence across reload without replaying an existing outpoint', async () => {
    const watch = vaultRecoveryWatch(facts.status)!
    watch.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(150)
    expect(loadSeenOutpoints(scope).has(`${coin.txid}:0`)).toBe(true)
    await disposeVaultAccountRuntime(vaultAccountRuntime(facts.status))
    const reopened = vaultRecoveryWatch(facts.status)!
    const publish = vi.fn()
    reopened.subscribe(publish)
    await vi.advanceTimersByTimeAsync(150)
    expect(reopened.getSnapshot()).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })

  it('retries a partial observation without advancing seen evidence or blocking another account task', async () => {
    read.mockResolvedValueOnce([coin]).mockRejectedValueOnce(new Error('Pending output unavailable'))
    const watch = vaultRecoveryWatch(facts.status)!
    watch.subscribe(vi.fn())
    const balances = vi.fn().mockResolvedValue(undefined)
    const balanceTask = vaultAccountRuntime(facts.status).maintenance.observe('spending-balance', balances, {
      intervalMs: Infinity,
    })
    balanceTask.request()
    await vi.advanceTimersByTimeAsync(150)
    expect(balances).toHaveBeenCalledOnce()
    expect(loadSeenOutpoints(scope).size).toBe(0)
    expect(watch.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(loadSeenOutpoints(scope).has(`${coin.txid}:0`)).toBe(true)
    expect(watch.getSnapshot()?.txid).toBe(coin.txid)
  })

  it('requires the retained Ledger kit to match live enrollment before observing', () => {
    localStorage.clear()
    expect(vaultRecoveryWatch(facts.status)).toBeUndefined()
    saveLocalKit(facts.kit)
    const changed = structuredClone(facts.status)
    changed.ledgerSavings!.descriptorHash = 'ff'.repeat(32)
    expect(vaultRecoveryWatch(changed)).toBeUndefined()
    expect(vaultRecoveryWatch(sharedSpendingStatus())).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})
