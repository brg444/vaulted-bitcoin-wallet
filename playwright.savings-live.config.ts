import { defineConfig } from '@playwright/test'
import base from './playwright.vault.config'
if (process.env.VAULT_SAVINGS_SETUP_LIVE !== 'mutinynet' || !process.env.VAULT_SAVINGS_SETUP_DIRECTORY?.startsWith('/'))
  throw new Error('This funded drill requires explicit Mutinynet mode and a private absolute directory')
export default defineConfig({
  ...base,
  projects: base.projects?.filter((p) => p.name === 'Mobile Chrome'),
  testMatch: '**/savings-setup-funded.test.ts',
  timeout: 600000,
  use: { ...base.use, baseURL: 'https://localhost:53290', trace: 'off', screenshot: 'off' },
  webServer: {
    command:
      'export NODE_ENV=production HTTPS=true VITE_VAULT_RELEASE_NETWORK=mutinynet VAULT_E2E_BUILD=arkade-vault-e2e-only VAULT_E2E_OPERATOR_ORIGIN=https://mutinynet.arkade.sh VAULT_E2E_AUTHORIZER_PROXY_TARGET=http://127.0.0.1:53291 VAULT_E2E_ESPLORA_PROXY_TARGET=https://mutinynet.com; ' +
      (process.env.VAULT_SAVINGS_SETUP_REUSE_WORKER === '1' ? '' : 'pnpm build:worker && ') +
      'pnpm exec vite -c vite.vault-e2e.config.ts --port 53290 --host localhost',
    url: 'https://localhost:53290',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120000,
  },
})
