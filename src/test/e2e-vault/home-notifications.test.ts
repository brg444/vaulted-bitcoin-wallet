import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// In-app arrival/catch-up banners are rejected: Home renders no banner
// surfaces. Verified receipts
// notify only as native device notices; Activity remains the source of truth.
function fixtureBody(): string {
  return `
    import React from '/node_modules/.vite/deps/react.js';
    import { ToastProvider } from '/src/components/Toast.tsx';
    import { VaultTestProvider } from '/src/test/fixtures/VaultTestProvider.tsx';
    import Home from '/src/screens/Vault/Home.tsx';
    export default function HomeFixture() {
      return React.createElement(ToastProvider, null,
        React.createElement(VaultTestProvider, { value: {
          account: 'spend', history: [],
          accountReads: { spend: { loaded: true, refreshing: false, fresh: true, error: '' }, savings: { loaded: true, refreshing: false, fresh: true, error: '' } },
          navigate: () => {}, openTx: () => {},
          positions: { spending: { availableSats: 12000, pendingSats: 0, totalSats: 12000 }, savings: { availableSats: 0, pendingSats: 0, totalSats: 0 } },
          setAccount: () => {}, clearSpendDraft: () => {}, setSpendDraft: () => {},
          spendingArkAddress: '', boardingAddress: '', savingsAddress: '',
        }}, React.createElement(Home)));
      }
  `
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`home shows no in-app banner surfaces at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
      )
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await expect(page.locator('[data-testid^="payment-arrival-"]')).toHaveCount(0)
      await expect(page.getByTestId('payment-catch-up')).toHaveCount(0)
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`home-notifications-${width}-${theme}.png`) })

      await page.evaluate(() => (document.documentElement.style.fontSize = '32px'))
      await expectWalletLayout(page)
    })
  }
}
