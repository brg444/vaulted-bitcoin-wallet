import { sharedSpendingStatus as lightTestStatus } from '../../lib/vault/vtxo/testdata/sharedSpending'
import { test, expect } from './fixtures/passkey'
import { openLight } from './fixtures/light-ui'

// These fixtures replace enrollment, pricing, and transaction execution with synthetic values.
test('@ux-denomination Light keeps balances, history, navigation and send on one persistent unit', async ({
  page,
  authorizer,
}, testInfo) => {
  void authorizer
  await page.setViewportSize({ width: 375, height: 844 })
  await openLight(page, false)
  const balance = page.getByTestId('vault-balance')
  await balance.click()
  await expect(balance).toHaveText('$14.00')
  await expect(page.getByText('$12.00 available · $2.00 pending')).toBeVisible()
  const received = page.getByTestId(`vault-tx-${'ab'.repeat(32)}`)
  await expect(received).toContainText('$12.00')
  await page.screenshot({ path: testInfo.outputPath('home-usd.png') })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await expect(page.getByTestId('account-spend')).toContainText('$14.00')
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click()
  await received.click()
  await expect(page.getByRole('img', { name: 'Received status' })).toBeVisible()
  await expect(page.locator('.qg-transaction-amount')).toContainText('$12.00')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'See all activity', exact: true }).click()
  await expect(page.getByTestId('vault-activity')).toBeVisible()
  await expect(received).toContainText('$12.00')
  await received.click()
  await expect(page.locator('.qg-transaction-amount')).toContainText('$12.00')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByTestId('vault-activity')).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const amount = page.locator('#qg-send-amount')
  await expect(page.locator('.qg-denomination')).toHaveText('$')
  await amount.fill('1.23')
  await page.getByRole('textbox', { name: 'To', exact: true }).fill(lightTestStatus().spendingArkAddress!)
  await page.getByRole('button', { name: 'Review payment' }).click()
  await expect(page.locator('.qg-details > div').filter({ hasText: 'Total' })).toContainText('$1.25')
  await expect(page.getByRole('button', { name: 'Approve payment', exact: true })).toBeVisible()
  await page.reload()
  await expect(balance).toHaveText('$14.00')
  await expect(received).toContainText('$12.00')
  await balance.click()
  await expect(balance).toHaveText('₿14,000')
  await expect(received).toContainText('12,000')
  await expect(received).not.toContainText('$')
})

test('@ux-denomination external unit changes preserve an entered 331-sat payment', async ({ page, authorizer }) => {
  void authorizer
  await openLight(page, false)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const amount = page.locator('#qg-send-amount')
  await amount.fill('331')
  await page.evaluate(() => {
    localStorage.setItem('arkade-vault-balance-unit', 'usd')
    window.dispatchEvent(new StorageEvent('storage', { key: 'arkade-vault-balance-unit', newValue: 'usd' }))
  })
  await expect(page.locator('.qg-denomination')).toHaveText('$')
  await expect(amount).toHaveValue('0.33')
  await page.evaluate(() => {
    localStorage.removeItem('arkade-vault-balance-unit')
    window.dispatchEvent(new StorageEvent('storage', { key: 'arkade-vault-balance-unit', newValue: null }))
  })
  await expect(page.locator('.qg-denomination')).toHaveText('₿')
  await expect(amount).toHaveValue('331')
})

test('@ux-receive Light Receive counts the standalone iPhone safe area once', async ({
  page,
  authorizer,
}, testInfo) => {
  void authorizer
  await page.setViewportSize({ width: 393, height: 852 })
  await openLight(page, false)
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="vault-app"]')!.style.setProperty('--vault-safe-area-top', '59px')
  })
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  const app = page.getByTestId('vault-app')
  const screen = page.locator('.qg-screen')
  await expect(page.getByRole('heading', { name: 'Receive', exact: true })).toBeVisible()
  expect(await app.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('0px')
  const shell = await app.boundingBox(),
    receive = await screen.boundingBox()
  expect(Math.abs(receive!.y - shell!.y)).toBeLessThanOrEqual(1)
  expect(await screen.evaluate((el) => getComputedStyle(el).gridTemplateRows.split(' ')[0])).toBe('111px')
  const title = await page.getByRole('heading', { name: 'Receive', exact: true }).boundingBox()
  expect(title!.y - receive!.y).toBeGreaterThanOrEqual(59)
  await page.screenshot({ path: testInfo.outputPath('receive-safe-area.png') })
})
