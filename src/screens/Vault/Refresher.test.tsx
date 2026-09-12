import {
  VaultTestProvider,
  type VaultTestContextProps as VaultContextProps,
} from '../../test/fixtures/VaultTestProvider'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultContent from './Content'

vi.mock('../../lib/vault/update', () => ({ reloadIfNewerWallet: vi.fn().mockResolvedValue(false) }))
vi.mock('../../lib/haptics', () => ({ hapticSubtle: vi.fn() }))

function setup() {
  const refreshBalance = vi.fn().mockResolvedValue(undefined)
  render(
    <VaultTestProvider value={{ refreshBalance } as unknown as VaultContextProps}>
      <VaultContent>
        <p>Activity</p>
        <button>Payment</button>
      </VaultContent>
    </VaultTestProvider>,
  )
  return refreshBalance
}

async function drag(target: HTMLElement, distance: number, cancel = false) {
  fireEvent.touchStart(target, { touches: [{ clientX: 100, clientY: 100 }] })
  fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 100 + distance }] })
  await act(async () => {
    if (cancel) fireEvent.touchCancel(target, { touches: [] })
    else fireEvent.touchEnd(target, { touches: [] })
  })
}

afterEach(() => vi.useRealTimers())

describe('deliberate refresh', () => {
  it('ignores short pulls, cancelled pulls and wheel overscroll', async () => {
    const refresh = setup()
    const content = screen.getByText('Activity')
    await drag(content, 50)
    await drag(content, 140, true)
    fireEvent.wheel(content, { deltaY: -120 })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once after a committed pull inside its own scroll container', async () => {
    vi.useFakeTimers()
    const refresh = setup()
    await drag(screen.getByText('Activity'), 140)
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Refreshing balance')
    await drag(screen.getByText('Activity'), 140)
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => vi.runAllTimersAsync())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('leaves buttons and touches outside the scroll container alone', async () => {
    const refresh = setup()
    await drag(screen.getByRole('button'), 140)
    await drag(document.body, 140)
    expect(refresh).not.toHaveBeenCalled()
  })
})
