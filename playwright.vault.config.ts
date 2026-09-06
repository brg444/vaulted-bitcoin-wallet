import { defineConfig, devices } from '@playwright/test'

const appPort = Number(process.env.VAULT_E2E_PORT || 3003)
const operatorPort = Number(process.env.VAULT_E2E_OPERATOR_PORT || 18_888)
const appOrigin = `${process.env.HTTPS === 'true' ? 'https' : 'http'}://localhost:${appPort}`
const operatorOrigin = `http://127.0.0.1:${operatorPort}`

export default defineConfig({
  testDir: './.vault-browser-tests',
  globalSetup: './.vault-browser-tests/globalSetup.ts',
  testMatch: '**/*.test.ts',
  respectGitIgnore: false,
  snapshotPathTemplate: '{testDir}/../src/test/e2e-vault/{testFilePath}-snapshots/{arg}{-projectName}{-platform}{ext}',
  timeout: 60000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  expect: {
    toHaveScreenshot: {
      // Keep layout regressions strict while tolerating minor glyph rasterization
      // differences between ARM development containers and GitHub's x86 runner.
      maxDiffPixelRatio: 0.015,
    },
  },
  use: {
    baseURL: appOrigin,
    ignoreHTTPSErrors: process.env.HTTPS === 'true',
    headless: true,
    launchOptions: process.env.HTTPS === 'true' ? { args: ['--ignore-certificate-errors'] } : undefined,
    viewport: { width: 390, height: 844 },
    trace: 'on-first-retry',
    actionTimeout: 20000,
    navigationTimeout: 30000,
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: `export NODE_ENV=production VITE_VAULT_RELEASE_NETWORK=mutinynet VITE_GIT_COMMIT=vault-e2e VAULT_E2E_BUILD=arkade-vault-e2e-only VAULT_E2E_OPERATOR_ORIGIN=${operatorOrigin} VAULT_E2E_AUTHORIZER_PROXY_TARGET=${operatorOrigin} VAULT_E2E_ESPLORA_PROXY_TARGET=${operatorOrigin}; pnpm build:worker && pnpm exec vite -c vite.vault-e2e.config.ts --port ${appPort} --host localhost`,
    url: appOrigin,
    ignoreHTTPSErrors: process.env.HTTPS === 'true',
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'Mobile Safari service-worker smoke',
      testMatch: '**/vtxo-worker.test.ts',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'Mobile Safari installation',
      testMatch: '**/install.test.ts',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'Desktop Chromium accessibility and visual',
      grep: /@polish/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
})
