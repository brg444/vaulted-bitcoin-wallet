import { expect, test } from '@playwright/test'

test.skip(
  process.env.VITE_VAULT_LIGHTNING_RECEIVE !== 'true' || process.env.VITE_VAULT_LNURL !== 'true',
  'Requires the Lightning receive and reusable address feature flags.',
)

for (const width of [320, 375, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`@ux-receive primary Lightning address at ${width}px ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 320 ? 667 : 844 })
      await page.goto(
        `/src/test/e2e-vault/fixtures/receive-primary.html?active${width === 375 ? '&named&light' : ''}${theme === 'dark' ? '&dark' : ''}`,
      )
      const address = page.getByRole('region', { name: 'Lightning address', exact: true })
      await expect(
        address.getByText(width === 375 ? 'alex@ln.getvaulted.xyz' : 'v1212121212121212@ln.getvaulted.xyz', {
          exact: true,
        }),
      ).toBeVisible()
      await expect(address.getByRole('button', { name: 'Copy address' })).toBeVisible()
      const invoice = page.getByRole('button', { name: 'Create invoice' })
      await expect(invoice).toBeVisible()
      await expect(invoice.locator('svg.lucide-arrow-right')).toHaveCount(1)
      expect(await invoice.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
      await expect(page.getByRole('group', { name: 'Receive methods' })).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('button', { name: 'Create invoice' })).toBeInViewport({ ratio: 1 })
      await page.screenshot({
        path: testInfo.outputPath('receive-lightning.png'),
        scale: 'css',
        animations: 'disabled',
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await address.getByText('Address options', { exact: true }).click()
      await expect(page.getByRole('img', { name: 'Lightning address QR code', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Share Lightning address' })).toBeVisible()
      await page.getByRole('button', { name: 'Bitcoin', exact: true }).click()
      await expect(page.getByTestId('receive-bitcoin-address')).toBeVisible()
      await page.getByRole('button', { name: 'Lightning', exact: true }).click()
      await page.getByRole('button', { name: 'Create invoice' }).click()
      await expect(page.getByRole('heading', { name: 'Receive Lightning' })).toBeVisible()
    })
  }
}
