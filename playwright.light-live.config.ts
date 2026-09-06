import { defineConfig } from '@playwright/test'
import base from './playwright.vault.config'

if (process.env.VAULT_LIGHT_LIVE !== 'mutinynet')
  throw new Error('This funded browser drill requires VAULT_LIGHT_LIVE=mutinynet')
if (!process.env.VAULT_LIGHT_DRILL_DIRECTORY?.startsWith('/'))
  throw new Error('An absolute private drill directory is required')
const origin = 'https://localhost:3120'
export default defineConfig({
  ...base,
  projects: base.projects?.filter((project) => project.name === 'Mobile Chrome'),
  testMatch: '**/light-funded.test.ts',
  timeout: 240000,
  use: {
    ...base.use,
    baseURL: origin,
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command:
      'export NODE_ENV=production HTTPS=true VITE_VAULT_RELEASE_NETWORK=mutinynet VAULT_E2E_BUILD=arkade-vault-e2e-only VAULT_E2E_OPERATOR_ORIGIN=https://mutinynet.arkade.sh VAULT_E2E_AUTHORIZER_PROXY_TARGET=http://127.0.0.1:18899 VAULT_E2E_ESPLORA_PROXY_TARGET=https://mutinynet.com; pnpm build:worker && pnpm exec vite -c vite.vault-e2e.config.ts --port 3120 --host localhost',
    url: origin,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120000,
  },
})
