import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendSpendingToBitcoin } from './spendingBitcoinFunding'
import { BitcoinPaymentError } from './bitcoinPaymentError'
import { guardianRenewalContext, guardianRenewalContextDigest } from './vtxo/renewalContext'
import { readSpendingBitcoin } from './spendingBitcoinStore'
import { sharedSpendingEnrollment, sharedSpendingStatus } from './vtxo/testdata/sharedSpending'

const unlockMock = vi.hoisted(() => ({ current: null as null | (() => Promise<unknown>) }))
vi.mock('./vtxo/spend', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./vtxo/spend')>()
  return {
    ...mod,
    createVtxoSpendUnlocker: () => ({
      unlock: () => unlockMock.current!(),
      dispose: vi.fn(),
    }),
  }
})
vi.mock('./vtxo/lock', () => ({
  withVtxoSendLock: (_vaultId: string, run: () => Promise<unknown>) => run(),
}))
const contractsMock = vi.hoisted(() => ({ refresh: null as null | (() => Promise<void>), vtxos: [] as unknown[] }))
vi.mock('./vtxo/walletWorker', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./vtxo/walletWorker')>()
  return {
    ...mod,
    withVaultWalletState: async (_status: unknown, run: (value: object) => Promise<unknown>) =>
      run({
        contracts: {
          refreshVtxos: () => contractsMock.refresh!(),
          getContractsWithVtxos: async () => [{ vtxos: contractsMock.vtxos }],
        },
      }),
  }
})

const status = sharedSpendingStatus()
const enrollment = sharedSpendingEnrollment()
const context = guardianRenewalContext(status)
const OUTPUT = { script: `0014${'22'.repeat(20)}`, amountSats: 30000 }
const COIN = {
  txid: 'ab'.repeat(32),
  vout: 0,
  script: context.scriptPubKey,
  value: 100000,
  isSpent: false,
  isSwept: false,
  isUnrolled: false,
  assets: [],
  commitmentTxIds: ['00'.repeat(32)],
  expiresAt: new Date(Date.now() + 3600_000),
}
const AUTH = {
  phoneSecret: new Uint8Array(32).fill(7),
  scalar: new Uint8Array(32).fill(9),
  assertion: { credentialId: 'aa', clientDataJSON: 'bb', authenticatorData: 'cc', signature: 'dd' },
}

const json = (body: unknown, code = 200) =>
  ({
    ok: code >= 200 && code < 300,
    status: code,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  }) as Response

function routeFetch(handlers: { prepare?: (url: string) => Response | Promise<Response>; status?: () => Response }) {
  return vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.includes('/v1/vtxo/bitcoin/info'))
      return json({ version: 1, maxInputs: 1, descriptorHash: guardianRenewalContextDigest(status) })
    if (target.endsWith('/prepare'))
      return handlers.prepare ? handlers.prepare(target) : json({ error: 'x', code: 'REJECTED' }, 400)
    if (target.endsWith('/status')) return handlers.status ? handlers.status() : json({ state: 'not_found' })
    throw new Error(`unexpected request ${target}`)
  })
}

const rejected400 = () => json({ error: 'Guardian rejected: input already reserved', code: 'REJECTED' }, 400)

