import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('@polish @visual-refinement welcome opens the native install offer directly', async ({ page }) => {
  test.skip(/iPhone|iPad/.test(await page.evaluate(() => navigator.userAgent)), 'iOS uses the automatic install guide')
  await page.goto('/')
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  const trigger = page.getByRole('button', { name: /Install Vaulted/ })
  await expect(trigger).toBeVisible()
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, {
      prompt: async () => {
        document.documentElement.dataset.installCalls = String(
          Number(document.documentElement.dataset.installCalls ?? '0') + 1,
        )
        document.documentElement.dataset.installActivation = String(navigator.userActivation.isActive)
        return { outcome: 'dismissed' }
      },
    })
    window.dispatchEvent(event)
  })
  await trigger.click()
  await expect(page.locator('html')).toHaveAttribute('data-install-calls', '1')
  await expect(page.locator('html')).toHaveAttribute('data-install-activation', 'true')
  await expect(trigger).toBeEnabled()
  await expect(page.getByRole('dialog', { name: 'Install Vaulted', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Close help' }).click()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose your Vault', exact: true })).toBeVisible()
})

for (const dark of [false, true]) {
  test(`@polish @visual-refinement welcome install guide is accessible and dismissible (${dark ? 'dark' : 'light'})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('arkade-vault-theme', value ? 'Dark' : 'Light'), dark)
    await page.goto('/')
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    const trigger = page.getByRole('button', { name: /Install Vaulted/ })
    await expect(trigger).toBeVisible()
    const iphone = await page.evaluate(() => /iPhone|iPad/.test(navigator.userAgent))
    await trigger.click()
    const sheet = page.getByRole('dialog', { name: 'Install Vaulted', exact: true })
    await expect(sheet).toBeVisible()
    await expect(page.locator('html')).toHaveClass(dark ? /palette-dark/ : /^(?!.*palette-dark)/)
    if (iphone) await expect(sheet.getByText('Add to Home Screen', { exact: true })).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('install-guide.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(sheet).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await sheet.getByRole('button', { name: 'Continue in browser' }).click()
    await expect(sheet).not.toBeVisible()
    await page.getByRole('button', { name: 'Close help' }).click()
    await page.getByRole('button', { name: 'Get started', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose your Vault', exact: true })).toBeVisible()
  })
}

test('@visual-refinement installed welcome hides the install notice', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Wallet help' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Install Vaulted/ })).toHaveCount(0)
})

test('iPhone install popout rises from the bottom and stays dismissed after reload', async ({ page }) => {
  test.skip(!/iPhone|iPad/.test(await page.evaluate(() => navigator.userAgent)), 'iPhone installation behavior')
  await page.goto('/')
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Install Vaulted', exact: true })
  await page.getByRole('button', { name: /Install Vaulted/ }).click()
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(Math.abs(box!.y + box!.height - viewport.height)).toBeLessThanOrEqual(2)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.width).toBeLessThanOrEqual(viewport.width)
  await sheet.getByRole('button', { name: 'Close install guide' }).click()
  await expect(sheet).not.toBeVisible()
  await page.reload()
  // The automatic offer delay must elapse before proving dismissal persists.
  await page.waitForTimeout(900)
  await expect(sheet).not.toBeVisible()
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await page.getByRole('button', { name: /Install Vaulted/ }).click()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Continue in browser' }).click()
  await page.getByRole('button', { name: 'Close help' }).click()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose your Vault', exact: true })).toBeVisible()
})
