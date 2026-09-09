import { lightTestStatus } from '../../lib/vault/light/testdata/helpers'
import { expectWalletLayout } from './fixtures/layout'
import { test, expect } from './fixtures/passkey'
import { openLight } from './fixtures/light-ui'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

async function launcher(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
}

test('@ux-shared Light resumes its saved payment through review and returns to the same home notice', async ({
  page,
  authorizer,
}) => {
  void authorizer
  await page.setViewportSize({ width: 320, height: 667 })
  await openLight(page, false, false, undefined, {
    amountSats: 1000,
    destAddress: lightTestStatus().spendingArkAddress!,
    feeSats: 20,
  })
  await expect(page.getByRole('region', { name: 'Pending payment' })).toContainText('₿1,000')
  await page.getByRole('button', { name: 'Resume payment', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Resume payment' })).toBeVisible()
  await page.getByRole('button', { name: 'Reveal', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Payment details' }).locator('strong').first()).toContainText(
    lightTestStatus().spendingArkAddress!,
  )
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
  await expectWalletLayout(page)
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume payment', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resume payment', exact: true }).click()
  await page.getByRole('button', { name: 'Continue payment' }).click()
  await expect(page.getByRole('heading', { name: 'Payment sent', exact: true })).toBeVisible()
})

test('@ux-shared @polish Light balance, history, settings and payment navigation stay accessible', async ({
  page,
  authorizer,
}, testInfo) => {
  void authorizer
  if (!testInfo.project.name.includes('Desktop')) await page.setViewportSize({ width: 375, height: 667 })
  await openLight(page)
  await expect(page.getByText('₿12,000 available · ₿2,000 pending')).toBeVisible()
  await expect(page.locator('.qg-home [data-testid="vault-history"]')).toBeVisible()
  await expect(page.getByTestId(`vault-tx-${'ab'.repeat(32)}`)).toBeInViewport()
  expect(await page.getByTestId('vault-balance').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await expect(page.getByTestId('account-scan')).toBeEnabled()
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('light-home.png', { animations: 'disabled' })
  await page.getByTestId('vault-balance').click()
  await expect(page.getByTestId('vault-balance')).toHaveAttribute('data-balance-unit', 'usd')
  await expect(page.getByTestId('vault-balance')).toContainText('14')
  await page.getByTestId('vault-balance').click()
  await page.getByTestId(`vault-tx-${'ab'.repeat(32)}`).click()
  await expect(page.getByRole('img', { name: 'Received status' })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await launcher(page, 'Settings')
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await expect(page.getByTestId('settings-haptics')).toBeVisible()
  await expect(page.getByTestId('settings-signout')).toHaveCount(0)
  await expect(page.getByTestId('settings-privacy-lock')).toHaveCount(0)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('light-settings.png', { animations: 'disabled' })
  await page.getByTestId('settings-about').click()
  await expect(page.getByText('Light — passkey payments')).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByTestId('settings-theme').click()
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('light-home-dark.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('textbox', { name: 'To', exact: true }).fill(lightTestStatus().spendingArkAddress!)
  await page.getByRole('button', { name: 'Scan destination', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue(
    lightTestStatus().spendingArkAddress!,
  )
  await page.locator('#qg-send-amount').fill('1000')
  await expectWalletLayout(page, true)
  await expect(page).toHaveScreenshot('light-send.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Review payment' }).click()
  await expect(page.locator('.qg-details > div').filter({ hasText: 'Total' })).toHaveText('Total₿1,020')
  await expect(page.getByRole('button', { name: 'Approve payment' })).toBeInViewport({ ratio: 1 })
  await expectWalletLayout(page, true)
  await expect(page).toHaveScreenshot('light-review.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Approve payment' }).click()
  await expect(page.getByRole('heading', { name: 'Payment sent', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.getByTestId('receive-arkade-address')).toBeVisible()
  await expect(page.getByTestId('receive-share')).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await launcher(page, 'Savings')
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
  await launcher(page, 'Settings')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
  await launcher(page, 'Security')
  for (const name of ['Keys and access', 'Spending limits', 'Renewal', 'Backups']) {
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByRole('button', { name: 'Lock wallet' })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Go back', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Recover directly to Bitcoin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recover to Bitcoin', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Lock wallet' }).click()
  await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible()
  await expect(page.getByTestId('vault-balance')).toHaveCount(0)
})

test('@ux-shared Light watched Savings stays readable at 320px and returns to its account from Settings', async ({
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
