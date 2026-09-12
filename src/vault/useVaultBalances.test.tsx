import {
  sharedSpendingStatus,
  sharedSpendingEnrollment,
  sharedSpendingStatusForNetwork,
} from '../lib/vault/vtxo/testdata/sharedSpending'
import { activeVaultAccountRuntime, disposeVaultAccountRuntime, vaultAccountRuntime } from '../lib/vault/accountRuntime'
import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAddressTxs, fetchAddressUtxos, fetchOlderAddressTxs } from '../lib/vault/esplora'
import { pinFromEnrolledStatus, saveAddressPin, loadAddressPin } from '../lib/vault/pin'
import { fetchVaultStatus, fetchVaultStatusUnpinned } from '../lib/vault/status'
import type { EnrollmentSecrets } from '../lib/vault/tenantEnrollment'
import type { VaultStatus } from '../lib/vault/types'
import {
  fetchVaultWalletVtxoSnapshot,
  reloadVaultWalletWorker,
  reviveVaultWalletWorker,
  subscribeVaultWalletEvents,
} from '../lib/vault/vtxo/walletWorker'
import { loadBalanceSnapshot, saveBalanceSnapshot } from '../lib/vault/balanceStore'
import {
  vaultBalanceController,
  type VaultBalanceController,
  type VaultBalancesOptions,
  boardingUtxoBalance,
  confirmedUtxoBalance,
  oldestSavingsTxid,
  retainOlderRows,
  savingsUtxoBalance,
} from '../lib/vault/accountBalances'
import { useVaultBalances } from './useVaultBalances'

