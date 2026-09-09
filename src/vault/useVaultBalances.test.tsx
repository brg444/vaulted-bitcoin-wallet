import { lightTestStatus, lightTestEnrollment } from '../lib/vault/light/testdata/helpers'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAddressTxs, fetchAddressUtxos } from '../lib/vault/esplora'
import { pinFromEnrolledStatus, saveAddressPin } from '../lib/vault/pin'
import { fetchVaultStatus, fetchVaultStatusUnpinned } from '../lib/vault/status'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import { defaultSpendingPolicy, spendingPolicyDigest } from '../lib/vault/spendingPolicy'
import {
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
  reviveVaultWalletWorker,
  subscribeVaultWalletEvents,
} from '../lib/vault/vtxo/walletWorker'
import { loadBalanceSnapshot, saveBalanceSnapshot } from '../lib/vault/balanceStore'
import { boardingUtxoBalance, confirmedUtxoBalance, savingsUtxoBalance, useVaultBalances } from './useVaultBalances'

vi.mock('../lib/vault/esplora', () => ({
  fetchAddressTxs: vi.fn(),
  fetchAddressUtxos: vi.fn(),
}))
vi.mock('../lib/vault/status', () => ({ fetchVaultStatus: vi.fn(), fetchVaultStatusUnpinned: vi.fn() }))
vi.mock('../lib/vault/vtxo/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vault/vtxo/spend')>()),
  reconcilePersistedVtxoSpend: vi.fn().mockResolvedValue({ kind: 'none' }),
}))
vi.mock('../lib/vault/vtxo/walletWorker', () => ({
  fetchVaultWalletVtxoSnapshot: vi.fn(),
  reloadVaultWalletWorker: vi.fn().mockResolvedValue(undefined),
  reviveVaultWalletWorker: vi.fn().mockResolvedValue(undefined),
  subscribeVaultWalletEvents: vi.fn().mockReturnValue(() => undefined),
}))

const spendingPolicy = defaultSpendingPolicy()
const STATUS: VaultStatus = {
  enrolled: true,
  network: 'mutinynet',
  clientOrigin: 'https://vault.test',
  rpId: 'vault.test',
  vaultId: 'vault-a',
  templateVersion: 'savings-v1',
  policyVersion: 'policy-v1',
  protectionTier: 'standard',
  savingsAddress: 'tb1psavings',
  savingsScript: '51',
  periodAllowance: 100_000,
  periodSpent: 0,
  periodRemaining: 100_000,
  txCap: 50_000,
  absoluteFeeCap: 5_000,
  feerateCapSatVb: 10,
  spendingPolicy,
  spendingPolicyDigest: spendingPolicyDigest(spendingPolicy),
  vtxoVaultCosignerPub: `02${'11'.repeat(32)}`,
  vtxoExitDelay: 4608,
  vtxoExitDelayUnit: 'seconds',
  spendingArkAddress: 'tark1spending',
  spendingArkScript: `5120${'22'.repeat(32)}`,
  vtxoDelegatePub: `02${'33'.repeat(32)}`,
  vtxoBoardingActive: true,
  vtxoBoardingProgram: 'vault-board-v1',
  vtxoBoardingAddress: 'tb1pboarding',
  vtxoBoardingScript: `5120${'44'.repeat(32)}`,
  vtxoBoardingExitDelay: 604672,
  vtxoBoardingExitDelayUnit: 'seconds',
}

const mockedStatus = vi.mocked(fetchVaultStatus)
const mockedUtxos = vi.mocked(fetchAddressUtxos)
const mockedTxs = vi.mocked(fetchAddressTxs)
const mockedSnapshot = vi.mocked(fetchVaultWalletVtxoSnapshot)
const mockedWorkerReload = vi.mocked(reloadVaultWalletWorker)
const mockedWorkerRevive = vi.mocked(reviveVaultWalletWorker)
const mockedWorkerEvents = vi.mocked(subscribeVaultWalletEvents)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setupHook(
  locked = true,
  status: VaultStatus | null = STATUS,
  initialStatusChecked = true,
  enrollment: EnrollmentSecrets | null = null,
  withPin = true,
  persistPin = true,
) {
  const builtPin = withPin ? pinFromEnrolledStatus(status || STATUS) : null
  const pin = builtPin && persistPin ? saveAddressPin(builtPin) : builtPin
  const setStatus = vi.fn()
  const hook = renderHook(() =>
    useVaultBalances({
      addressPin: pin,
      enrollment,
      initialStatusChecked,
      locked,
      setStatus,
      status,
    }),
  )
  return { ...hook, setStatus }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mockedStatus.mockResolvedValue(STATUS)
  mockedUtxos.mockResolvedValue([])
  mockedTxs.mockResolvedValue([])
  mockedSnapshot.mockResolvedValue({ balance: 0, history: [] })
  mockedWorkerReload.mockResolvedValue(undefined)
  mockedWorkerRevive.mockResolvedValue({} as Awaited<ReturnType<typeof reviveVaultWalletWorker>>)
  mockedWorkerEvents.mockReturnValue(() => undefined)
})

