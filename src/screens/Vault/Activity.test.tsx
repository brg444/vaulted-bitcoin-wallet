import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import type { VaultHistoryItem } from '../../lib/vault/history'
import type { OlderActivityState } from '../../vault/useVaultBalances'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultActivity, { filterActivity } from './Activity'

const NOW = 1_700_000_200

function row(index: number): VaultHistoryItem {
  if (index === 0) {
    return { txid: 'pending-0', type: 'received', amount: 1_000, confirmed: false, account: 'spend' }
  }
  if (index === 1) {
    return {
      txid: 'failed-1',
      type: 'sent',
      amount: 2_000,
      confirmed: true,
      blockTime: NOW - 10,
      account: 'spend',
      activity: 'lightning',
      lightningState: 'failed',
      lightningRfqId: 'rfq-1',
    }
  }
  const account = index % 3 === 0 ? ('savings' as const) : ('spend' as const)
  const type = index % 2 === 0 ? ('sent' as const) : ('received' as const)
  return {
    txid: `tx-${index}`,
    type,
    amount: 1_000 + index,
    confirmed: true,
    blockTime: NOW - 60 * index,
    account,
  }
}

function history(count: number): VaultHistoryItem[] {
  return Array.from({ length: count }, (_, index) => row(index))
}

function renderActivity(
  overrides: Partial<VaultContextProps> = {},
  rows: VaultHistoryItem[] = history(150),
  olderActivity: OlderActivityState = { status: 'idle', error: '' },
) {
  const value = {
    allHistory: rows,
    balancesLoaded: true,
    refreshingBalance: false,
    openTx: vi.fn(),
    navigate: vi.fn(),
    loadOlderActivity: vi.fn().mockResolvedValue({ added: 0, exhausted: true }),
    olderActivity,
    ...overrides,
  } as unknown as VaultContextProps
  const rendered = render(
    <ToastProvider>
      <VaultContext.Provider value={value}>
        <VaultActivity />
      </VaultContext.Provider>
    </ToastProvider>,
  )
  return { value, unmount: rendered.unmount }
}

describe('full activity', () => {
  it('loads more than 100 records with stable ordering across pages', async () => {
    const user = userEvent.setup()
    renderActivity()
    // Attention first, then pending, then newest confirmed.
    const firstPage = screen.getAllByTestId(/^vault-tx-/).map((element) => element.getAttribute('data-testid'))
    expect(firstPage).toHaveLength(50)
    expect(firstPage[0]).toBe('vault-tx-failed-1')
    expect(firstPage[1]).toBe('vault-tx-pending-0')

    await user.click(screen.getByRole('button', { name: /Show more \(50 of 150\)/ }))
    expect(screen.getAllByTestId(/^vault-tx-/)).toHaveLength(100)
    await user.click(screen.getByRole('button', { name: /Show more \(100 of 150\)/ }))
    const all = screen.getAllByTestId(/^vault-tx-/).map((element) => element.getAttribute('data-testid'))
    expect(all).toHaveLength(150)
    expect(all[149]).toBe('vault-tx-tx-149')
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
  })

  it('filters by direction, account, and status', async () => {
    const user = userEvent.setup()
    renderActivity()

    await user.selectOptions(screen.getByTestId('activity-filter-direction'), 'sent')
    const sent = screen.getAllByTestId(/^vault-tx-/)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.length).toBeLessThan(150)

    await user.selectOptions(screen.getByTestId('activity-filter-account'), 'savings')
    await user.selectOptions(screen.getByTestId('activity-filter-direction'), 'all')
    const savings = screen.getAllByTestId(/^vault-tx-/)
    expect(savings.length).toBeGreaterThan(0)
    expect(savings.length).toBeLessThan(sent.length)

    await user.selectOptions(screen.getByTestId('activity-filter-account'), 'all')
    await user.selectOptions(screen.getByTestId('activity-filter-status'), 'attention')
    expect(screen.getAllByTestId(/^vault-tx-/)).toHaveLength(1)
  })

  it('shows visible date groups for attention, pending, and dated rows', () => {
    renderActivity()
    const activity = screen.getByTestId('vault-activity')
    const headings = within(activity)
      .getAllByRole('heading', { level: 3 })
      .map((element) => element.textContent)
    expect(headings).toContain('Needs attention')
    expect(headings).toContain('Pending')
    for (const heading of within(activity).getAllByRole('heading', { level: 3 })) {
      expect(heading).toBeVisible()
    }
  })

  it('opens an older payment outside the first page', async () => {
    const user = userEvent.setup()
    const { value } = renderActivity()
    await user.click(screen.getByRole('button', { name: /Show more \(50 of 150\)/ }))
    await user.click(screen.getByRole('button', { name: /Show more \(100 of 150\)/ }))
    const target = history(150)[120]
    await user.click(screen.getByTestId(`vault-tx-${target.txid}`))
    expect(value.openTx).toHaveBeenCalledWith(target)
  })

  it('states source coverage and loads older Savings records', async () => {
    const user = userEvent.setup()
    const loadOlderActivity = vi.fn().mockResolvedValue({ added: 3, exhausted: false })
    renderActivity({ loadOlderActivity })
    expect(screen.getByTestId('activity-coverage')).toHaveTextContent(/latest 100 Bitcoin records per address/)
    await user.click(screen.getByRole('button', { name: 'Load older Savings records' }))
    expect(loadOlderActivity).toHaveBeenCalledTimes(1)
  })

  it('reports exhausted and failed older-record loads honestly', () => {
    const { unmount } = renderActivity({}, history(10), { status: 'exhausted', error: '' })
    expect(screen.getByText('No older Savings records.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load older Savings records' })).toBeNull()
    unmount()
    renderActivity({}, history(10), { status: 'error', error: 'Could not load older activity. Try again.' })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load older activity. Try again.')
  })

  it('returns home from the activity screen', async () => {
    const user = userEvent.setup()
    const { value } = renderActivity({}, [])
    await user.click(screen.getByTestId('header-back'))
    expect(value.navigate).toHaveBeenCalledWith('home')
  })

  it('says loading and empty distinctly', () => {
    const { unmount } = renderActivity({ balancesLoaded: false }, [])
    expect(screen.getByText('Loading activity…')).toBeVisible()
    unmount()
    renderActivity({}, [])
    expect(screen.getByText('No activity yet. Receive a payment to see it here.')).toBeVisible()
  })
})

describe('filterActivity', () => {
  it('keeps filter order stable over the loaded list', () => {
    const rows = history(20)
    const sent = filterActivity(rows, { direction: 'sent', account: 'all', status: 'all' })
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((item) => item.type === 'sent')).toBe(true)
    expect(sent.map((item) => item.txid)).toEqual(rows.filter((item) => item.type === 'sent').map((item) => item.txid))
    expect(
      filterActivity(rows, { direction: 'all', account: 'savings', status: 'complete' }).map((item) => item.txid),
    ).toEqual(rows.filter((item) => item.account === 'savings' && item.confirmed).map((item) => item.txid))
  })
})
