import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// Real review UI with explicit fixture state; approval never leaves this harness.
for (const width of [320, 375, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`review continuity at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 667 })
      await mockEnrollmentAccess(page, 'open')
      let state = 'review'
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `
            import React from '/node_modules/.vite/deps/react.js';
            import { VaultContext } from '/src/vault/context.ts';
            import Review from '/src/screens/Vault/Review.tsx';
            export default function ReviewFixture() {
              const current = React.useContext(VaultContext);
              return React.createElement(VaultContext.Provider, {value: {
                ...current, account: ${JSON.stringify(state === 'processing' ? 'savings' : 'spend')},
                busy: ${state === 'processing'}, resumingPayment: ${state === 'resume'},
                spend: {amount: 1234567890, fee: 240, address: 'tark1${'a'.repeat(100)}'},
                status: {network: 'mutinynet'}, approveSend: () => {}, navigate: () => {}
              }}, React.createElement(Review));
            }
          `,
        }),
      )
      for (state of ['review', 'resume', 'processing']) {
        await page.goto(`/?review-fixture=${state}`)
        await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
        const amount = page.locator('.qg-review-amount strong')
        await expect(amount).toHaveText('₿1,234,567,890')
        await expect(amount).toBeVisible()
        expect(await amount.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(20)
        await expectWalletLayout(page)
        if (state !== 'processing') {
          await page.getByRole('button', { name: 'Reveal', exact: true }).click()
          await expect(page.locator('.qg-details strong').filter({ hasText: `tark1${'a'.repeat(100)}` })).toBeVisible()
          await expectWalletLayout(page)
        }
        if (state === 'resume') await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
        await page.screenshot({ path: testInfo.outputPath(`${state}-${width}-${theme}.png`) })
        await page.evaluate(() => (document.documentElement.style.fontSize = '32px'))
        await expectWalletLayout(page)
        if (state === 'processing') {
          const prompt = page.getByText('Use Face ID, Touch ID, fingerprint, or your device PIN when prompted.')
          await prompt.scrollIntoViewIfNeeded()
          await expect(prompt).toBeInViewport({ ratio: 1 })
        }
      }
    })
  }
}
