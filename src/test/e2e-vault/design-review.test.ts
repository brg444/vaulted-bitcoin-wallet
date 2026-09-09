import { test, expect } from './fixtures/passkey'
import { openLight } from './fixtures/light-ui'

// Actual wallet rendering with synthetic balances and transactions; no payments are made.
for (const width of [320, 375, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`@design-review ${width}px ${theme} launcher over full-width activity`, async ({
      page,
      authorizer,
    }, testInfo) => {
      void authorizer
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await openLight(page, false, false, {
        balance: 128064,
        pendingBalance: 0,
        history: Array.from({ length: 18 }, (_, index) => ({
          account: 'spend',
          txid: index.toString(16).padStart(64, '0'),
          amount: index % 2 ? 23508 : 12064,
          type: index % 2 ? 'sent' : 'received',
          confirmed: true,
          blockTime: 1788739200 - index * 3600,
        })),
      })
      await page.evaluate((dark) => {
        document.documentElement.classList.toggle('palette-dark', dark)
        document.documentElement.classList.toggle('palette-light', !dark)
      }, theme === 'dark')
      await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeEnabled()
      const trigger = page.getByRole('button', { name: 'Open navigation', exact: true })
      await trigger.focus()
      await page.keyboard.press('Alt+ArrowUp')
      await page.keyboard.press('Alt+ArrowUp')
      await page.keyboard.press('Alt+ArrowUp')
      await page.screenshot({ path: testInfo.outputPath('home-glass.png'), scale: 'css' })
      const row = page.locator('.vault-history-row').first()
      const actions = await page.locator('.qg-actions').boundingBox()
      const rowBox = await row.boundingBox()
      expect(Math.abs(rowBox!.x + rowBox!.width - actions!.x - actions!.width)).toBeLessThan(2)
      const box = await trigger.boundingBox()
      expect(box!.width).toBeLessThanOrEqual(48)
      expect(box!.height).toBeGreaterThanOrEqual(44)
      const restingGlass = await trigger.evaluate((button) => getComputedStyle(button, '::before').backgroundImage)
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2, box!.y - 120, { steps: 12 })
      await expect
        .poll(() => trigger.evaluate((button) => getComputedStyle(button, '::before').backgroundImage))
        .not.toBe(restingGlass)
      await page.screenshot({ path: testInfo.outputPath('launcher-drag.png'), scale: 'css' })
      await page.mouse.up()
      await expect(trigger).not.toHaveClass(/is-coasting/, { timeout: 4000 })
      await trigger.click()
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('launcher-open.png'), scale: 'css', animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await trigger.focus()
      await page.keyboard.press('Alt+ArrowUp')
      await expect(trigger).not.toHaveClass(/is-coasting/)
      await page.screenshot({ path: testInfo.outputPath('launcher-reduced-motion.png'), scale: 'css' })
    })
  }
}