afterEach(() => vi.useRealTimers())

describe('boardingUtxoBalance', () => {
  it('counts unique boarding outputs including unconfirmed deposits', () => {
    expect(
      boardingUtxoBalance([
        { txid: 'a', vout: 0, value: 33_458, status: { confirmed: true } },
        { txid: 'a', vout: 0, value: 33_458, status: { confirmed: true } },
        { txid: 'b', vout: 0, value: 1_000, status: { confirmed: false } },
      ]),
    ).toBe(34_458)
  })
})

describe('confirmedUtxoBalance', () => {
  it('counts unique confirmed and currently unspent Savings outputs', () => {
    const confirmed = { txid: 'a', vout: 0, value: 12_000, status: { confirmed: true } }
    expect(
      confirmedUtxoBalance([confirmed, confirmed, { txid: 'b', vout: 0, value: 8_000, status: { confirmed: false } }]),
    ).toBe(12_000)
  })
})

describe('savingsUtxoBalance', () => {
  it('shows pending wallet-owned change but keeps only confirmed coins spendable', () => {
    const address = 'tb1psavings'
    expect(
      savingsUtxoBalance(
        [
          { txid: 'old-a', vout: 0, value: 47_260, status: { confirmed: true } },
          { txid: 'old-b', vout: 0, value: 32_260, status: { confirmed: true } },
          { txid: 'send', vout: 1, value: 418_100, status: { confirmed: false } },
        ],
        [
          {
            txid: 'send',
            vin: [{ prevout: { scriptpubkey_address: address, value: 519_600 } }],
            vout: [
              { scriptpubkey_address: 'tb1pboarding', value: 100_000 },
              { scriptpubkey_address: address, value: 418_100 },
            ],
            status: { confirmed: false },
          },
        ],
        address,
      ),
    ).toEqual({ total: 497_620, spendable: 79_520 })
  })

  it('does not show an unconfirmed external deposit', () => {
    const address = 'tb1psavings'
    const incoming = { txid: 'incoming', vout: 0, value: 90_000, status: { confirmed: false } }
    expect(
      savingsUtxoBalance(
        [incoming, incoming],
        [
          {
            txid: 'incoming',
            vin: [{ prevout: { scriptpubkey_address: 'tb1psender', value: 90_500 } }],
            vout: [{ scriptpubkey_address: address, value: 90_000 }],
            status: { confirmed: false },
          },
        ],
        address,
      ),
    ).toEqual({ total: 0, spendable: 0 })
  })
})