vi.mock('../lib/vault/esplora', () => ({
  fetchAddressTxs: vi.fn(),
  fetchAddressUtxos: vi.fn(),
  fetchOlderAddressTxs: vi.fn(),
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

const STATUS = sharedSpendingStatusForNetwork('mutinynet', { vaultId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
const SAVINGS_ADDRESS = 'tb1psavings'

const mockedStatus = vi.mocked(fetchVaultStatus)
const mockedUtxos = vi.mocked(fetchAddressUtxos)
const mockedTxs = vi.mocked(fetchAddressTxs)
const mockedOlderTxs = vi.mocked(fetchOlderAddressTxs)
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
      watchedSavingsAddress: status?.vaultId === STATUS.vaultId || !status ? SAVINGS_ADDRESS : '',
      addressPin: pin,
      enrollment,
      initialStatusChecked: !locked && initialStatusChecked,
      locked: false,
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
  mockedOlderTxs.mockResolvedValue({ transactions: [], exhausted: true })
  mockedSnapshot.mockResolvedValue({ balance: 0, history: [] })
  mockedWorkerReload.mockResolvedValue(undefined)
  mockedWorkerRevive.mockResolvedValue({} as Awaited<ReturnType<typeof reviveVaultWalletWorker>>)
  mockedWorkerEvents.mockReturnValue(() => undefined)
})

const controllers = new Set<VaultBalanceController>()
afterEach(async () => {
  for (const controller of controllers) controller.dispose()
  controllers.clear()
  for (const id of [STATUS.vaultId, sharedSpendingStatus().vaultId, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']) {
    const account = activeVaultAccountRuntime(id)
    if (account) await disposeVaultAccountRuntime(account)
  }
  vi.useRealTimers()
})

function controllerOptions(overrides: Partial<VaultBalancesOptions> = {}): VaultBalancesOptions {
  return {
    status: STATUS,
    addressPin: pinFromEnrolledStatus(STATUS),
    enrollment: null,
    watchedSavingsAddress: SAVINGS_ADDRESS,
    initialStatusChecked: false,
    locked: false,
    setStatus: vi.fn(),
    ...overrides,
  }
}
function standaloneController(options = controllerOptions()) {
  const controller = vaultBalanceController(options)!
  controllers.add(controller)
  return controller
}

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
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
      watchedSavingsAddress: SAVINGS_ADDRESS,
      boardingBalance: 0,
      history: [],
      savingsSats: 9_000,
      savingsSpendableSats: 9_000,
      vtxoSpendingSats: 42_000,
    })
    const { result } = setupHook(true)
    expect(result.current.accountReads.spend.loaded).toBe(true)
    expect(result.current.positions.spending.availableSats).toBe(42_000)
    expect(result.current.positions.savings.totalSats).toBe(9_000)
  })

  it('reports fresh snapshot readiness only after a successful refresh', async () => {
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
      watchedSavingsAddress: SAVINGS_ADDRESS,
      boardingBalance: 0,
      history: [],
      savingsSats: 9_000,
      savingsSpendableSats: 9_000,
      vtxoSpendingSats: 42_000,
    })
    const { result } = setupHook(true)
    expect(result.current.accountReads.spend.loaded).toBe(true)
    expect(result.current.snapshotFresh).toBe(false)
    await act(async () => result.current.refreshBalance())
    expect(result.current.snapshotFresh).toBe(true)
  })

  it('withholds fresh readiness until every source settles', async () => {
    let resolveSavings!: (value: Awaited<ReturnType<typeof fetchAddressTxs>>) => void
    mockedTxs.mockImplementation(
      (address: string) =>
        new Promise<Awaited<ReturnType<typeof fetchAddressTxs>>>((resolve) => {
          if (address === 'tb1psavings') resolveSavings = resolve
          else resolve([])
        }),
    )
    mockedSnapshot.mockResolvedValue({ balance: 0, history: [] })
    const { result } = setupHook(false)
    await waitFor(() => expect(mockedSnapshot).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    // Spending settled but Savings is still pending: no fresh baseline yet,
    // so arrival observation cannot treat a partial snapshot as complete.
    expect(result.current.snapshotFresh).toBe(false)
    expect(result.current.history).toEqual([])
    await act(async () => {
      resolveSavings([
        {
          txid: 'recent-s',
          vin: [],
          vout: [{ scriptpubkey_address: 'tb1psavings', value: 9_000 }],
          status: { confirmed: true, block_time: 200 },
        },
      ])
    })
    await waitFor(() => expect(result.current.snapshotFresh).toBe(true))
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-s'])
  })

  it('appends one older Savings window without touching balances', async () => {
    mockedUtxos.mockResolvedValue([{ txid: 'recent', vout: 0, value: 9_000, status: { confirmed: true } }])
    mockedTxs.mockResolvedValue([
      {
        txid: 'recent',
        vin: [],
        vout: [{ scriptpubkey_address: 'tb1psavings', value: 9_000 }],
        status: { confirmed: true, block_time: 200 },
      },
    ])
    mockedOlderTxs.mockResolvedValue({
      transactions: [
        {
          txid: 'older',
          vin: [],
          vout: [{ scriptpubkey_address: 'tb1psavings', value: 5_000 }],
          status: { confirmed: true, block_time: 100 },
        },
      ],
      exhausted: false,
    })
    const { result } = setupHook(false)
    await waitFor(() => expect(result.current.history.map((item) => item.txid)).toEqual(['recent']))
    expect(result.current.olderActivity.status).toBe('idle')
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      outcome = await result.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 1, exhausted: false })
    expect(mockedOlderTxs).toHaveBeenCalledWith('tb1psavings', 'recent')
    expect(result.current.history.map((item) => item.txid).sort()).toEqual(['older', 'recent'])
    expect(result.current.positions.savings.totalSats).toBe(9_000)
    expect(result.current.olderActivity.status).toBe('idle')
    expect(result.current.olderHistory.map((item) => item.txid)).toEqual(['older'])
  })

  it('reports exhaustion when no older Savings reference exists', async () => {
    const { result } = setupHook(true)
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      outcome = await result.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 0, exhausted: true })
    expect(mockedOlderTxs).not.toHaveBeenCalled()
    expect(result.current.olderActivity.status).toBe('exhausted')
  })

  it('keeps loaded history when the older window fails', async () => {
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
      watchedSavingsAddress: SAVINGS_ADDRESS,
      boardingBalance: 0,
      history: [
        { txid: 'recent', type: 'received', amount: 9_000, confirmed: true, blockTime: 200, account: 'savings' },
      ],
      savingsSats: 9_000,
      savingsSpendableSats: 9_000,
      vtxoSpendingSats: 0,
    })
    mockedOlderTxs.mockRejectedValue(new Error('offline'))
    const { result } = setupHook(true)
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      outcome = await result.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent'])
    expect(result.current.olderActivity.status).toBe('error')
  })

  it('derives the paging cursor from confirmed chain order only', () => {
    expect(
      oldestSavingsTxid([
        { txid: 'mempool', type: 'received', amount: 1, confirmed: false, account: 'savings' },
        { txid: 'change', type: 'sent', amount: 1, confirmed: false, account: 'savings' },
      ]),
    ).toBe('')
    expect(
      oldestSavingsTxid([
        { txid: 'newer', type: 'received', amount: 1, confirmed: true, blockTime: 200, account: 'savings' },
        { txid: 'older', type: 'received', amount: 1, confirmed: true, blockTime: 100, account: 'savings' },
        { txid: 'journal', type: 'sent', amount: 1, confirmed: false, account: 'spend', bitcoinOperationId: 'op' },
      ]),
    ).toBe('older')
  })

  it('keeps fresh records ahead of retained older copies', () => {
    const retained = retainOlderRows(
      [
        { txid: 'older', type: 'received', amount: 1, confirmed: true, blockTime: 50, account: 'savings' },
        { txid: 'dup', type: 'received', amount: 1, confirmed: false, account: 'savings' },
      ],
      [{ txid: 'dup', type: 'received', amount: 1, confirmed: true, blockTime: 60, account: 'savings' }],
    )
    expect(retained.map((item) => item.txid)).toEqual(['older'])
  })

  it('replaces the cached snapshot after a successful refresh', async () => {
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
      watchedSavingsAddress: SAVINGS_ADDRESS,
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
    expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.vtxoSpendingSats).toBe(50_000)
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
    expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.boardingBalance).toBe(0)
    expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.history).toEqual([settled])

    // A failed read must not reintroduce the stale pending deposit beside
    // the previously observed settled balance, including after a reload.
    mockedSnapshot.mockRejectedValueOnce(new Error('worker unavailable'))
    await act(async () => result.current.refreshBalance())
    expect(result.current.positions.spending).toEqual({ availableSats: 33_458, pendingSats: 0, totalSats: 33_458 })
    expect(result.current.history).toEqual([settled])
    expect(mockedUtxos).not.toHaveBeenCalledWith(STATUS.vtxoBoardingAddress)
  })

  it('shares each pending account read while allowing the other account to refresh', async () => {
    const savings = deferred<Awaited<ReturnType<typeof fetchAddressUtxos>>>()
    mockedUtxos.mockReturnValue(savings.promise)
    mockedSnapshot
      .mockResolvedValueOnce({ balance: 10_000, history: [] })
      .mockResolvedValueOnce({ balance: 30_000, history: [] })
    const { result } = setupHook()
    let first!: Promise<void>, second!: Promise<void>
    act(() => {
      first = result.current.refreshBalance()
    })
    await waitFor(() => expect(result.current.positions.spending.availableSats).toBe(10_000))
    expect(result.current.accountReads.savings.loaded).toBe(false)
    expect(result.current.accountReads.spend.loaded).toBe(true)
    expect(result.current.snapshotFresh).toBe(false)
    act(() => {
      second = result.current.refreshBalance()
    })
    await waitFor(() => expect(result.current.positions.spending.availableSats).toBe(30_000))
    expect(mockedUtxos).toHaveBeenCalledOnce()
    await act(async () => {
      savings.resolve([{ txid: 'saved', vout: 0, value: 5_000, status: { confirmed: true } }])
      await Promise.all([first, second])
    })
    expect(result.current.positions.savings.totalSats).toBe(5_000)
    expect(result.current.positions.spending.availableSats).toBe(30_000)
    expect(result.current.snapshotFresh).toBe(true)
  })

  it('shows boarding coins from Esplora and revives the Spending worker after a snapshot failure', async () => {
    mockedUtxos.mockImplementation(async (address) => {
      if (address === STATUS.vtxoBoardingAddress) {
        return [{ txid: 'b8ed', vout: 0, value: 33_458, status: { confirmed: true } }]
      }
      if (address === SAVINGS_ADDRESS) {
        return [{ txid: 'sav', vout: 0, value: 20_000, status: { confirmed: true } }]
      }
      return []
    })
    const recovered = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
    mockedSnapshot
      .mockRejectedValueOnce(
        new AggregateError([new Error('SDK worker did not register the Spending contract')], 'teardown failed'),
      )
      .mockReturnValueOnce(recovered.promise)
    const { result } = setupHook()
    await act(async () => result.current.refreshBalance())
    expect(result.current.accountReads.spend.loaded).toBe(false)
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
    await act(async () => {
      recovered.resolve({
        balance: 0,
        boardingBalance: 33_458,
        history: [
          { txid: 'b8ed', type: 'received', amount: 33_458, confirmed: false, account: 'spend', activity: 'boarding' },
        ],
      })
    })
    await waitFor(() => expect(result.current.accountReads.spend.loaded).toBe(true))
    expect(result.current.history.filter((item) => item.txid === 'b8ed')).toHaveLength(1)
    expect(result.current.positions.spending.pendingSats).toBe(33_458)
    expect(result.current.accountReads.spend.error).toBe('')
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
    expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.boardingError).toBe(boardingError)

    mockedSnapshot.mockRejectedValueOnce(new Error('worker unavailable'))
    await act(async () => result.current.refreshBalance())
    expect(result.current.boardingError).toBe(boardingError)
    expect(result.current.positions.spending.totalSats).toBe(31_908)

    mockedSnapshot.mockResolvedValueOnce({ balance: 31_908, boardingBalance: 0, history: [] })
    await act(async () => result.current.refreshBalance())
    expect(result.current.boardingError).toBe('')
    expect(result.current.positions.spending).toEqual({ availableSats: 31_908, pendingSats: 0, totalSats: 31_908 })
    expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.boardingError).toBeUndefined()
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
    expect(result.current.accountReads.spend.error).toBe('Could not refresh Spending. Try again.')
  })

  it('recovers a cold reload from the persisted enrollment', async () => {
    const enrollment = { vaultId: STATUS.vaultId } as EnrollmentSecrets
    mockedSnapshot.mockResolvedValueOnce({ balance: 12_000, history: [] })
    const { result } = setupHook(false, null, true, enrollment, false)

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledWith(expect.any(AbortSignal), STATUS.vaultId))
    await waitFor(() => expect(result.current.accountReads.spend.loaded).toBe(true))
    expect(result.current.positions.spending.availableSats).toBe(12_000)
  })

  it('subscribes to worker updates and reloads the same worker on focus', async () => {
    const { result } = setupHook(false)
    await waitFor(() => expect(result.current.accountReads.spend.loaded).toBe(true))
    expect(mockedWorkerEvents).toHaveBeenCalledWith(STATUS, expect.any(Function))

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(mockedWorkerReload).toHaveBeenCalledWith(STATUS))
  })
})

