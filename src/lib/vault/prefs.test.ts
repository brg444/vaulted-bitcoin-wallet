import { describe, expect, it } from 'vitest'
import { Themes } from '../types'
import {
  applyVaultTheme,
  loadVaultBalanceUnit,
  loadVaultPrivacyLock,
  loadVaultTheme,
  saveVaultBalanceUnit,
  saveVaultPrivacyLock,
  saveVaultTheme,
} from './prefs'

if (typeof window === 'undefined') {
  const store = new Map<string, string>()
  const classes = new Set<string>()
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    clear: () => store.clear(),
  }
  const documentElement = {
    classList: {
      remove: (c: string) => void classes.delete(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !classes.has(c)
        if (on) classes.add(c)
        else classes.delete(c)
      },
      contains: (c: string) => classes.has(c),
    },
  }
  Object.assign(globalThis, {
    localStorage,
    window: { localStorage, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { documentElement, querySelector: () => null },
  })
}

describe('vault prefs', () => {
  it('persists theme and toggles the dark palette', () => {
    window.localStorage.clear()
    document.documentElement.classList.remove('palette-dark')
    saveVaultTheme(Themes.Dark)
    expect(loadVaultTheme()).toBe(Themes.Dark)
    expect(document.documentElement.classList.contains('palette-dark')).toBe(true)
    applyVaultTheme(Themes.Light)
    expect(document.documentElement.classList.contains('palette-dark')).toBe(false)
  })

  it('keeps passkey privacy lock off until it is turned on', () => {
    window.localStorage.clear()
    expect(loadVaultPrivacyLock()).toBe(false)
    saveVaultPrivacyLock(true)
    expect(loadVaultPrivacyLock()).toBe(true)
    saveVaultPrivacyLock(false)
    expect(loadVaultPrivacyLock()).toBe(false)
  })

  it('keeps Home on sats until USD is chosen', () => {
    window.localStorage.clear()
    expect(loadVaultBalanceUnit()).toBe('sats')
    saveVaultBalanceUnit('usd')
    expect(loadVaultBalanceUnit()).toBe('usd')
    saveVaultBalanceUnit('sats')
    expect(loadVaultBalanceUnit()).toBe('sats')
  })
})
