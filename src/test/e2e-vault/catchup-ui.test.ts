import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// Render the real catch-up banner with three verified payments. Dismissal is
// local state in the fixture; navigation stays inside the wallet.
function fixtureBody(): string {
  return `
    import React from '/node_modules/.vite/deps/react.js';
    import { ToastProvider } from '/src/components/Toast.tsx';
    import { VaultContext } from '/src/vault/context.ts';
    import Home from '/src/screens/Vault/Home.tsx';
    export default function CatchUpFixture() {
      const current = React.useContext(VaultContext);
      const [dismissed, setDismissed] = React.useState(false);
      const catchUp = dismissed ? null : { count: 3, totalSats: 2100000000000, keys: ['a', 'b', 'c'] };
      return React.createElement(ToastProvider, null,
        React.createElement(VaultContext.Provider, { value: {
          ...current, account: 'spend', balancesLoaded: true, history: [], arrivals: [],
          dismissArrival: () => {}, openArrival: () => {}, catchUp,
          dismissCatchUp: () => setDismissed(true),
          navigate: () => {}, openTx: () => {}, refreshingBalance: false,
          positions: { spending: { availableSats: 12000, pendingSats: 0, totalSats: 12000 }, savings: { availableSats: 0, pendingSats: 0, totalSats: 0 } },
          setAccount: () => {}, clearSpendDraft: () => {}, setSpendDraft: () => {},
          spendingArkAddress: '', boardingAddress: '', savingsAddress: '',
        }}, React.createElement(Home)));
      }
  `
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`catch-up summary renders at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
      )
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await expect(page.getByTestId('payment-catch-up')).toContainText('3 new payments received')
      await expect(page.getByTestId('payment-catch-up')).toContainText('2,100,000,000,000')
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`catchup-${width}-${theme}.png`) })

      await page.getByRole('button', { name: 'Dismiss new payments summary' }).click()
      await expect(page.getByTestId('payment-catch-up')).toBeHidden()
      await expectWalletLayout(page)

      await page.evaluate(() => (document.documentElement.style.fontSize = '32px'))
      await expectWalletLayout(page)
    })
  }
}