it('keeps the last known Savings funds when Esplora fails', async () => {
  saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
    watchedSavingsAddress: SAVINGS_ADDRESS,
    boardingBalance: 0,
    history: [],
    savingsSats: 9000,
    savingsSpendableSats: 9000,
    vtxoSpendingSats: 42000,
  })
  mockedUtxos.mockImplementation(async (address) => {
    if (address === SAVINGS_ADDRESS) throw new Error('Esplora unavailable')
    return []
  })
  mockedSnapshot.mockResolvedValue({ balance: 42000, history: [] })
  const { result } = setupHook(true)
  await act(async () => result.current.refreshBalance())
  expect(result.current.positions.savings.totalSats).toBe(9000)
  expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.savingsSats).toBe(9000)
})

it('refreshes fresh Light Spending through the same pinned status and worker as protected Spending', async () => {
  const status = sharedSpendingStatus()
  mockedStatus.mockResolvedValue(status)
  mockedSnapshot.mockResolvedValue({ balance: 12000, pendingBalance: 2000, history: [] })
  const { result, setStatus } = setupHook(false, status, true, sharedSpendingEnrollment())
  await waitFor(() => expect(result.current.positions.spending.totalSats).toBe(14000))
  expect(setStatus).toHaveBeenCalledWith(status)
  expect(mockedStatus).toHaveBeenCalledWith(expect.any(AbortSignal), status.vaultId)
  expect(fetchVaultStatusUnpinned).not.toHaveBeenCalled()
  expect(mockedSnapshot).toHaveBeenCalledWith(status)
  expect(mockedUtxos).not.toHaveBeenCalled()
  expect(result.current.positions.savings.totalSats).toBe(0)
})

it('rejects changed Light signing facts against its common pin before reading balances', async () => {
  const status = sharedSpendingStatus()
  mockedStatus.mockResolvedValue({ ...status, spendingArkAddress: 'tark1changed' })
  const { result, setStatus } = setupHook(false, status, true, sharedSpendingEnrollment())
  await act(async () => result.current.refreshBalance(status.vaultId))
  expect(result.current.snapshotFresh).toBe(false)
  expect(setStatus).not.toHaveBeenCalled()
  expect(mockedSnapshot).not.toHaveBeenCalled()
  expect(mockedUtxos).not.toHaveBeenCalled()
})