describe('useVaultBalances', () => {
  it('surfaces the last known snapshot immediately', () => {
    saveBalanceSnapshot(STATUS.vaultId, {
      boardingBalance: 0,
      history: [],
      savingsSats: 9_000,
      savingsSpendableSats: 9_000,
      vtxoSpendingSats: 42_000,
    })
    const { result } = setupHook(true)
    expect(result.current.balancesLoaded).toBe(true)
    expect(result.current.positions.spending.availableSats).toBe(42_000)
    expect(result.current.positions.savings.totalSats).toBe(9_000)
  })

  it('reports fresh snapshot readiness only after a successful refresh', async () => {
    saveBalanceSnapshot(STATUS.vaultId, {
      boardingBalance: 0,
      history: [],
      savingsSats: 9_000,
      savingsSpendableSats: 9_000,
      vtxoSpendingSats: 42_000,
    })
    const { result } = setupHook(true)
    expect(result.current.balancesLoaded).toBe(true)
    expect(result.current.snapshotFresh).toBe(false)
    await act(async () => result.current.refreshBalance())
    expect(result.current.snapshotFresh).toBe(true)
  })

  it('replaces the cached snapshot after a successful refresh', async () => {
    saveBalanceSnapshot(STATUS.vaultId, {
      boardingBalance: 0,
      history: [],
      savingsSats: 0,
      savingsSpendableSats: 0,
      vtxoSpendingSats: 42_000,
    })
    mockedSnapshot.mockResolvedValueOnce({ balance: 50_000, history: [] })
    const { result } = setupHook(true)
    expect(result.current.positions.spending.availableSats).toBe(42_000)
    await act(async () => result.current.refreshBalance())
    expect(result.current.positions.spending.availableSats).toBe(50_000)
    expect(loadBalanceSnapshot(STATUS.vaultId)?.vtxoSpendingSats).toBe(50_000)
  })

  it('takes Spending, boarding balance, and activity only from the persistent SDK worker', async () => {
    mockedSnapshot.mockResolvedValue({
      balance: 30_000,
      boardingBalance: 48_000,
      boardingConfirmedBalance: 48_000,
      history: [
        {
          txid: 'boarding',
          type: 'received',
          amount: 48_000,
          confirmed: true,
          account: 'spend',
          activity: 'boarding',
        },
      ],
    })
    const { result } = setupHook()

    await act(async () => result.current.refreshBalance())

    expect(result.current.positions.spending).toEqual({
      availableSats: 30_000,
      pendingSats: 48_000,
      totalSats: 78_000,
    })
    expect(result.current.history.map((item) => item.txid)).toEqual(['boarding'])
    expect(mockedSnapshot).toHaveBeenCalledWith(STATUS)
  })

  it('replaces pending boarding with the settled snapshot while Esplora still lists the deposit', async () => {
    const deposit = { txid: 'deposit', vout: 0, value: 33_458, status: { confirmed: true } }
    const pending = {
      txid: 'deposit',
      type: 'received' as const,
      amount: 33_458,
      confirmed: false,
      account: 'spend' as const,
      activity: 'boarding' as const,
    }
    const settled = { ...pending, txid: 'commitment', confirmed: true }
    mockedUtxos.mockImplementation(async (address) => (address === STATUS.vtxoBoardingAddress ? [deposit] : []))
    mockedSnapshot.mockResolvedValueOnce({ balance: 0, boardingBalance: 33_458, history: [pending] })
    const { result } = setupHook()
    await act(async () => result.current.refreshBalance())
    expect(result.current.positions.spending.totalSats).toBe(33_458)
    expect(result.current.history).toEqual([pending])

    mockedSnapshot.mockResolvedValueOnce({ balance: 33_458, boardingBalance: 0, history: [settled] })
    await act(async () => result.current.refreshBalance())
    expect(result.current.positions.spending).toEqual({ availableSats: 33_458, pendingSats: 0, totalSats: 33_458 })
    expect(result.current.history).toEqual([settled])
    expect(loadBalanceSnapshot(STATUS.vaultId)?.boardingBalance).toBe(0)
    expect(loadBalanceSnapshot(STATUS.vaultId)?.history).toEqual([settled])

    // A failed read must not reintroduce the stale pending deposit beside
    // the previously observed settled balance, including after a reload.
    mockedSnapshot.mockRejectedValueOnce(new Error('worker unavailable'))
    await act(async () => result.current.refreshBalance())
    expect(result.current.positions.spending).toEqual({ availableSats: 33_458, pendingSats: 0, totalSats: 33_458 })
    expect(result.current.history).toEqual([settled])
    expect(mockedUtxos).not.toHaveBeenCalledWith(STATUS.vtxoBoardingAddress)
  })

  it('ignores an older refresh that finishes after a newer snapshot', async () => {
    const older = deferred<Awaited<ReturnType<typeof fetchAddressUtxos>>>()
    let savingsCalls = 0
    mockedUtxos.mockImplementation((address) => {
      if (address === STATUS.vtxoBoardingAddress) return Promise.resolve([])
      savingsCalls += 1
      if (savingsCalls === 1) return older.promise
      return Promise.resolve([{ txid: 'new', vout: 0, value: 25_000, status: { confirmed: true } }])
    })
    mockedSnapshot
      .mockResolvedValueOnce({ balance: 10_000, history: [] })
      .mockResolvedValueOnce({ balance: 30_000, history: [] })
    const { result } = setupHook()

    let first!: Promise<void>
    await act(async () => {
      first = result.current.refreshBalance()
      await result.current.refreshBalance()
    })
    expect(result.current.positions.spending.availableSats).toBe(30_000)

    await act(async () => {
      older.resolve([{ txid: 'old', vout: 0, value: 5_000, status: { confirmed: true } }])
      await first
    })
    expect(result.current.positions.savings.totalSats).toBe(25_000)
    expect(result.current.positions.spending.availableSats).toBe(30_000)
  })

  it('shows boarding coins from Esplora and revives the Spending worker after a snapshot failure', async () => {
    mockedUtxos.mockImplementation(async (address) => {
      if (address === STATUS.vtxoBoardingAddress) {
        return [{ txid: 'b8ed', vout: 0, value: 33_458, status: { confirmed: true } }]
      }
      if (address === STATUS.savingsAddress) {
        return [{ txid: 'sav', vout: 0, value: 20_000, status: { confirmed: true } }]
      }
      return []
    })
    mockedSnapshot
      .mockRejectedValueOnce(
        new AggregateError([new Error('SDK worker did not register the Spending contract')], 'teardown failed'),
      )
      .mockResolvedValueOnce({
        balance: 0,
        boardingBalance: 33_458,
        history: [
          {
            txid: 'b8ed',
            type: 'received',
            amount: 33_458,
            confirmed: false,
            account: 'spend',
            activity: 'boarding',
          },
        ],
      })
    const { result } = setupHook()
    await act(async () => result.current.refreshBalance())
    expect(result.current.balancesLoaded).toBe(true)
    expect(result.current.positions.savings.totalSats).toBe(20_000)
    expect(result.current.positions.spending).toEqual({
      availableSats: 0,
      pendingSats: 33_458,
      totalSats: 33_458,
    })
    expect(result.current.history.filter((item) => item.txid === 'b8ed')).toEqual([
      {
        txid: 'b8ed',
        type: 'received',
        amount: 33_458,
        confirmed: false,
        account: 'spend',
        activity: 'boarding',
      },
    ])

    await waitFor(() => expect(mockedWorkerRevive).toHaveBeenCalledWith(STATUS))
    expect(result.current.history.filter((item) => item.txid === 'b8ed')).toHaveLength(1)
    expect(result.current.positions.spending.pendingSats).toBe(33_458)
    expect(result.current.balanceError).toBe('')
  })

  it('keeps boarding failure visible with the funds until a successful snapshot clears it', async () => {
    const boardingError = 'Deposit boarding needs attention. Guardian could not complete this attempt.'
    const history = [
      {
        txid: 'boarding',
        type: 'received' as const,
        amount: 30_608,
        confirmed: false,
        account: 'spend' as const,
        activity: 'boarding' as const,
      },
    ]
    mockedSnapshot.mockResolvedValueOnce({ balance: 1_300, boardingBalance: 30_608, boardingError, history })
    const { result } = setupHook()
    await act(async () => result.current.refreshBalance())
    expect(result.current.boardingError).toBe(boardingError)
    expect(result.current.positions.spending).toEqual({ availableSats: 1_300, pendingSats: 30_608, totalSats: 31_908 })
    expect(loadBalanceSnapshot(STATUS.vaultId)?.boardingError).toBe(boardingError)

    mockedSnapshot.mockRejectedValueOnce(new Error('worker unavailable'))
    await act(async () => result.current.refreshBalance())
    expect(result.current.boardingError).toBe(boardingError)
    expect(result.current.positions.spending.totalSats).toBe(31_908)

    mockedSnapshot.mockResolvedValueOnce({ balance: 31_908, boardingBalance: 0, history: [] })
    await act(async () => result.current.refreshBalance())
    expect(result.current.boardingError).toBe('')
    expect(result.current.positions.spending).toEqual({ availableSats: 31_908, pendingSats: 0, totalSats: 31_908 })
    expect(loadBalanceSnapshot(STATUS.vaultId)?.boardingError).toBeUndefined()
  })

  it('keeps the previous account snapshot when a worker read fails', async () => {
    let savingsRound = 0
    mockedUtxos.mockImplementation(async (address) => {
      if (address === STATUS.vtxoBoardingAddress) return []
      savingsRound += 1
      return savingsRound === 1
        ? [{ txid: 'old', vout: 0, value: 20_000, status: { confirmed: true } }]
        : [{ txid: 'new', vout: 0, value: 40_000, status: { confirmed: true } }]
    })
    mockedSnapshot.mockResolvedValueOnce({
      balance: 15_000,
      history: [
        { txid: 'old-spend', type: 'received', amount: 15_000, confirmed: true, blockTime: 1, account: 'spend' },
      ],
    })
    const { result } = setupHook()
    await act(async () => result.current.refreshBalance())

    mockedSnapshot.mockRejectedValueOnce(new Error('activity unavailable'))
    await act(async () => result.current.refreshBalance())

    expect(result.current.positions.savings.totalSats).toBe(40_000)
    expect(result.current.positions.spending.availableSats).toBe(15_000)
    expect(result.current.history.map((item) => item.txid)).toEqual(['old-spend'])
    expect(result.current.balanceError).toBe('')
  })

  it('recovers a cold reload from the persisted enrollment', async () => {
    const enrollment = { vaultId: STATUS.vaultId } as EnrollmentSecrets
    mockedSnapshot.mockResolvedValueOnce({ balance: 12_000, history: [] })
    const { result } = setupHook(false, null, true, enrollment, false)

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledWith(undefined, STATUS.vaultId))
    await waitFor(() => expect(result.current.balancesLoaded).toBe(true))
    expect(result.current.positions.spending.availableSats).toBe(12_000)
  })

  it('subscribes to worker updates and reloads the same worker on focus', async () => {
    const { result } = setupHook(false)
    await waitFor(() => expect(result.current.balancesLoaded).toBe(true))
    expect(mockedWorkerEvents).toHaveBeenCalledWith(STATUS, expect.any(Function))

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(mockedWorkerReload).toHaveBeenCalledWith(STATUS))
  })
})

