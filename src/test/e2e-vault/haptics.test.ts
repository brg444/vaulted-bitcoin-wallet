import { expect, test } from '@playwright/test'

test('iOS haptics preserve native touch targets and scrolling', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'no-preference',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    viewport: { width: 390, height: 844 },
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined })
  })

  const page = await context.newPage()
  await page.goto(baseURL ?? '/')
  const button = page.getByRole('button', { name: 'Get started' })
  await expect(button).toBeVisible()

  await expect(page.locator('#vault-ios-haptic-overlays')).toHaveCount(0)
  const directTarget = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === element || element.contains(hit)
  })
  expect(directTarget).toBe(true)
  await button.tap()

  await expect(page.getByRole('heading', { name: 'Choose your Vault' })).toBeVisible()
  await context.close()
})