it('keeps watched Savings scoped to the selected address when an earlier request finishes late', async () => {
  const status = sharedSpendingStatus()
  mockedStatus.mockResolvedValue(status)
  const old = deferred<Awaited<ReturnType<typeof fetchAddressUtxos>>>()
  mockedUtxos.mockImplementation(async (address, signal) => {
    if (address !== 'tb1pfirst') return [{ txid: 'new', vout: 0, value: 8000, status: { confirmed: true } }]
    return new Promise((resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      old.promise.then(resolve, reject)
    })
  })
  const pin = saveAddressPin(pinFromEnrolledStatus(status))
  const setStatus = vi.fn()
  const enrollment = sharedSpendingEnrollment()
  const { result, rerender } = renderHook(
    ({ address }) =>
      useVaultBalances({
        addressPin: pin,
        enrollment,
        initialStatusChecked: true,
        locked: false,
        setStatus,
        status,
        watchedSavingsAddress: address,
      }),
    { initialProps: { address: 'tb1pfirst' } },
  )
  await waitFor(() => expect(mockedUtxos).toHaveBeenCalledWith('tb1pfirst', expect.any(AbortSignal)))
  rerender({ address: 'tb1psecond' })
  expect(mockedUtxos.mock.calls.find(([address]) => address === 'tb1pfirst')?.[1]?.aborted).toBe(true)
  await waitFor(() => expect(result.current.positions.savings.totalSats).toBe(8000))
  await act(async () => old.resolve([{ txid: 'old', vout: 0, value: 999999, status: { confirmed: true } }]))
  expect(result.current.positions.savings.totalSats).toBe(8000)
})

describe('older activity scope safety', () => {
  const STATUS_B = sharedSpendingStatusForNetwork('mutinynet', { vaultId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })

  function savingsTx(txid: string, blockTime: number) {
    return {
      txid,
      vin: [],
      vout: [{ scriptpubkey_address: 'tb1psavings', value: 1_000 }],
      status: { confirmed: true, block_time: blockTime },
    }
  }

  function setupLive(status: VaultStatus, locked: boolean) {
    const pin = saveAddressPin(pinFromEnrolledStatus(status))
    const setStatus = vi.fn()
    return renderHook(
      ({ currentStatus, currentLocked }: { currentStatus: VaultStatus; currentLocked: boolean }) =>
        useVaultBalances({
          watchedSavingsAddress: SAVINGS_ADDRESS,
          addressPin: currentStatus.vaultId === status.vaultId ? pin : null,
          enrollment: null,
          initialStatusChecked: true,
          locked: currentLocked,
          setStatus,
          status: currentStatus,
        }),
      { initialProps: { currentStatus: status, currentLocked: locked } },
    )
  }

  it('discards a pending older load after a vault switch without touching either scope', async () => {
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    let resolveOlder!: (value: { transactions: { txid: string }[]; exhausted: boolean }) => void
    mockedOlderTxs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve as never
        }),
    )
    const { result, rerender } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a']))
    let outcome!: { added: number; exhausted: boolean }
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS_B, currentLocked: false })
    await act(async () => {
      resolveOlder({ transactions: [savingsTx('older-a', 100)], exhausted: false })
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(
      loadBalanceSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'mutinynet')?.history.map((item) => item.txid),
    ).toEqual(['recent-a'])
    expect(result.current.olderActivity.status).not.toBe('error')
  })

  it('discards a pending older load after locking without changing loaded history', async () => {
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    let resolveOlder!: (value: { transactions: { txid: string }[]; exhausted: boolean }) => void
    mockedOlderTxs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve as never
        }),
    )
    const { result, rerender } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a']))
    let outcome!: { added: number; exhausted: boolean }
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS, currentLocked: true })
    await act(async () => {
      resolveOlder({ transactions: [], exhausted: false })
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a'])
    expect(result.current.olderActivity.status).toBe('idle')
  })

  it('shares one flight between concurrent older loads', async () => {
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    mockedOlderTxs.mockResolvedValue({ transactions: [savingsTx('older-a', 100)], exhausted: true })
    const { result } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a']))
    let first!: Promise<{ added: number; exhausted: boolean }>
    let second!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      first = result.current.loadOlderActivity()
      second = result.current.loadOlderActivity()
    })
    expect(mockedOlderTxs).toHaveBeenCalledTimes(1)
    let outcomes!: [{ added: number; exhausted: boolean }, { added: number; exhausted: boolean }]
    await act(async () => {
      outcomes = await Promise.all([first, second])
    })
    expect(outcomes[0]).toEqual({ added: 1, exhausted: true })
    expect(second).toBe(first)
    expect(outcomes[1]).toEqual({ added: 1, exhausted: true })
  })

  it('stops when the oldest cursor cannot advance instead of repeating the page', async () => {
    const known = Array.from({ length: 25 }, (_, index) => savingsTx(`known-${index}`, 100 + index))
    mockedTxs.mockResolvedValue(known)
    mockedOlderTxs.mockResolvedValue({ transactions: known, exhausted: false })
    const { result } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.history).toHaveLength(25))
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      outcome = await result.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 0, exhausted: true })
    expect(result.current.olderActivity.status).toBe('exhausted')
  })

  it('keeps older rows across refresh while fresh evidence wins overlaps', async () => {
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    mockedOlderTxs.mockResolvedValue({ transactions: [savingsTx('older-a', 100)], exhausted: true })
    const { result } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a']))
    await act(async () => {
      await result.current.loadOlderActivity()
    })
    expect(result.current.history.map((item) => item.txid).sort()).toEqual(['older-a', 'recent-a'])
    await act(async () => {
      await result.current.refreshBalance()
    })
    expect(result.current.history.map((item) => item.txid).sort()).toEqual(['older-a', 'recent-a'])
  })

  it('retains a completed older page when Spending publishes before the next render', async () => {
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    const { result } = setupLive(STATUS, false)
    await waitFor(() => expect(result.current.snapshotFresh).toBe(true))
    const spending = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
    mockedSnapshot.mockReturnValueOnce(spending.promise)
    mockedOlderTxs.mockResolvedValue({ transactions: [savingsTx('older-a', 100)], exhausted: true })
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.refreshBalance()
    })
    await waitFor(() => expect(result.current.accountReads.savings.fresh).toBe(true))
    await act(async () => {
      await result.current.loadOlderActivity()
      spending.resolve({ balance: 42_000, history: [] })
      await refresh
    })
    expect(result.current.history.map((item) => item.txid).sort()).toEqual(['older-a', 'recent-a'])
    expect(
      loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')
        ?.history.map((item) => item.txid)
        .sort(),
    ).toEqual(['older-a', 'recent-a'])
    expect(result.current.positions.spending.availableSats).toBe(42_000)
  })
})

