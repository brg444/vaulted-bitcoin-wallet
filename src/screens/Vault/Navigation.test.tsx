import { accountBalanceReads } from '../../test/accountBalances'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultNavigation from './Navigation'

if (typeof PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number
    pointerType: string
    constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? 'touch'
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
}

function renderNav(overrides: Partial<VaultContextProps> = {}) {
  const value = {
    account: 'spend',
    accountReads: accountBalanceReads(),
    navigate: vi.fn(),
    positions: {
      spending: { availableSats: 80_000, pendingSats: 48_000, totalSats: 128_000 },
      savings: { availableSats: 20_000, pendingSats: 30_000, totalSats: 50_000 },
    },
    setAccount: vi.fn(),
    ...overrides,
  } as unknown as VaultContextProps
  render(
    <VaultContext.Provider value={value}>
      <VaultNavigation />
    </VaultContext.Provider>,
  )
  return value
}

describe('Vault navigation', () => {
  beforeEach(() => localStorage.removeItem('vault-launcher-position-v3'))
  it('opens a Home launcher and navigates without a tab bar', async () => {
    const user = userEvent.setup()
    const value = renderNav()
    const navigate = value.navigate

    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Spending' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Savings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Security' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Wallet' })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()

    const security = screen.getByRole('button', { name: 'Security' })
    security.focus()
    await user.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledWith('keys')
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveFocus()
  })

  it('switches accounts from the launcher and stays on Home', async () => {
    const user = userEvent.setup()
    const value = renderNav()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(screen.getByTestId('account-spend')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('account-spend')).toHaveTextContent('₿128,000')
    expect(screen.getByTestId('account-savings')).toHaveTextContent('₿50,000')

    await user.click(screen.getByTestId('account-savings'))
    expect(value.setAccount).toHaveBeenCalledWith('savings')
    expect(value.navigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })

  it('opens when the edge tab is pulled left', () => {
    renderNav()
    pullTab(screen.getByRole('button', { name: 'Open navigation' }), 70)
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()
  })

  it('snaps shut if the pull is too short', () => {
    renderNav()
    pullTab(screen.getByRole('button', { name: 'Open navigation' }), 24)
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeTruthy()
  })

  it('cancels a long pull when the browser cancels the pointer', () => {
    renderNav()
    const tab = screen.getByRole('button', { name: 'Open navigation' })
    act(() => {
      tab.dispatchEvent(pointer('pointerdown', 390, 640))
      tab.dispatchEvent(pointer('pointermove', 310, 640))
      tab.dispatchEvent(pointer('pointercancel', 310, 640))
    })
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })

  it('captures immediately and preserves the grab offset through a vertical placement', () => {
    renderNav()
    const tab = screen.getByRole('button', { name: 'Open navigation' })
    const layer = tab.parentElement!
    const start = parseFloat(layer.style.getPropertyValue('--qg-launcher-y'))
    tab.setPointerCapture = vi.fn()
    act(() => {
      tab.dispatchEvent(pointer('pointerdown', 390, 640, 1000))
    })
    expect(tab.setPointerCapture).toHaveBeenCalledWith(1)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 386, 620, 1020))
      window.dispatchEvent(pointer('pointermove', 240, 460, 1100))
      // Pause before release to place precisely without starting a glide.
      window.dispatchEvent(pointer('pointerup', 240, 460, 1250))
    })
    expect(parseFloat(layer.style.getPropertyValue('--qg-launcher-y'))).toBe(start - 180)
    expect(Number(localStorage.getItem('vault-launcher-position-v3'))).toBeGreaterThan(0)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('rolls back cancellation and lost capture without saving or opening', () => {
    renderNav()
    const tab = screen.getByRole('button', { name: 'Open navigation' })
    const layer = tab.parentElement!
    const start = layer.style.getPropertyValue('--qg-launcher-y')
    for (const end of ['pointercancel', 'lostpointercapture']) {
      act(() => {
        tab.dispatchEvent(pointer('pointerdown', 390, 640))
        window.dispatchEvent(pointer('pointermove', 390, 440))
        tab.dispatchEvent(pointer(end, 390, 440))
        fireEvent.click(tab, { detail: 1 })
      })
      expect(layer.style.getPropertyValue('--qg-launcher-y')).toBe(start)
      expect(localStorage.getItem('vault-launcher-position-v3')).toBeNull()
      expect(screen.queryByRole('navigation')).toBeNull()
    }
  })

  it('does not turn a vertical drag into a launcher tap', () => {
    renderNav()
    const tab = screen.getByRole('button', { name: 'Open navigation' })
    act(() => {
      tab.dispatchEvent(pointer('pointerdown', 390, 640))
      tab.dispatchEvent(pointer('pointermove', 390, 680))
      tab.dispatchEvent(pointer('pointerup', 390, 680))
      fireEvent.click(tab, { detail: 1 })
    })
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
  })
})

function pullTab(tab: HTMLElement, distance: number) {
  const startX = 390
  const y = 640
  act(() => {
    tab.dispatchEvent(pointer('pointerdown', startX, y))
    tab.dispatchEvent(pointer('pointermove', startX - distance, y))
    tab.dispatchEvent(pointer('pointerup', startX - distance, y))
  })
}

function pointer(type: string, clientX: number, clientY: number, timeStamp?: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId: 1,
    pointerType: 'touch',
  })
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  return event
}
