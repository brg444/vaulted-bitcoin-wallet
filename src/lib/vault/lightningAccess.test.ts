import { ArkAddress, RestArkProvider, SingleKey, type Identity } from '@arkade-os/sdk'
import { type arkadeRefunder, type RfqSwapManager } from '@arkade-os/swap'
import { hex } from '@scure/base'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withVaultLightningSdkWallet } from './lightning'
import { sharedSpendingStatusForNetwork } from './vtxo/testdata/sharedSpending'

const boundary = vi.hoisted(() => ({ state: vi.fn(), maintain: vi.fn(), refunder: vi.fn(), refund: vi.fn() }))
vi.mock('./vtxo/walletWorker', () => ({ withVaultWalletState: boundary.state, withActiveVaultWalletState: vi.fn() }))
vi.mock('./lightningLifecycle', async (original) => ({
  ...(await original<typeof import('./lightningLifecycle')>()),
  maintainVaultLightningObserver: boundary.maintain,
}))
vi.mock('@arkade-os/swap', async (original) => ({
  ...(await original<typeof import('@arkade-os/swap')>()),
  arkadeRefunder: boundary.refunder,
}))

const phone = hex.decode('03'.padStart(64, '0'))
const status = sharedSpendingStatusForNetwork('mutinynet', { phoneSecret: phone })
const info = {
  network: 'mutinynet',
  signerPubkey: hex.encode(ArkAddress.decode(status.spendingArkAddress!).serverPubKey),
} as Awaited<ReturnType<RestArkProvider['getInfo']>>
const rfqId = 'ab'.repeat(32)
const manager = {
  getPendingSwaps: vi.fn(async () => []),
  removeSwap: vi.fn(),
  restoreFromRepository: vi.fn(async () => ({ restored: [], failed: [] })),
  poll: vi.fn(async () => {}),
  setCallbacks: vi.fn<(callbacks: Parameters<RfqSwapManager['setCallbacks']>[0]) => void>(),
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  manager.poll.mockImplementation(async () => {})
  boundary.state.mockImplementation(async (_status, run) =>
    run({ contracts: {}, swapRepository: {}, swapManager: manager }),
  )
  boundary.maintain.mockResolvedValue(undefined)
  boundary.refunder.mockReturnValue(boundary.refund)
  vi.spyOn(RestArkProvider.prototype, 'getInfo').mockResolvedValue(info)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, run: (lock: unknown) => Promise<unknown>) => run({}) },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'locks')
})

it('refuses canceled Lightning access before any Operator read or account acquisition', async () => {
  const abort = new AbortController()
  abort.abort(new Error('approval canceled'))
  const run = vi.fn()
  await expect(withVaultLightningSdkWallet(phone, status, run, { signal: abort.signal })).rejects.toThrow(
    'approval canceled',
  )
  expect(RestArkProvider.prototype.getInfo).not.toHaveBeenCalled()
  expect(boundary.state).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it('drains a delayed Operator response without acquiring a signer session after cancellation', async () => {
  const gate = deferred()
  vi.mocked(RestArkProvider.prototype.getInfo).mockImplementation(async () => {
    await gate.promise
    return info
  })
  const abort = new AbortController()
  const run = vi.fn()
  const result = withVaultLightningSdkWallet(phone, status, run, { signal: abort.signal })
  const rejected = expect(result).rejects.toThrow('approval canceled')
  await vi.waitFor(() => expect(RestArkProvider.prototype.getInfo).toHaveBeenCalledOnce())
  abort.abort(new Error('approval canceled'))
  gate.resolve()
  await rejected
  expect(boundary.state).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it.each(['completed', 'canceled'] as const)('revokes retained signer capabilities when approval is %s', async (end) => {
  const abort = new AbortController()
  let identity!: Identity
  let tree!: ReturnType<Identity['signerSession']>
  const sign = vi.spyOn(SingleKey.prototype, 'signMessage')
  await withVaultLightningSdkWallet(
    phone,
    status,
    async (session) => {
      identity = session.wallet.identity
      tree = identity.signerSession()
      expect(await tree.getPublicKey()).toHaveLength(33)
      expect(await identity.signMessage(new Uint8Array(32), 'schnorr')).toHaveLength(64)
      if (end === 'canceled') abort.abort(new Error('approval canceled'))
    },
    { signal: abort.signal },
  )
  expect(() => identity.signMessage(new Uint8Array(32), 'schnorr')).toThrow()
  expect(() => identity.signerSession()).toThrow()
  expect(() => tree.sign()).toThrow()
  expect(sign).toHaveBeenCalledOnce()
})

it.each(['before signing', 'before Operator submission'] as const)(
  'revokes the temporary refund capability %s and restores the observer callbacks',
  async (phase) => {
    const gate = deferred()
    const abort = new AbortController()
    const sign = vi.spyOn(SingleKey.prototype, 'signMessage')
    const submit = vi.spyOn(RestArkProvider.prototype, 'submitTx').mockResolvedValue({} as never)
    boundary.refund.mockImplementation(async () => {
      const { wallet, ark } = boundary.refunder.mock.calls[0][0] as Parameters<typeof arkadeRefunder>[0]
      if (phase === 'before signing') await gate.promise
      await wallet.identity.signMessage(new Uint8Array(32), 'schnorr')
      if (phase === 'before Operator submission') await gate.promise
      return ark.submitTx('', [])
    })
    manager.poll.mockImplementation(async () => {
      const callbacks = manager.setCallbacks.mock.calls.at(-1)?.[0]
      if (callbacks) await callbacks.refundArkade({ rfqId, refundLocktime: 0 } as never)
    })
    const run = vi.fn()
    const result = withVaultLightningSdkWallet(phone, status, run, { refundRfqId: rfqId, signal: abort.signal })
    const rejected = expect(result).rejects.toThrow('approval canceled')
    await vi.waitFor(() => expect(boundary.refund).toHaveBeenCalledOnce())
    if (phase === 'before Operator submission') await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce())
    abort.abort(new Error('approval canceled'))
    gate.resolve()
    await rejected
    expect(submit).not.toHaveBeenCalled()
    expect(sign).toHaveBeenCalledTimes(phase === 'before signing' ? 0 : 1)
    expect(run).not.toHaveBeenCalled()
    expect(manager.setCallbacks).toHaveBeenCalledTimes(2)
    await expect(
      manager.setCallbacks.mock.calls[1][0].refundArkade({ rfqId, refundLocktime: 0 } as never),
    ).rejects.toThrow('Approve with passkey')
  },
)
