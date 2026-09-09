import { useEffect, type RefObject } from 'react'

/** Light follows gestures and content; no animation loop runs while the wallet is idle. */
export function useLauncherGlass(layer: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let point: { x: number; y: number } | null = null
    let scroll = 0
    const paint = () => {
      frame = 0
      const button = layer.current?.querySelector<HTMLElement>('.qg-launcher-trigger')
      if (!button || motion.matches) return
      const bounds = button.getBoundingClientRect()
      const x = point
        ? Math.max(-20, Math.min(120, ((point.x - bounds.left) / bounds.width) * 100))
        : 30 + Math.sin(scroll / 95) * 45
      const y = point
        ? Math.max(-30, Math.min(130, ((point.y - bounds.top) / bounds.height) * 100))
        : 30 + Math.cos(scroll / 130) * 55
      button.style.setProperty('--glass-x', `${(x + Math.sin((bounds.top + scroll) / 65) * 30).toFixed(1)}%`)
      button.style.setProperty('--glass-y', `${(y + Math.cos((bounds.top + scroll) / 85) * 40).toFixed(1)}%`)
      button.style.setProperty(
        '--glass-angle',
        `${(110 + (y - 50) * 0.55 + Math.sin(bounds.top / 80) * 35).toFixed(1)}deg`,
      )
    }
    const schedule = () => {
      if (!motion.matches && !frame) frame = requestAnimationFrame(paint)
    }
    const pointer = (event: PointerEvent) => {
      const button = layer.current?.querySelector('.qg-launcher-trigger')
      if (
        !button ||
        (!(event.target instanceof Node && button.contains(event.target)) &&
          !button.classList.contains('is-repositioning'))
      )
        return
      point = { x: event.clientX, y: event.clientY }
      schedule()
    }
    const contentScroll = (event: Event) => {
      if (event.target instanceof HTMLElement) scroll = event.target.scrollTop
      else scroll = window.scrollY
      point = null
      schedule()
    }
    const reset = () => {
      if (motion.matches) {
        cancelAnimationFrame(frame)
        frame = 0
        const button = layer.current?.querySelector<HTMLElement>('.qg-launcher-trigger')
        for (const name of ['--glass-x', '--glass-y', '--glass-angle']) button?.style.removeProperty(name)
      }
    }
    window.addEventListener('pointermove', pointer, { passive: true })
    window.addEventListener('scroll', contentScroll, { passive: true, capture: true })
    motion.addEventListener('change', reset)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', pointer)
      window.removeEventListener('scroll', contentScroll, true)
      motion.removeEventListener('change', reset)
    }
  }, [layer])
}