describe('older activity request generations', () => {
  const STATUS_B = sharedSpendingStatusForNetwork('mutinynet', { vaultId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
  const STATUS_NET = sharedSpendingStatusForNetwork('mainnet', { vaultId: STATUS.vaultId })

  function savingsTx(txid: string, blockTime: number) {
    return {
      txid,
      vin: [],
      vout: [{ scriptpubkey_address: 'tb1psavings', value: 1_000 }],
      status: { confirmed: true, block_time: blockTime },
    }
  }

  function seedSnapshot(vaultId: string, txids: { txid: string; blockTime: number }[]) {
    saveBalanceSnapshot(vaultId, 'mutinynet', {
      watchedSavingsAddress: SAVINGS_ADDRESS,
      boardingBalance: 0,
      history: txids.map(({ txid, blockTime }) => ({
        txid,
        type: 'received' as const,
        amount: 1_000,
        confirmed: true,
        blockTime,
        account: 'savings' as const,
      })),
      savingsSats: 1_000,
      savingsSpendableSats: 1_000,
      vtxoSpendingSats: 0,
    })
  }

  function setupScoped(status: VaultStatus, locked: boolean, pinStatus: VaultStatus = status) {
    saveAddressPin(pinFromEnrolledStatus(pinStatus))
    const setStatus = vi.fn()
    return renderHook(
      ({ currentStatus, currentLocked }: { currentStatus: VaultStatus; currentLocked: boolean }) =>
        useVaultBalances({
          watchedSavingsAddress: SAVINGS_ADDRESS,
          addressPin:
            currentStatus.vaultId === pinStatus.vaultId ? loadAddressPin(localStorage, pinStatus.vaultId) : null,
          enrollment: null,
          initialStatusChecked: false,
          locked: currentLocked,
          setStatus,
          status: currentStatus,
        }),
      { initialProps: { currentStatus: status, currentLocked: locked } },
    )
  }

  function deferredOlder() {
    let resolve!: (value: { transactions: { txid: string }[]; exhausted: boolean }) => void
    let reject!: (reason: unknown) => void
    mockedOlderTxs.mockImplementationOnce(
      () =>
        new Promise((accept, deny) => {
          resolve = accept as never
          reject = deny
        }),
    )
    return {
      resolve: (transactions: { txid: string }[], exhausted: boolean) => resolve({ transactions, exhausted }),
      reject: (reason: unknown) => reject(reason),
    }
  }

  it('discards a locked-then-unlocked flight without touching state', async () => {
    seedSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ txid: 'recent-a', blockTime: 200 }])
    mockedTxs.mockResolvedValue([savingsTx('recent-a', 200)])
    const flight = deferredOlder()
    const { result, rerender } = setupScoped(STATUS, false)
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a'])
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS, currentLocked: true })
    rerender({ currentStatus: STATUS, currentLocked: false })
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      flight.resolve([savingsTx('older-a', 100)], false)
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a'])
    expect(result.current.olderActivity.status).toBe('idle')
    // The new generation loads independently afterward.
    mockedOlderTxs.mockResolvedValue({ transactions: [savingsTx('older-a', 100)], exhausted: true })
    const { result: fresh } = setupScoped(STATUS, false)
    await act(async () => {
      outcome = await fresh.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 1, exhausted: true })
    expect(fresh.current.history.map((item) => item.txid).sort()).toEqual(['older-a', 'recent-a'])
  })

  it('discards an A-B-A flight and lets the returning scope load again', async () => {
    seedSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ txid: 'recent-a', blockTime: 200 }])
    seedSnapshot('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', [{ txid: 'recent-b', blockTime: 200 }])
    saveAddressPin(pinFromEnrolledStatus(STATUS_B))
    const flight = deferredOlder()
    const { result, rerender } = setupScoped(STATUS, false)
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS_B, currentLocked: false })
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-b'])
    rerender({ currentStatus: STATUS, currentLocked: false })
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      flight.resolve([savingsTx('older-a', 100)], false)
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.history.map((item) => item.txid)).toEqual(['recent-a'])
    expect(
      loadBalanceSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'mutinynet')?.history.map((item) => item.txid),
    ).toEqual(['recent-a'])
    mockedOlderTxs.mockResolvedValue({ transactions: [savingsTx('older-a', 100)], exhausted: true })
    await act(async () => {
      outcome = await result.current.loadOlderActivity()
    })
    expect(outcome).toEqual({ added: 1, exhausted: true })
  })

  it('keeps scope errors off the new scope after a vault change', async () => {
    seedSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ txid: 'recent-a', blockTime: 200 }])
    seedSnapshot('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', [{ txid: 'recent-b', blockTime: 200 }])
    saveAddressPin(pinFromEnrolledStatus(STATUS_B))
    const flight = deferredOlder()
    const { result, rerender } = setupScoped(STATUS, false)
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS_B, currentLocked: false })
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      flight.reject(new Error('offline'))
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.olderActivity.status).toBe('idle')
  })

  it('discards a stale failure after a network change', async () => {
    seedSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ txid: 'recent-a', blockTime: 200 }])
    const flight = deferredOlder()
    const { result, rerender } = setupScoped(STATUS, false)
    let pending!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      pending = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS_NET, currentLocked: false })
    let outcome!: { added: number; exhausted: boolean }
    await act(async () => {
      flight.reject(new Error('offline'))
      outcome = await pending
    })
    expect(outcome).toEqual({ added: 0, exhausted: false })
    expect(result.current.olderActivity.status).toBe('idle')
  })

  it('keeps a newer flight alive when an older finally lands first', async () => {
    seedSnapshot('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ txid: 'recent-a', blockTime: 200 }])
    seedSnapshot('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', [{ txid: 'recent-b', blockTime: 200 }])
    saveAddressPin(pinFromEnrolledStatus(STATUS_B))
    const first = deferredOlder()
    const { result, rerender } = setupScoped(STATUS, false)
    let stale!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      stale = result.current.loadOlderActivity()
    })
    rerender({ currentStatus: STATUS_B, currentLocked: false })
    const second = deferredOlder()
    let fresh!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      fresh = result.current.loadOlderActivity()
    })
    // The older finally must not release the newer flight: no new fetch starts.
    let staleOutcome!: { added: number; exhausted: boolean }
    await act(async () => {
      first.resolve([savingsTx('older-a', 100)], false)
      staleOutcome = await stale
    })
    expect(staleOutcome).toEqual({ added: 0, exhausted: false })
    expect(mockedOlderTxs).toHaveBeenCalledTimes(2)
    let shared!: Promise<{ added: number; exhausted: boolean }>
    act(() => {
      shared = result.current.loadOlderActivity()
    })
    expect(mockedOlderTxs).toHaveBeenCalledTimes(2)
    await act(async () => {
      expect(shared).toBe(fresh)
      second.resolve([savingsTx('older-b', 100)], true)
      await expect(fresh).resolves.toEqual({ added: 1, exhausted: true })
      await expect(shared).resolves.toEqual({ added: 1, exhausted: true })
    })
    expect(result.current.history.map((item) => item.txid).sort()).toEqual(['older-b', 'recent-b'])
  })
})

