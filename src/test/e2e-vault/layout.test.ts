import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

for (const width of [320, 375]) {
  for (const theme of ['light', 'dark']) {
    test(`onboarding keeps actions reachable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 667 })
      await mockEnrollmentAccess(page, 'open')
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await expectWalletLayout(page, true)
      await page.getByRole('button', { name: 'Get started', exact: true }).click()
      await expectWalletLayout(page, true)
      for (const protection of ['Standard', 'Advanced']) {
        await page.getByRole('button', { name: new RegExp(`^${protection}`) }).click()
        await expect(page.getByRole('heading', { name: 'Protect Savings with Ledger' })).toBeVisible()
        await expect(page.getByRole('textbox')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Connect Ledger' })).toBeVisible()
        await expectWalletLayout(page)
        await page.getByRole('button', { name: 'Go back', exact: true }).click()
      }
      await page.getByRole('button', { name: /^Light/ }).click()
      const paymentLimit = page.getByRole('textbox', { name: 'Per payment', exact: true })
      await page.getByRole('textbox', { name: 'Rolling 24-hour limit', exact: true }).fill('375000')
      await paymentLimit.fill('125000')
      const style = await paymentLimit.evaluate((el) => {
        const input = getComputedStyle(el)
        const field = getComputedStyle(el.parentElement!)
        return {
          font: parseFloat(input.fontSize),
          border: field.borderTopStyle,
          borderColor: field.borderTopColor,
        }
      })
      expect(style.font).toBeGreaterThanOrEqual(16)
      expect(style.border).toBe('solid')
      expect(style.borderColor).toBe(theme === 'dark' ? 'rgb(170, 163, 173)' : 'rgb(105, 97, 89)')
      await expectWalletLayout(page)
      await page.getByRole('button', { name: 'Review setup', exact: true }).click()
      await expect(page.getByText('125,000 sats', { exact: true })).toBeVisible()
      await expectWalletLayout(page)
      await page.getByRole('checkbox').check()
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expectWalletLayout(page)
      await page.getByRole('button', { name: 'Help', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Wallet help' })).toBeInViewport({ ratio: 1 })
      await page.getByRole('button', { name: 'Close help', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Help', exact: true })).toBeFocused()
    })
  }
}

test('enlarged text and a short keyboard viewport preserve input and action access', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await mockEnrollmentAccess(page, 'open')
  await page.goto('/')
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px'
  })
  await expectWalletLayout(page)
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await expectWalletLayout(page)
  await page.getByRole('button', { name: /^Light/ }).click()
  await expectWalletLayout(page)
  await page.evaluate(() => {
    document.documentElement.style.fontSize = ''
  })
  await page.setViewportSize({ width: 375, height: 360 })
  const paymentLimit = page.getByRole('textbox', { name: 'Per payment', exact: true })
  await page.getByRole('textbox', { name: 'Rolling 24-hour limit', exact: true }).fill('375000')
  await paymentLimit.focus()
  await paymentLimit.fill('125000')
  await expect(paymentLimit).toBeInViewport()
  await expectWalletLayout(page)
  await page.getByRole('button', { name: 'Review setup', exact: true }).click()
  await expectWalletLayout(page)
})
