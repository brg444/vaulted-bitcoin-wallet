import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QgScreen from './QgScreen'

describe('QgScreen input viewport lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the focused field visible on keyboard resize and stops after blur', () => {
    const listeners = new Map<string, EventListener>()
    vi.stubGlobal('visualViewport', {
      height: 420,
      addEventListener(name: string, listener: EventListener) {
        listeners.set(name, listener)
      },
      removeEventListener(name: string) {
        listeners.delete(name)
      },
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const scrollIntoView = vi.fn()
    const scrollBy = vi.fn()

    render(
      <QgScreen title='Send' footer={<button>Review</button>}>
        <input aria-label='To' />
      </QgScreen>,
    )
    const input = screen.getByLabelText('To')
    const main = screen.getByRole('main')
    Object.defineProperty(input, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    Object.defineProperty(input, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 390, bottom: 440 }),
    })
    Object.defineProperty(main, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 60, bottom: 410 }),
    })
    Object.defineProperty(main, 'scrollBy', { configurable: true, value: scrollBy })
    act(() => input.focus())
    listeners.get('resize')?.(new Event('resize'))
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(scrollBy).toHaveBeenCalledWith({ top: 42, behavior: 'smooth' })
    expect(scrollIntoView).not.toHaveBeenCalled()

    scrollBy.mockClear()
    act(() => input.blur())
    listeners.get('resize')?.(new Event('resize'))
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('cancels a queued focus scroll when the screen unmounts', () => {
    vi.stubGlobal('visualViewport', { addEventListener() {}, removeEventListener() {} })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const { unmount } = render(
      <QgScreen title='Send'>
        <input aria-label='To' />
      </QgScreen>,
    )
    fireEvent.focus(screen.getByLabelText('To'))
    unmount()
    expect(cancel).toHaveBeenCalled()
  })
})

function sheetPointer(target: HTMLElement, type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: 180, clientY: y, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  act(() => target.dispatchEvent(event))
}

describe('sheet gesture intent', () => {
  it('keeps body drags inside the form and dismisses from the header', () => {
    const dismiss = vi.fn()
    render(
      <QgScreen title='Send' dismiss={dismiss}>
        <input aria-label='Amount' />
      </QgScreen>,
    )
    const input = screen.getByRole('textbox')
    sheetPointer(input, 'pointerdown', 100)
    sheetPointer(input, 'pointermove', 230)
    sheetPointer(input, 'pointerup', 230)
    expect(dismiss).not.toHaveBeenCalled()
    const title = screen.getByTestId('screen-title')
    sheetPointer(title, 'pointerdown', 30)
    sheetPointer(title, 'pointermove', 140)
    sheetPointer(title, 'pointerup', 140)
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('returns a cancelled sheet to rest and keeps the Back button usable', () => {
    const dismiss = vi.fn()
    render(
      <QgScreen title='Send' dismiss={dismiss}>
        <input aria-label='Amount' />
      </QgScreen>,
    )
    const title = screen.getByTestId('screen-title')
    sheetPointer(title, 'pointerdown', 30)
    sheetPointer(title, 'pointermove', 140)
    sheetPointer(title, 'pointercancel', 140)
    expect(dismiss).not.toHaveBeenCalled()
    expect(title.closest('.qg-screen')).toHaveStyle({ transform: '' })
    const back = screen.getByRole('button', { name: 'Go back' })
    sheetPointer(back, 'pointerdown', 30)
    sheetPointer(back, 'pointerup', 30)
    fireEvent.click(back)
    expect(dismiss).toHaveBeenCalledOnce()
  })
})

it('keeps an in-progress form mounted while Help opens and closes', () => {
  const dismiss = vi.fn()
  render(
    <QgScreen title='Send' dismiss={dismiss}>
      <input aria-label='Draft destination' />
    </QgScreen>,
  )
  const input = screen.getByLabelText('Draft destination')
  fireEvent.change(input, { target: { value: 'saved-destination' } })
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(screen.getByRole('dialog')).toBeVisible()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(dismiss).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close help' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByLabelText('Draft destination')).toBe(input)
  expect(input).toHaveValue('saved-destination')
  expect(screen.getByRole('button', { name: 'Help' })).toHaveFocus()
})