it('publishes Spending while Savings fails and retries without replacing the SDK worker', async () => {
  mockedUtxos.mockRejectedValue(new Error('Savings parent unavailable'))
  mockedSnapshot.mockResolvedValue({ balance: 42_000, history: [] })
  const { result } = setupHook()
  await act(async () => result.current.refreshBalance())
  expect(result.current.positions.spending.availableSats).toBe(42_000)
  expect(result.current.accountReads.spend).toMatchObject({ loaded: true, fresh: true, error: '' })
  expect(result.current.accountReads.savings).toMatchObject({
    loaded: false,
    fresh: false,
    error: 'Could not refresh Savings. Try again.',
  })
  expect(result.current.snapshotFresh).toBe(false)
  expect(mockedWorkerRevive).not.toHaveBeenCalled()
  expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.loaded).toEqual({ spend: true, savings: false })
})

it('shares three concurrent snapshot requests for each account and the validated status', async () => {
  const spending = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
  mockedSnapshot.mockReturnValue(spending.promise)
  const { result } = setupHook()
  let requests!: Promise<void>[]
  act(() => {
    requests = Array.from({ length: 3 }, () => result.current.refreshBalance())
  })
  await waitFor(() => expect(mockedSnapshot).toHaveBeenCalledOnce())
  expect(mockedStatus).toHaveBeenCalledOnce()
  expect(mockedUtxos).toHaveBeenCalledOnce()
  await act(async () => {
    spending.resolve({ balance: 12_000, history: [] })
    await Promise.all(requests)
  })
  expect(result.current.positions.spending.availableSats).toBe(12_000)
})

it.each(['lock', 'network', 'vault', 'return', 'unmount'] as const)(
  'rejects an old account snapshot after %s changes its scope',
  async (transition) => {
    const spending = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
    mockedSnapshot.mockReturnValue(spending.promise)
    const pin = saveAddressPin(pinFromEnrolledStatus(STATUS))
    const hook = renderHook(
      ({ status, locked }) =>
        useVaultBalances({
          watchedSavingsAddress: SAVINGS_ADDRESS,
          addressPin: pin,
          enrollment: null,
          initialStatusChecked: false,
          locked,
          setStatus: vi.fn(),
          status,
        }),
      { initialProps: { status: STATUS, locked: false } },
    )
    let request!: Promise<void>
    act(() => {
      request = hook.result.current.refreshBalance()
    })
    await waitFor(() => expect(mockedSnapshot).toHaveBeenCalledOnce())
    if (transition === 'unmount') hook.unmount()
    else if (transition === 'lock') hook.rerender({ status: STATUS, locked: true })
    else if (transition === 'network')
      hook.rerender({ status: sharedSpendingStatusForNetwork('mainnet', { vaultId: STATUS.vaultId }), locked: false })
    else {
      hook.rerender({
        status: sharedSpendingStatusForNetwork('mutinynet', { vaultId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
        locked: false,
      })
      if (transition === 'return') hook.rerender({ status: STATUS, locked: false })
    }
    const saved = localStorage.getItem(`arkade-vault-v2:balance-snapshot:mutinynet:${STATUS.vaultId}`)
    expect(saved).not.toBeNull()
    await act(async () => {
      spending.resolve({ balance: 999_000, history: [] })
      await request
    })
    expect(localStorage.getItem(`arkade-vault-v2:balance-snapshot:mutinynet:${STATUS.vaultId}`)).toBe(saved)
    if (transition !== 'unmount') expect(hook.result.current.positions.spending.availableSats).toBe(0)
  },
)

it('does not request another vault through the active account refresh command', async () => {
  const { result } = setupHook()
  await act(async () => result.current.refreshBalance('another-vault'))
  expect(mockedStatus).not.toHaveBeenCalled()
  expect(mockedSnapshot).not.toHaveBeenCalled()
})

it('hydrates an unknown Savings balance separately from a saved Spending balance', () => {
  saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
    watchedSavingsAddress: SAVINGS_ADDRESS,
    loaded: { spend: true, savings: false },
    boardingBalance: 0,
    history: [],
    savingsSats: 0,
    savingsSpendableSats: 0,
    vtxoSpendingSats: 42_000,
  })
  const { result } = setupHook()
  expect(result.current.accountReads.spend.loaded).toBe(true)
  expect(result.current.accountReads.savings.loaded).toBe(false)
  expect(result.current.snapshotFresh).toBe(false)
})