it('keeps the last known Savings funds when Esplora fails', async () => {
  saveBalanceSnapshot(STATUS.vaultId, {
    boardingBalance: 0,
    history: [],
    savingsSats: 9000,
    savingsSpendableSats: 9000,
    vtxoSpendingSats: 42000,
  })
  mockedUtxos.mockImplementation(async (address) => {
    if (address === STATUS.savingsAddress) throw new Error('Esplora unavailable')
    return []
  })
  mockedSnapshot.mockResolvedValue({ balance: 42000, history: [] })
  const { result } = setupHook(true)
  await act(async () => result.current.refreshBalance())
  expect(result.current.positions.savings.totalSats).toBe(9000)
  expect(loadBalanceSnapshot(STATUS.vaultId)?.savingsSats).toBe(9000)
})

it('refreshes Light Spending from its saved descriptor without a protected Savings pin', async () => {
  const record = await lightTestEnrollment()
  const status = lightTestStatus(record.descriptor) as VaultStatus
  vi.mocked(fetchVaultStatusUnpinned).mockResolvedValue(status)
  mockedSnapshot.mockResolvedValue({ balance: 12000, pendingBalance: 2000, history: [] })
  const { result, setStatus } = setupHook(false, status, true, record.enrollment, false)
  await waitFor(() => expect(result.current.positions.spending.totalSats).toBe(14000))
  expect(setStatus).toHaveBeenCalledWith(status)
  expect(mockedStatus).not.toHaveBeenCalled()
  expect(mockedUtxos).not.toHaveBeenCalled()
  expect(result.current.positions.savings.totalSats).toBe(0)
})

it('rejects changed Light signing facts before reading balances or replacing the session', async () => {
  const record = await lightTestEnrollment()
  const status = lightTestStatus(record.descriptor) as VaultStatus
  vi.mocked(fetchVaultStatusUnpinned).mockResolvedValue({ ...status, spendingArkAddress: 'tark1changed' })
  const { result, setStatus } = setupHook(false, status, true, record.enrollment, false)
  await act(async () => result.current.refreshBalance(status.vaultId))
  expect(result.current.snapshotFresh).toBe(false)
  expect(setStatus).not.toHaveBeenCalled()
  expect(mockedSnapshot).not.toHaveBeenCalled()
  expect(mockedUtxos).not.toHaveBeenCalled()
})
