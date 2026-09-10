import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// Render the real Activity screen with synthetic loaded history: pending,
// attention, both accounts, long amounts, and enough rows for paging plus an
// older-page load. No payment is submitted and no network history is fetched.
function fixtureBody(): string {
  return `
    import React from '/node_modules/.vite/deps/react.js';
    import { VaultContext } from '/src/vault/context.ts';
    import Activity from '/src/screens/Vault/Activity.tsx';
    const base = [];
    base.push({ txid: 'pending-receive', type: 'received', amount: 12000, confirmed: false, account: 'spend' });
    base.push({ txid: 'failed-lightning', type: 'sent', amount: 2125, confirmed: true, blockTime: 1700000100, account: 'spend', activity: 'lightning', lightningState: 'failed', lightningRfqId: 'rfq-browser' });
    for (let index = 0; index < 58; index += 1) {
      base.push({
        txid: 'browser-tx-' + index,
        type: index % 2 === 0 ? 'sent' : 'received',
        amount: index === 7 ? 2100000000000 : 1000 + index,
        confirmed: true,
        blockTime: 1700000000 - index * 3600,
        account: index % 3 === 0 ? 'savings' : 'spend',
      });
    }
    const older = [
      { txid: 'browser-older-1', type: 'received', amount: 5000, confirmed: true, blockTime: 1690000000, account: 'savings' },
      { txid: 'browser-older-2', type: 'sent', amount: 2500, confirmed: true, blockTime: 1689000000, account: 'savings' },
    ];
    export default function ActivityFixture() {
      const current = React.useContext(VaultContext);
      const [extra, setExtra] = React.useState([]);
      const [olderState, setOlderState] = React.useState({ status: 'idle', error: '' });
      const allHistory = base.concat(extra);
      return React.createElement(VaultContext.Provider, { value: {
        ...current,
        allHistory,
        balancesLoaded: true,
        refreshingBalance: false,
        openTx: () => {},
        navigate: () => {},
        loadOlderActivity: async () => {
          setOlderState({ status: 'loading', error: '' });
          await new Promise((resolve) => setTimeout(resolve, 50));
          setExtra(older);
          setOlderState({ status: 'exhausted', error: '' });
          return { added: 2, exhausted: true };
        },
        olderActivity: olderState,
      }}, React.createElement(Activity));
    }
  `
}

for (const width of [320, 390, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`activity renders full history at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 1440 ? 1000 : 844 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
      )
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
      await expect(page.getByTestId('vault-tx-browser-tx-7')).toContainText('2,100,000,000,000')
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`activity-${width}-${theme}.png`) })

      // Filters narrow the list without losing layout.
      await page.getByTestId('activity-filter-direction').selectOption('sent')
      await expect(page.getByTestId('vault-tx-browser-tx-7')).toBeHidden()
      await expect(page.getByTestId('vault-tx-browser-tx-0')).toBeVisible()
      await page.getByTestId('activity-filter-direction').selectOption('all')
      await page.getByTestId('activity-filter-status').selectOption('attention')
      await expect(page.getByTestId('vault-tx-failed-lightning')).toBeVisible()
      await expect(page.getByTestId('vault-tx-browser-tx-0')).toBeHidden()
      await expectWalletLayout(page)

      // Paging and older-page navigation reach every loaded payment.
      await page.getByTestId('activity-filter-status').selectOption('all')
      await expect(page.getByRole('button', { name: /Show more \(50 of 60\)/ })).toBeVisible()
      await page.getByRole('button', { name: /Show more/ }).click()
      await expect(page.getByTestId('vault-tx-browser-tx-57')).toBeVisible()
      await page.getByRole('button', { name: 'Load older Savings records' }).click()
      await expect(page.getByTestId('vault-tx-browser-older-2')).toBeVisible()
      await expect(page.getByText('No older Savings records.')).toBeVisible()
      await expectWalletLayout(page)

      // Large text keeps controls reachable.
      await page.evaluate(() => (document.documentElement.style.fontSize = '32px'))
      await expectWalletLayout(page)
    })
  }
}