it.each([0, 33_458])('keeps Spending unknown after a boarding-only read of %i sats', async (boardingSats) => {
  mockedSnapshot.mockRejectedValue(new Error('Spending SDK unavailable'))
  mockedUtxos.mockImplementation(async (address) =>
    address === STATUS.vtxoBoardingAddress && boardingSats > 0
      ? [{ txid: 'deposit', vout: 0, value: boardingSats, status: { confirmed: true } }]
      : [],
  )
  const revive = deferred<Awaited<ReturnType<typeof reviveVaultWalletWorker>>>()
  mockedWorkerRevive.mockReturnValue(revive.promise)
  const { result, unmount } = setupHook()
  await act(async () => result.current.refreshBalance())
  expect(result.current.accountReads.spend).toMatchObject({ loaded: false, fresh: false })
  expect(result.current.positions.spending).toEqual({
    availableSats: 0,
    pendingSats: boardingSats,
    totalSats: boardingSats,
  })
  expect(loadBalanceSnapshot(STATUS.vaultId, 'mutinynet')?.loaded?.spend).toBe(false)
  unmount()
  revive.resolve(undefined as never)
})

describe('balance controller ownership', () => {
  it('publishes independently to subscribers without a React component or a second balance owner', async () => {
    const savings = deferred<Awaited<ReturnType<typeof fetchAddressUtxos>>>()
    mockedUtxos.mockReturnValue(savings.promise)
    mockedSnapshot.mockResolvedValue({ balance: 7000, history: [] })
    const controller = standaloneController()
    const first = vi.fn(),
      second = vi.fn()
    const unsubscribe = controller.subscribe(first)
    controller.subscribe(second)
    const initial = controller.getSnapshot()
    expect(controller.getSnapshot()).toBe(initial)
    const read = controller.refreshBalance()
    await vi.waitFor(() => expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000))
    expect(controller.getSnapshot().accountReads.savings.loaded).toBe(false)
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(first.mock.calls.length)
    unsubscribe()
    first.mockClear()
    savings.resolve([{ txid: 'saved', vout: 0, value: 3000, status: { confirmed: true } }])
    await read
    expect(first).not.toHaveBeenCalled()
    expect(controller.getSnapshot().positions.savings.totalSats).toBe(3000)
    expect(controller.getSnapshot().snapshotFresh).toBe(true)
    expect(controller.getSnapshot()).toBe(controller.getSnapshot())
  })

  it('hydrates only the selected network for a vault ID that exists on both networks', () => {
    const base = {
      history: [],
      boardingBalance: 0,
      savingsSats: 0,
      savingsSpendableSats: 0,
      watchedSavingsAddress: SAVINGS_ADDRESS,
    }
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', { ...base, vtxoSpendingSats: 7000 })
    saveBalanceSnapshot(STATUS.vaultId, 'mainnet', { ...base, vtxoSpendingSats: 9000 })
    const controller = standaloneController()
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000)
    const mainnet = sharedSpendingStatusForNetwork('mainnet', { vaultId: STATUS.vaultId })
    const selected = standaloneController(
      controllerOptions({ status: mainnet, addressPin: pinFromEnrolledStatus(mainnet) }),
    )
    expect(selected.getSnapshot().positions.spending.availableSats).toBe(9000)
    expect(selected.getSnapshot().snapshotFresh).toBe(false)
  })

  it('keeps Spending available while rejecting a cache for a different watched Savings address', () => {
    saveBalanceSnapshot(STATUS.vaultId, 'mutinynet', {
      history: [],
      boardingBalance: 0,
      savingsSats: 99000,
      savingsSpendableSats: 99000,
      vtxoSpendingSats: 7000,
      watchedSavingsAddress: 'tb1pold',
    })
    const controller = standaloneController()
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000)
    expect(controller.getSnapshot().accountReads.spend.loaded).toBe(true)
    expect(controller.getSnapshot().positions.savings.totalSats).toBe(0)
    expect(controller.getSnapshot().accountReads.savings.loaded).toBe(false)
  })

  it('invalidates an old read when signing identity changes under the same vault ID and network', async () => {
    const old = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
    mockedSnapshot.mockReturnValue(old.promise)
    const controller = standaloneController()
    const pending = controller.refreshBalance()
    await vi.waitFor(() => expect(mockedSnapshot).toHaveBeenCalledOnce())
    const replacement = sharedSpendingStatusForNetwork('mutinynet', {
      vaultId: STATUS.vaultId,
      phoneSecret: new Uint8Array(32).fill(42),
    })
    const selected = standaloneController(
      controllerOptions({ status: replacement, addressPin: pinFromEnrolledStatus(replacement) }),
    )
    old.resolve({ balance: 900000, history: [] })
    await pending
    expect(selected.getSnapshot().accountReads.spend.loaded).toBe(false)
    expect(selected.getSnapshot().positions.spending.availableSats).toBe(0)
  })

  it('rejects a completed cached observation after replacing the signing identity', async () => {
    mockedSnapshot.mockResolvedValue({ balance: 7000, history: [] })
    const controller = standaloneController()
    await controller.refreshBalance()
    expect(loadBalanceSnapshot(STATUS.vaultId, STATUS.network)?.walletIdentity).toBe(vaultAccountRuntime(STATUS).key)
    const replacement = sharedSpendingStatusForNetwork('mutinynet', {
      vaultId: STATUS.vaultId,
      phoneSecret: new Uint8Array(32).fill(42),
    })
    const selected = standaloneController(
      controllerOptions({ status: replacement, addressPin: pinFromEnrolledStatus(replacement) }),
    )
    expect(selected.getSnapshot().accountReads.spend.loaded).toBe(false)
    expect(selected.getSnapshot().positions.spending.availableSats).toBe(0)
  })

  it('keeps account replacement outside the balance controller update command', () => {
    const controller = standaloneController()
    const other = sharedSpendingStatusForNetwork('mutinynet', { vaultId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    expect(() => controller.update(controllerOptions({ status: other }))).toThrow(
      'Balance inputs must belong to their account runtime',
    )
    expect(activeVaultAccountRuntime(STATUS.vaultId)?.balances).toBe(controller)
    expect(activeVaultAccountRuntime(other.vaultId)).toBeUndefined()
  })

  it('drains the balance SDK read before account teardown closes the connection', async () => {
    const pending = deferred<Awaited<ReturnType<typeof fetchVaultWalletVtxoSnapshot>>>()
    mockedSnapshot.mockReturnValue(pending.promise)
    const controller = standaloneController()
    const account = vaultAccountRuntime(STATUS)
    const close = vi.fn().mockResolvedValue(undefined)
    account.closeConnection = close
    const read = controller.refreshBalance()
    await vi.waitFor(() => expect(mockedSnapshot).toHaveBeenCalledOnce())
    const dispose = disposeVaultAccountRuntime(account)
    expect(close).not.toHaveBeenCalled()
    pending.resolve({ balance: 7000, history: [] })
    await Promise.all([read, dispose])
    expect(close).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(0)
  })

  it('resumes its subscription after React Strict Mode replays the mounting effects', async () => {
    mockedSnapshot.mockResolvedValue({ balance: 7000, history: [] })
    const options = controllerOptions({ initialStatusChecked: true })
    const { result, unmount } = renderHook(() => useVaultBalances(options), { wrapper: StrictMode })
    await waitFor(() => expect(result.current.positions.spending.availableSats).toBe(7000))
    expect(result.current.snapshotFresh).toBe(true)
    unmount()
    mockedSnapshot.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(mockedSnapshot).not.toHaveBeenCalled()
  })
})

