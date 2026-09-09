import { test, expect } from '@playwright/test'

for (const width of [320, 390, 1280]) {
  test(`Lightning address remains readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/src/test/e2e-vault/fixtures/lnurl.html')
    await page.locator('summary').click()
    await expect(page.getByRole('button', { name: 'Set up Lightning address' })).toBeVisible()
    await page.goto('/src/test/e2e-vault/fixtures/lnurl.html?active')
    await page.locator('summary').click()
    await expect(page.getByText('v1212121212121212@ln.getvaulted.xyz', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Disable address' })).toBeVisible()
    await expect(page.getByText(/up to 25 sats per payment/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('lightning-address.png'), fullPage: true })
  })
}
