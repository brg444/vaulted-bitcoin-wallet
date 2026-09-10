import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Fiats } from '../types'
import { useDisplayUnit } from './useDisplayUnit'

const { price } = vi.hoisted(() => ({ price: { current: 100_000 as number | undefined } }))

vi.mock('../fiat', () => ({
  getPriceFeed: vi.fn(async () => ({
    eur: 0,
    usd: price.current,
    chf: 0,
    jpy: 0,
    gbp: 0,
    cny: 0,
  })),
}))

function Probe({ id }: { id: string }) {
  const { unit, rate, rateStatus, setUnit } = useDisplayUnit()
  return (
    <div>
      <span data-testid={`${id}-unit`}>{unit}</span>
      <span data-testid={`${id}-rate`}>{rate ? String(rate.pricePerBtc) : 'none'}</span>
      <span data-testid={`${id}-status`}>{rateStatus}</span>
      <button type='button' onClick={() => void setUnit('usd')}>
        {id}-to-usd
      </button>
      <button type='button' onClick={() => void setUnit('sats')}>
        {id}-to-sats
      </button>
    </div>
  )
}

const text = (id: string) => screen.getByTestId(id).textContent

beforeEach(() => {
  localStorage.clear()
  price.current = 100_000
})

afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('useDisplayUnit', () => {
  it('starts on the saved preference and restores the USD rate', async () => {
    localStorage.setItem('arkade-vault-balance-unit', 'usd')
    render(<Probe id='a' />)
    await act(async () => {})
    expect(text('a-unit')).toBe('usd')
    expect(text('a-rate')).toBe('100000')
    expect(text('a-status')).toBe('ready')
  })

  it('keeps the saved preference when the rate is unavailable', async () => {
    price.current = undefined
    render(<Probe id='a' />)
    await act(async () => {
      screen.getByText('a-to-usd').click()
    })
    expect(text('a-unit')).toBe('usd')
    expect(text('a-rate')).toBe('none')
    expect(text('a-status')).toBe('unavailable')
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
  })

  it('gives a second mounted consumer the rate after a broadcast unit change', async () => {
    render(
      <>
        <Probe id='a' />
        <Probe id='b' />
      </>,
    )
    await act(async () => {
      screen.getByText('a-to-usd').click()
    })
    expect(text('a-unit')).toBe('usd')
    expect(text('b-unit')).toBe('usd')
    expect(text('b-rate')).toBe('100000')
    expect(text('b-status')).toBe('ready')
  })

  it('ignores a stale USD load that resolves after switching back to sats', async () => {
    const { getPriceFeed } = await import('../fiat')
    let resolvePrice!: (value: { usd: number }) => void
    vi.mocked(getPriceFeed).mockImplementationOnce(
      () => new Promise((resolve) => void (resolvePrice = resolve)) as never,
    )
    const cleared = vi.fn()
    function Clearing() {
      const { unit, rateStatus, setUnit } = useDisplayUnit({ clearRate: cleared })
      return (
        <div>
          <span data-testid='c-unit'>{unit}</span>
          <span data-testid='c-status'>{rateStatus}</span>
          <button type='button' onClick={() => void setUnit('usd')}>
            c-to-usd
          </button>
          <button type='button' onClick={() => void setUnit('sats')}>
            c-to-sats
          </button>
        </div>
      )
    }
    render(<Clearing />)
    await act(async () => {
      screen.getByText('c-to-usd').click()
    })
    expect(text('c-status')).toBe('loading')
    await act(async () => {
      screen.getByText('c-to-sats').click()
    })
    await act(async () => {
      resolvePrice({ usd: 100_000 } as never)
    })
    expect(text('c-unit')).toBe('sats')
    expect(text('c-status')).toBe('idle')
    expect(cleared).toHaveBeenCalled()
  })

  it('surfaces rejected rate loaders as unavailable without unhandled rejections', async () => {
    const { getPriceFeed } = await import('../fiat')
    vi.mocked(getPriceFeed).mockRejectedValueOnce(new Error('offline'))
    render(<Probe id='a' />)
    await act(async () => {
      screen.getByText('a-to-usd').click()
    })
    expect(text('a-status')).toBe('unavailable')
    expect(localStorage.getItem('arkade-vault-balance-unit')).toBe('usd')
  })

  it('uses an injected provider rate for status without refetching', async () => {
    const ensureRate = vi.fn(async () => ({ currency: Fiats.USD, pricePerBtc: 125_000 }))
    const { getPriceFeed } = await import('../fiat')
    function Injected() {
      const { rate, rateStatus, setUnit } = useDisplayUnit({
        rate: { currency: Fiats.USD, pricePerBtc: 125_000 },
        ensureRate,
      })
      return (
        <div>
          <span data-testid='d-rate'>{rate ? String(rate.pricePerBtc) : 'none'}</span>
          <span data-testid='d-status'>{rateStatus}</span>
          <button type='button' onClick={() => void setUnit('usd')}>
            d-to-usd
          </button>
        </div>
      )
    }
    render(<Injected />)
    await act(async () => {
      screen.getByText('d-to-usd').click()
    })
    expect(ensureRate).toHaveBeenCalled()
    expect(vi.mocked(getPriceFeed)).not.toHaveBeenCalled()
    expect(text('d-rate')).toBe('125000')
    expect(text('d-status')).toBe('ready')
  })
})
