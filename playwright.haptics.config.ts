import base from './playwright.vault.config'
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ ...base, projects: [{ name: 'iPhone WebKit', use: { ...devices['iPhone 13'] } }] })
