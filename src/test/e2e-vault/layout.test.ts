import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { CONNECTOR_TEST_DESCRIPTOR } from './fixtures/connector'
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
      await page.getByRole('button', { name: /^Standard/ }).click()
      await expectWalletLayout(page, true)
      await expect(page.getByRole('textbox', { name: 'Wallet descriptor' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Paste', exact: true }).click()
      const descriptor = page.getByRole('textbox', { name: 'Wallet descriptor' })
      await descriptor.fill(CONNECTOR_TEST_DESCRIPTOR)
      const style = await descriptor.evaluate((el) => {
        const css = getComputedStyle(el)
        return {
          font: parseFloat(css.fontSize),
          border: css.borderTopStyle,
          borderColor: css.borderTopColor,
          expectedBorder: css.getPropertyValue('--qg-muted').trim(),
          background: css.backgroundColor,
        }
      })
      expect(style.font).toBeGreaterThanOrEqual(16)
      expect(style.border).toBe('solid')
      expect(style.borderColor).toBe(theme === 'dark' ? 'rgb(170, 163, 173)' : 'rgb(105, 97, 89)')
      await expectWalletLayout(page)
      await page.getByRole('button', { name: 'Use this hardware key' }).click()
      await expectWalletLayout(page, true)
      await page.getByRole('button', { name: 'Review setup', exact: true }).click()
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
  await page.getByRole('button', { name: /^Standard/ }).click()
  await expectWalletLayout(page)
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expectWalletLayout(page)
  await page.evaluate(() => {
    document.documentElement.style.fontSize = ''
  })
  await page.setViewportSize({ width: 375, height: 360 })
  const descriptor = page.getByRole('textbox', { name: 'Wallet descriptor' })
  await descriptor.focus()
  await descriptor.fill(CONNECTOR_TEST_DESCRIPTOR)
  await expect(descriptor).toBeInViewport()
  await expectWalletLayout(page)
  await page.getByRole('button', { name: 'Use this hardware key', exact: true }).click()
  await expectWalletLayout(page)
})
