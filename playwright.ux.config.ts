import { defineConfig, devices } from '@playwright/test'
import base from './playwright.vault.config'

// These suites use local fixtures, including bound synthetic Lightning addresses.
process.env.VITE_VAULT_LIGHTNING_RECEIVE = 'true'
process.env.VITE_VAULT_LNURL = 'true'

export default defineConfig({
  ...base,
  grep: /@ux-|@design-review/,
  projects: [
    { name: 'UX Chromium', use: { ...devices['Pixel 7'] } },
    { name: 'UX Safari', use: { ...devices['iPhone 13'] } },
  ],
})
