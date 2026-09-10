import { WebHaptics } from 'web-haptics'

let enabled = true
let haptics: WebHaptics | null = null

export function setHapticsEnabled(value: boolean): void {
  enabled = value
}

function getHaptics(): WebHaptics | null {
  if (haptics) return haptics
  if (typeof window === 'undefined') return null
  haptics = new WebHaptics()
  return haptics
}

export function bootHaptics(): void {
  // Feedback must never replace a control's native pointer target.
  getHaptics()
}

function shouldSkipHaptics(): boolean {
  if (!enabled) return true
  if (typeof window === 'undefined') return true
  // Reduced motion controls animation, not the user's explicit tactile preference.
  return false
}

function triggerHaptic(pattern: 'selection' | 'light' | 'medium'): void {
  if (shouldSkipHaptics()) return
  getHaptics()
    ?.trigger(pattern)
    .catch(() => {})
}

export function hapticTap(): void {
  triggerHaptic('selection')
}

export function hapticLight(): void {
  triggerHaptic('light')
}

export function hapticSubtle(): void {
  triggerHaptic('selection')
}
