import { expect, type Page } from '@playwright/test'

// Long history, recovery explanations, and enlarged text may scroll vertically.
// The wallet frame and the current primary action must remain reachable.
export async function expectWalletLayout(page: Page, contained = false) {
  const app = page.getByTestId('vault-app')
  await expect(app).toBeVisible()
  expect(await app.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const main = page.locator('.qg-main:visible').first()
  if (await main.count()) {
    expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    if (contained) expect(await main.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  }
  for (const footer of await page.locator('.qg-footer:visible').all()) {
    await expect(footer).toBeInViewport({ ratio: 1 })
    for (const button of await footer.locator('button:visible').all()) {
      await expect(button).toBeInViewport({ ratio: 1 })
      const rect = await button.boundingBox()
      expect(rect!.height).toBeGreaterThanOrEqual(44)
    }
  }
}
