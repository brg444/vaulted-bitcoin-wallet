import { afterEach, describe, expect, it, vi } from 'vitest'
import { animateScreenEntrance } from './useScreenMotion'

function surface() {
  const node = document.createElement('div')
  const animation = Object.assign(new EventTarget(), { cancel: vi.fn() })
  node.animate = vi.fn(() => animation as unknown as Animation)
  return { node, animation }
}

const cleanups: ((() => void) | undefined)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop?.())
  vi.unstubAllGlobals()
})

describe('screen entrance ownership', () => {
  it.each(['pointerdown', 'keydown'])('settles on %s without consuming the input', (type) => {
    const { node, animation } = surface()
    cleanups.push(animateScreenEntrance(node, 'translateX(20px)'))
    const event = new Event(type, { bubbles: true, cancelable: true })
    node.dispatchEvent(event)
    expect(animation.cancel).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
  })

  it('replaces an inner title entrance with the route entrance', () => {
    const outer = surface()
    const inner = surface()
    outer.node.append(inner.node)
    cleanups.push(animateScreenEntrance(inner.node, 'translateY(8px)'))
    cleanups.push(animateScreenEntrance(outer.node, 'translateX(20px)'))
    expect(inner.animation.cancel).toHaveBeenCalledOnce()
    expect(outer.node.animate).toHaveBeenCalledOnce()
    expect(animateScreenEntrance(inner.node, 'translateY(8px)')).toBeUndefined()
    expect(inner.node.animate).toHaveBeenCalledOnce()
  })

  it('releases a finished route before a subsequent local transition', () => {
    const outer = surface()
    const inner = surface()
    outer.node.append(inner.node)
    cleanups.push(animateScreenEntrance(outer.node, 'translateX(20px)'))
    outer.animation.dispatchEvent(new Event('finish'))
    cleanups.push(animateScreenEntrance(inner.node, 'translateY(8px)'))
    expect(inner.node.animate).toHaveBeenCalledOnce()
  })

  it('renders directly when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { node } = surface()
    expect(animateScreenEntrance(node, 'translateX(20px)')).toBeUndefined()
    expect(node.animate).not.toHaveBeenCalled()
  })
})
