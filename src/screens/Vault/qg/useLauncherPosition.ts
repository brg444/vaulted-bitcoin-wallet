import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { hapticSubtle } from '../../../lib/haptics'
import { launcherCoast, launcherReleaseVelocity, type LauncherSample } from './launcherMomentum'

const KEY = 'vault-launcher-position-v3'
const HEIGHT = 62
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value))

function readPosition() {
  try {
    const value = localStorage.getItem(KEY)
    if (value === null || value.trim() === '') return null
    const ratio = Number(value)
    return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null
  } catch {
    return null
  }
}

/** One captured gesture: tap to open, vertical drag to place, left pull to peek. */
export function useLauncherPosition(
  layer: RefObject<HTMLDivElement>,
  setPull: (progress: number) => void,
  open: () => void,
) {
  const ratio = useRef(readPosition())
  const y = useRef(0)
  const [upper, setUpper] = useState(false)
  const cancel = useRef<() => void>(() => {})
  const stopCoast = useRef<() => boolean>(() => false)
  const suppressClick = useRef(false)

  const bounds = () => {
    const element = layer.current
    const style = element ? getComputedStyle(element) : null
    const height = element?.getBoundingClientRect().height || window.innerHeight
    const min = parseFloat(style?.paddingTop || '') || 16
    const inset = parseFloat(style?.paddingBottom || '') || 16
    return { min, max: Math.max(min, height - HEIGHT - inset), height, inset }
  }
  const place = (next: number) => {
    y.current = next
    layer.current?.style.setProperty('--qg-launcher-y', `${next}px`)
    setUpper(next + HEIGHT / 2 < bounds().height / 2)
  }
  const savePosition = (next: number) => {
    place(next)
    const { min, max } = bounds()
    ratio.current = max === min ? 0 : clamp((next - min) / (max - min), 0, 1)
    try {
      localStorage.setItem(KEY, String(ratio.current))
    } catch {
      // Placement remains available when storage is disabled.
    }
  }

  const coast = (button: HTMLButtonElement, from: number, velocity: number) => {
    const { min, max } = bounds()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sample = reducedMotion.matches ? null : launcherCoast(from, velocity, min, max)
    if (!sample) {
      savePosition(from)
      return
    }
    const started = performance.now()
    let next = from
    let frame = 0
    let active = true
    button.classList.add('is-repositioning', 'is-coasting')
    const stop = () => {
      if (!active) return false
      active = false
      cancelAnimationFrame(frame)
      window.removeEventListener('blur', stop)
      window.removeEventListener('pagehide', stop)
      document.removeEventListener('visibilitychange', visibility)
      reducedMotion.removeEventListener('change', motionChanged)
      savePosition(next)
      button.style.removeProperty('--qg-launcher-drag-y')
      button.classList.remove('is-repositioning', 'is-coasting')
      return true
    }
    const visibility = () => {
      if (document.hidden) stop()
    }
    const motionChanged = () => {
      if (reducedMotion.matches) stop()
    }
    const tick = (now: number) => {
      if (!active) return
      const position = sample(now - started)
      next = position.y
      button.style.setProperty('--qg-launcher-drag-y', `${next - from}px`)
      if (position.done) stop()
      else frame = requestAnimationFrame(tick)
    }
    stopCoast.current = stop
    window.addEventListener('blur', stop)
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', visibility)
    reducedMotion.addEventListener('change', motionChanged)
    frame = requestAnimationFrame(tick)
  }

  useLayoutEffect(() => {
    const resize = () => {
      stopCoast.current()
      cancel.current()
      const { min, max, height, inset } = bounds()
      place(
        ratio.current === null
          ? clamp(height - HEIGHT - Math.max(52, inset + 12), min, max)
          : min + ratio.current * (max - min),
      )
    }
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (layer.current) observer?.observe(layer.current)
    window.addEventListener('resize', resize)
    return () => {
      stopCoast.current()
      cancel.current()
      observer?.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return
    const caughtCoast = stopCoast.current()
    cancel.current()
    const button = event.currentTarget
    const id = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const startTop = y.current
    const limits = bounds()
    let axis: 'vertical' | 'horizontal' | null = null
    let next = startTop
    let travel = 0
    let frame = 0
    let active = true
    let samples: LauncherSample[] = [{ y: startTop, time: event.timeStamp }]
    suppressClick.current = caughtCoast
    try {
      button.setPointerCapture(id)
    } catch {
      // Window listeners retain the gesture when a browser declines capture.
    }

    const paint = () => {
      frame = 0
      button.style.setProperty('--qg-launcher-drag-y', `${next - startTop}px`)
    }
    const finish = (commit: boolean, releasedAt = 0) => {
      if (!active) return
      active = false
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', interrupted)
      window.removeEventListener('blur', interrupted)
      button.removeEventListener('lostpointercapture', interrupted)
      button.classList.remove('is-repositioning')
      if (axis === 'vertical' && commit) {
        place(next)
        hapticSubtle()
      }
      button.style.removeProperty('--qg-launcher-drag-y')
      if (!commit) suppressClick.current = true
      if (axis === 'horizontal' && commit && travel >= 52) open()
      else setPull(0)
      if (button.hasPointerCapture?.(id)) button.releasePointerCapture(id)
      if (axis === 'vertical' && commit) coast(button, next, launcherReleaseVelocity(samples, releasedAt))
    }
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== id) return
      const dx = pointer.clientX - startX
      const dy = pointer.clientY - startY
      if (!axis) {
        if (Math.hypot(dx, dy) < 8) return
        if (Math.abs(dy) >= Math.abs(dx)) axis = 'vertical'
        else if (dx < -12 && -dx > Math.abs(dy) * 1.25) axis = 'horizontal'
        else {
          // Ambiguous motion waits for a direction without turning into a tap.
          suppressClick.current = true
          return
        }
        suppressClick.current = true
        if (axis === 'vertical') button.classList.add('is-repositioning')
      }
      pointer.preventDefault()
      if (axis === 'vertical') {
        next = clamp(startTop + dy, limits.min, limits.max)
        // Retain the sample before the window for interpolation, including sparse touch events.
        while (samples.length > 1 && samples[1].time < pointer.timeStamp - 100) samples.shift()
        const last = samples[samples.length - 1]
        const previous = samples[samples.length - 2]
        if (previous && last && (next - last.y) * (last.y - previous.y) < 0) samples = [last]
        samples.push({ y: next, time: pointer.timeStamp })
        if (!frame) frame = requestAnimationFrame(paint)
      } else {
        travel = Math.max(0, -dx)
        setPull(Math.min(1, travel / 96))
      }
    }
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== id) return
      move(pointer)
      finish(true, pointer.timeStamp)
    }
    const interrupted = (pointer: Event) => {
      if ('pointerId' in pointer && pointer.pointerId !== id) return
      finish(false)
    }
    cancel.current = () => finish(false)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', interrupted)
    window.addEventListener('blur', interrupted)
    button.addEventListener('lostpointercapture', interrupted)
  }

  return {
    upper,
    onPointerDown,
    onClick(event: React.MouseEvent<HTMLButtonElement>) {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault()
        suppressClick.current = false
        return
      }
      stopCoast.current()
      open()
    },
    onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      stopCoast.current()
      cancel.current()
      const { min, max } = bounds()
      savePosition(clamp(y.current + (event.key === 'ArrowUp' ? -32 : 32), min, max))
    },
  }
}