describe('account-owned balance scheduling', () => {
  it('shares one controller and one read across concurrent UI demand and keeps state after views detach', async () => {
    vi.useFakeTimers()
    const options = controllerOptions()
    const controller = standaloneController(options)
    expect(vaultBalanceController({ ...options })).toBe(controller)
    const account = vaultAccountRuntime(STATUS)
    expect(account.balances).toBe(controller)
    const leaveFirst = controller.retain(),
      leaveSecond = controller.retain()
    const first = account.maintenance.requestCadence('spending-balance', 5000)
    const second = account.maintenance.requestCadence('spending-balance', 5000)
    mockedSnapshot.mockResolvedValue({ balance: 7000, history: [] })
    await vi.advanceTimersByTimeAsync(150)
    expect(mockedSnapshot).toHaveBeenCalledOnce()
    expect(mockedStatus).toHaveBeenCalledOnce()
    // JSDOM dispatches storage events on a separate zero-delay timer.
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(1)
    first()
    second()
    leaveFirst()
    leaveSecond()
    expect(vi.getTimerCount()).toBe(0)
    expect(vaultBalanceController(options)).toBe(controller)
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000)
  })

  it('backs off failed Savings reads to thirty seconds without stalling Spending', async () => {
    vi.useFakeTimers()
    mockedUtxos.mockRejectedValue(new Error('Savings offline'))
    mockedSnapshot.mockResolvedValue({ balance: 7000, history: [] })
    const controller = standaloneController()
    await controller.refreshBalance()
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000)
    let calls = 1
    expect(mockedUtxos).toHaveBeenCalledTimes(calls)
    let completedAt = Date.now()
    for (const delay of [0, 2000, 4000, 8000, 16000, 30000, 30000]) {
      if (delay) {
        await vi.advanceTimersByTimeAsync(completedAt + delay - Date.now() - 1)
        expect(mockedUtxos).toHaveBeenCalledTimes(calls)
        await vi.advanceTimersByTimeAsync(1)
      } else await vi.advanceTimersByTimeAsync(0)
      completedAt = Date.now()
      expect(mockedUtxos).toHaveBeenCalledTimes(++calls)
      // Flush the cache write's JSDOM storage event before counting clocks.
      await vi.advanceTimersByTimeAsync(1)
      expect(vi.getTimerCount()).toBe(1)
    }
    expect(mockedSnapshot).toHaveBeenCalledOnce()
    expect(mockedWorkerRevive).not.toHaveBeenCalled()
  })

  it('retains hidden Receive demand and resumes it through the shared visibility event', async () => {
    vi.useFakeTimers()
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const controller = standaloneController()
      const leave = controller.retain()
      const release = vaultAccountRuntime(STATUS).maintenance.requestCadence('spending-balance', 5000)
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockedSnapshot).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      visible.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(150)
      expect(mockedSnapshot).toHaveBeenCalledOnce()
      release()
      leave()
    } finally {
      visible.mockRestore()
    }
  })

  it('recovers a cold SDK failure when revival uses the actual scheduler drain', async () => {
    vi.useFakeTimers()
    const reconnect = vi.fn()
    mockedWorkerRevive.mockImplementation(async () => {
      await vaultAccountRuntime(STATUS).maintenance.withPaused(async () => {
        reconnect()
      })
      return {} as Awaited<ReturnType<typeof reviveVaultWalletWorker>>
    })
    mockedSnapshot.mockRejectedValueOnce(new Error('cold failure')).mockResolvedValue({ balance: 7000, history: [] })
    const controller = standaloneController()
    await controller.refreshBalance()
    expect(controller.getSnapshot().accountReads.spend.loaded).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(reconnect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(150)
    expect(controller.getSnapshot().positions.spending.availableSats).toBe(7000)
    expect(controller.getSnapshot().accountReads.spend.loaded).toBe(true)
  })
})
