import { test, expect } from './fixtures/passkey'
import { lightTestEnrollment, lightTestStatus } from '../../lib/vault/light/testdata/helpers'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

// UI-only fixtures: render the real Light screens with deterministic data. No signing,
// enrollment, broadcast, or recovery is exercised by this suite.
async function override(page: Page, path: string, exports: Record<string, string>) {
  await page.route(`**/src/${path}*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has('light-ui-original')) return route.continue()
    await route.fulfill({
      contentType: 'application/javascript',
      body: `export * from '/src/${path}?light-ui-original';\n${Object.entries(exports)
        .map(([name, value]) => `export const ${name} = ${value};`)
        .join('\n')}`,
    })
  })
}
async function openLight(page: Page, watch = false, local = false) {
  const record = await lightTestEnrollment()
  const status = lightTestStatus(record.descriptor)
  const history = [
    {
      account: 'spend',
      txid: 'ab'.repeat(32),
      amount: 12000,
      type: 'received',
      confirmed: true,
      blockTime: 1788739200,
    },
    { account: 'spend', txid: 'cd'.repeat(32), amount: 2000, type: 'sent', confirmed: false },
  ]
  await override(page, 'lib/vault/light/enrollment.ts', { loadLightEnrollment: `() => (${JSON.stringify(record)})` })
  await override(page, 'lib/vault/status.ts', { fetchVaultStatusUnpinned: `async () => (${JSON.stringify(status)})` })
  await override(page, 'lib/vault/light/cloudBackup.ts', {
    openLightCloudBackup: `async () => ({record:${JSON.stringify(record)}})`,
  })
  await override(page, 'lib/vault/recovery/capture.ts', {
    syncCompleteLightBackup: `async () => ({createdAt:'2026-09-07T00:00:00Z'})`,
  })
  await override(page, 'lib/vault/light/recoveryArchive.ts', {
    captureLightRecoveryArchive: `async () => ({coins:[],capturedAt:'2026-09-07T00:00:00Z'})`,
  })
  await override(page, 'lib/vault/light/backupScheduler.ts', {
    lightBackupScheduler: `() => ({request(){},dispose(){}})`,
  })
  await override(page, 'lib/vault/vtxo/walletWorker.ts', {
    fetchVaultWalletVtxoSnapshot: `async () => ({balance:12000,pendingBalance:2000,recoveryVtxos:[],history:${JSON.stringify(history)}})`,
    subscribeVaultWalletEvents: `() => () => {}`,
    shutdownVaultWalletWorker: `async () => {}`,
  })
  await override(page, 'lib/vault/vtxo/spend.ts', {
    reconcilePersistedVtxoSpend: `async () => {}`,
    reserveVaultVtxo: `async (_record,_status,address,amount) => ({destAddress:address,amountSats:amount,feeSats:20})`,
    sendVaultVtxo: `async () => ({txid:'${'ef'.repeat(32)}'})`,
  })
  await override(page, 'lib/fiat.ts', { getPriceFeed: `async () => ({usd:100000})` })
  if (watch) {
    await override(page, 'lib/vault/light/watchSavings.ts', {
      loadWatchedSavings: `() => ({address:'tb1q-watch-only-ui-fixture',network:'mutinynet',label:'Savings'})`,
      fetchWatchedSavings: `async () => ({balance:1234567890,history:${JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ ...history[0], account: 'savings', txid: index.toString(16).padStart(64, '0') })))}})`,
    })
  }
  if (local) {
    await override(page, 'lib/vault/light/passkey.ts', {
      unlockLightWithPasskey: `async () => new Uint8Array(32).fill(1)`,
    })
    await override(page, 'lib/vault/light/guardianDelegation.ts', { authorizeGuardianRenewals: `async () => null` })
  }
  await page.addInitScript(() => localStorage.setItem('vaulted:active-setup', 'light'))
  await page.goto('/')
  if (local) {
    await page.getByText('Use a local passkey', { exact: true }).click()
    await page.getByRole('button', { name: 'Unlock on this device', exact: true }).click()
  } else await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
  await expect(page.getByTestId('vault-balance')).toHaveText('₿14,000')
}
async function launcher(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
}

test('@polish Light balance, history, settings and payment navigation stay accessible', async ({
  page,
  authorizer,
}, testInfo) => {
  void authorizer
  if (!testInfo.project.name.includes('Desktop')) await page.setViewportSize({ width: 375, height: 667 })
  await openLight(page)
  await expect(page.getByText('12,000 sats available · 2,000 sats pending')).toBeVisible()
  await expect(page.locator('.qg-home [data-testid="vault-history"]')).toBeVisible()
  await expect(page.getByTestId(`vault-tx-${'ab'.repeat(32)}`)).toBeInViewport()
  expect(await page.getByTestId('vault-balance').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await expect(page).toHaveScreenshot('light-home.png', { animations: 'disabled' })
  await page.getByTestId('vault-balance').click()
  await expect(page.getByTestId('vault-balance')).toHaveAttribute('data-balance-unit', 'usd')
  await expect(page.getByTestId('vault-balance')).toContainText('14')
  await page.getByTestId('vault-balance').click()
  await page.getByTestId(`vault-tx-${'ab'.repeat(32)}`).click()
  await expect(page.getByRole('heading', { name: 'Confirmed' })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await launcher(page, 'Settings')
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await expect(page.getByTestId('settings-haptics')).toBeVisible()
  await expect(page.getByTestId('settings-signout')).toHaveCount(0)
  await expect(page.getByTestId('settings-privacy-lock')).toHaveCount(0)
  await expect(page).toHaveScreenshot('light-settings.png', { animations: 'disabled' })
  await page.getByTestId('settings-about').click()
  await expect(page.getByText('Light — passkey payments')).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByTestId('settings-theme').click()
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page).toHaveScreenshot('light-home-dark.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('textbox', { name: 'Arkade address' }).fill('draft address')
  await page.getByRole('button', { name: 'Scan address', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Arkade address' })).toHaveValue('draft address')
  await page.getByRole('spinbutton', { name: 'Amount, in sats' }).fill('1000')
  await page.getByRole('button', { name: 'Review payment' }).click()
  await expect(page.getByText('Total: 1,020 sats')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve 1,000 sats' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Approve 1,000 sats' }).click()
  await expect(page.getByRole('heading', { name: 'Payment sent', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copy receiving address' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await launcher(page, 'Savings')
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
  await launcher(page, 'Settings')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
  await launcher(page, 'Security')
  for (const name of ['Access and limits', 'Automatic renewal', 'Backups']) {
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByRole('button', { name: 'Lock wallet' })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Go back', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Lock wallet' }).click()
  await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible()
  await expect(page.getByTestId('vault-balance')).toHaveCount(0)
})

test('Light watched Savings stays readable at 320px and returns to its account from Settings', async ({
  page,
  authorizer,
}) => {
  void authorizer
  await page.setViewportSize({ width: 320, height: 640 })
  await openLight(page, true, true)
  await launcher(page, 'Savings')
  await expect(page.getByTestId('vault-balance')).toHaveText('₿1,234,567,890')
  expect(await page.getByTestId('vault-balance').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(await page.locator('.light-app').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  await page.locator('.vault-history-row').last().scrollIntoViewIfNeeded()
  await expect(page.locator('.vault-history-row').last()).toBeInViewport()
  await launcher(page, 'Settings')
  await page.getByTestId('settings-diagnostics').click()
  await page.getByTestId('settings-refresh').click()
  await expect(page.getByText('Balance updated', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss notice' }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
})
