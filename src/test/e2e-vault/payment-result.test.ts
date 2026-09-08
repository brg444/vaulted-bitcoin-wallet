import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// Render the real result component with explicit outcome fixtures. No payment is submitted.
for (const width of [320, 375]) {
  for (const theme of ['light', 'dark']) {
    for (const [kind, title, label] of [
      ['vtxo', 'Payment sent', 'Sent'],
      ['onchain', 'Savings transfer submitted', 'Submitted'],
      ['lightning', 'Payment started', 'Started'],
    ]) {
      test(`payment result preserves ${kind} at ${width}px in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 667 })
        await mockEnrollmentAccess(page, 'open')
        await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `
              import React from '/node_modules/.vite/deps/react.js';
              import { VaultContext } from '/src/vault/context.ts';
              import Success from '/src/screens/Vault/Success.tsx';
              export default function ResultFixture() {
                const current = React.useContext(VaultContext);
                return React.createElement(VaultContext.Provider, {value: {
                  ...current, lastTxKind: ${JSON.stringify(kind)},
                  lastTxid: '${'ab'.repeat(32)}',
                  lastSend: {address: 'tark1-test-destination', amount: 12000, fee: 0},
                  status: {network: 'mutinynet'}
                }}, React.createElement(Success));
              }
            `,
          }),
        )
        await page.goto('/')
        await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
        await expect(page.locator('.qg-success-label')).toHaveText(label)
        await expectWalletLayout(page)
        await page.screenshot({ path: testInfo.outputPath(`${kind}-${width}-${theme}.png`) })
        await page
          .getByText(kind === 'lightning' ? 'View funding transaction' : 'View transaction', { exact: true })
          .click()
        await expect(page.getByText('ab'.repeat(32), { exact: true })).toBeVisible()
        await expectWalletLayout(page)
        await page.evaluate(() => (document.documentElement.style.fontSize = '32px'))
        await expectWalletLayout(page)
      })
    }
  }
}
