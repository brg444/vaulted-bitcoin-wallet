import { Themes } from '../types'
import { bootHaptics, setHapticsEnabled } from '../haptics'
import type { VaultBalanceUnit } from './fiatDisplay'

const THEME_KEY = 'arkade-vault-theme'
const HAPTICS_KEY = 'arkade-vault-haptics'
const PRIVACY_LOCK_KEY = 'arkade-vault-privacy-lock'
const BALANCE_UNIT_KEY = 'arkade-vault-balance-unit'
export function loadVaultTheme(): Themes {
  const raw = localStorage.getItem(THEME_KEY)
  if (raw === Themes.Dark || raw === Themes.Light || raw === Themes.Auto) return raw
  return Themes.Auto
}

export function loadVaultHaptics(): boolean {
  return localStorage.getItem(HAPTICS_KEY) !== '0'
}

export function loadVaultPrivacyLock(): boolean {
  return localStorage.getItem(PRIVACY_LOCK_KEY) === '1'
}

export function saveVaultPrivacyLock(on: boolean) {
  if (on) localStorage.setItem(PRIVACY_LOCK_KEY, '1')
  else localStorage.removeItem(PRIVACY_LOCK_KEY)
}

export function loadVaultBalanceUnit(): VaultBalanceUnit {
  return localStorage.getItem(BALANCE_UNIT_KEY) === 'usd' ? 'usd' : 'sats'
}

export function saveVaultBalanceUnit(unit: VaultBalanceUnit) {
  if (unit === 'usd') localStorage.setItem(BALANCE_UNIT_KEY, 'usd')
  else localStorage.removeItem(BALANCE_UNIT_KEY)
}

export function systemTheme(): Themes.Dark | Themes.Light {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? Themes.Dark : Themes.Light
}

export function resolveVaultTheme(theme: Themes): Themes.Dark | Themes.Light {
  return theme === Themes.Auto ? systemTheme() : (theme as Themes.Dark | Themes.Light)
}

export function applyVaultTheme(theme: Themes) {
  const resolved = resolveVaultTheme(theme)
  document.documentElement.classList.toggle('palette-dark', resolved === Themes.Dark)
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === Themes.Dark ? '#0e0d10' : '#fff')
}

export function saveVaultTheme(theme: Themes) {
  localStorage.setItem(THEME_KEY, theme)
  applyVaultTheme(theme)
}

export function saveVaultHaptics(on: boolean) {
  localStorage.setItem(HAPTICS_KEY, on ? '1' : '0')
  setHapticsEnabled(on)
}

let prefsBooted = false

export function bootVaultPrefs() {
  applyVaultTheme(loadVaultTheme())
  setHapticsEnabled(loadVaultHaptics())
  bootHaptics()
  if (prefsBooted || typeof window.matchMedia !== 'function') return
  prefsBooted = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (loadVaultTheme() === Themes.Auto) applyVaultTheme(Themes.Auto)
  })
}