describe('spending-to-bitcoin prepare rejection', () => {
  beforeEach(() => {
    localStorage.clear()
    contractsMock.vtxos = [COIN]
    contractsMock.refresh = async () => {}
    unlockMock.current = async () => AUTH
    vi.stubGlobal('fetch', routeFetch({ prepare: rejected400 }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clears a definitively rejected draft and reports not_sent with the Guardian reason', async () => {
    const approve = vi.fn()
    const progress = vi.fn()
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], approve, progress).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
    expect(failure.message).toMatch(/not sent/i)
    expect(failure.details).toContain('input already reserved')
    expect(approve).not.toHaveBeenCalled()
    // Nothing reserved server-side: no stuck draft blocks the next attempt.
    expect(readSpendingBitcoin(status)).toBeNull()
    const retry = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], approve, progress).catch((e) => e)
    expect(retry).toBeInstanceOf(BitcoinPaymentError)
    expect(retry.outcome).toBe('not_sent')
    expect(String(retry.message)).not.toMatch(/pending Bitcoin payment/)
  })

  it('routes an active-operation rejection to the existing payment', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        prepare: () =>
          json(
            {
              error: 'another Spending payment is still active; finish or cancel it before starting a new one',
              code: 'REJECTED',
            },
            400,
          ),
      }),
    )
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
    expect(failure.message).toMatch(/still active|Recent/i)
    expect(readSpendingBitcoin(status)).toBeNull()
  })

  it('keeps the journal pending on a transport 404, which proves no operation absence', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        prepare: rejected400,
        status: () => json({ error: 'not found', code: '' }, 404),
      }),
    )
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('pending')
    expect(readSpendingBitcoin(status)?.stage).toBe('preparing')
  })

  it('keeps the journal pending when the operation exists despite the error', async () => {
    vi.stubGlobal('fetch', routeFetch({ prepare: rejected400, status: () => json({ state: 'prepared' }) }))
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('pending')
    expect(readSpendingBitcoin(status)?.stage).toBe('preparing')
  })

  it('keeps the journal pending when the status lookup is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        prepare: rejected400,
        status: () => {
          throw new Error('offline')
        },
      }),
    )
    // fetch mock throws: vaultRequest propagates before any status body.
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('pending')
    expect(readSpendingBitcoin(status)?.stage).toBe('preparing')
  })

  it('keeps the journal pending for non-rejection prepare failures', async () => {
    vi.stubGlobal('fetch', routeFetch({ prepare: () => json({ error: 'boom' }, 500) }))
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('pending')
    expect(readSpendingBitcoin(status)?.stage).toBe('preparing')
  })

  it('maps fee rejections to the fee review copy', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ prepare: () => json({ error: 'fee below minimum relay fee', code: 'REJECTED' }, 400) }),
    )
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
    expect(failure.message).toMatch(/fee/i)
    expect(readSpendingBitcoin(status)).toBeNull()
  })
})

describe('spending-to-bitcoin passkey context', () => {
  beforeEach(() => {
    localStorage.clear()
    contractsMock.vtxos = [COIN]
    contractsMock.refresh = async () => {}
    vi.stubGlobal('fetch', routeFetch({}))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports cancellation as retryable without retaining a draft', async () => {
    unlockMock.current = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
    expect(failure.message).toMatch(/cancelled|passkey/i)
    expect(readSpendingBitcoin(status)).toBeNull()
  })

  it('reports a platform context refusal as retryable without retaining a draft', async () => {
    unlockMock.current = async () => {
      throw new DOMException(
        'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
        'NotAllowedError',
      )
    }
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
    expect(failure.message).toMatch(/passkey|page open/i)
    expect(readSpendingBitcoin(status)).toBeNull()
  })

  it('lets unexpected ceremony bugs propagate loudly', async () => {
    unlockMock.current = async () => {
      throw new Error('deployment RP ID does not match this signing client host')
    }
    const failure = await sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), vi.fn()).catch((e) => e)
    expect(failure).not.toBeInstanceOf(BitcoinPaymentError)
    expect(String(failure?.message)).toMatch(/RP ID/)
  })

  it('waits out a slow refresh, then requests the credential once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    contractsMock.refresh = () => gate
    const unlock = vi.fn(async () => AUTH)
    unlockMock.current = unlock
    const progress = vi.fn()
    const pending = sendSpendingToBitcoin(enrollment, status, [OUTPUT], vi.fn(), progress).catch((e) => e)
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('Checking funds for this Bitcoin payment'))
    expect(unlock).not.toHaveBeenCalled()
    release()
    const failure = await pending
    expect(unlock).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith('Unlock Spending with your passkey')
    expect(failure).toBeInstanceOf(BitcoinPaymentError)
    expect(failure.outcome).toBe('not_sent')
  })
})
