import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

for (const width of [320, 390, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`payment activity without in-app banners at ${width}px in ${theme} @polish`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `
          import React from '/node_modules/.vite/deps/react.js';
          import { VaultHistoryList } from '/src/screens/Vault/History.tsx';
          import { describePayment } from '/src/lib/vault/payments.ts';
          import QgScreen from '/src/screens/Vault/qg/QgScreen.tsx';
          const received = {txid:'${'ab'.repeat(32)}',type:'received',amount:123456789,confirmed:true,account:'spend'};
          const confirmed = {txid:'${'cd'.repeat(32)}',type:'sent',amount:12000,confirmed:true,account:'spend',activity:'bitcoin'};
          const attention = {txid:'${'ef'.repeat(32)}',type:'sent',amount:5000,confirmed:true,account:'spend',activity:'lightning',lightningState:'failed',lightningRfqId:'failed-rfq'};
          export default function PaymentFixture(){
            const [selected,setSelected]=React.useState(null);
            return React.createElement(QgScreen,{title:'Payment activity'},
              React.createElement(VaultHistoryList,{account:'spend',balancesLoaded:true,history:[received,confirmed,attention],openTx:setSelected}),
              selected && React.createElement('p',{role:'status','data-testid':'selected-payment'},describePayment(selected).state)
            );
          }
        `,
        }),
      )
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await expect(page.getByRole('heading', { name: 'Payment activity' })).toBeVisible()
      // Rejected in-app banner design: arrivals surface only as native device
      // notices, never as rendered banners. Payment rows still resolve.
      await expect(page.locator('[data-testid^="payment-arrival-"]')).toHaveCount(0)
      await expect(page.getByTestId('payment-catch-up')).toHaveCount(0)
      await page.getByTestId('vault-tx-' + 'ab'.repeat(32)).click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Received')
      await page.getByTestId('vault-tx-' + 'cd'.repeat(32)).click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Sent')
      await page.getByTestId('vault-tx-' + 'ef'.repeat(32)).click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Needs recovery')
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath('payment-activity.png'), fullPage: true })
    })
  }
}

test('native delivery claims arbitrate one announcement across two tabs', async ({ context }) => {
  const first = await context.newPage()
  const second = await context.newPage()
  for (const page of [first, second]) {
    await mockEnrollmentAccess(page, 'open')
    await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
        import React from '/node_modules/.vite/deps/react.js';
        import { claimNativeDelivery } from '/src/lib/vault/nativeDelivery.ts';
        export default function NativeClaimFixture(){
          const [winner,setWinner]=React.useState('pending');
          React.useEffect(()=>{
            const run=()=>claimNativeDelivery(['two-tab-native:payment-1']).then(keys=>setWinner(keys.length ? 'announced' : 'quiet'));
            window.addEventListener('test-arrival',run);
            return ()=>window.removeEventListener('test-arrival',run);
          },[]);
          return React.createElement('main',null,React.createElement('h1',null,'Native fixture'),React.createElement('p',{'data-testid':'verdict'},winner));
        }
      `,
      }),
    )
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Native fixture' })).toBeVisible()
  }
  await Promise.all([first, second].map((page) => page.evaluate(() => window.dispatchEvent(new Event('test-arrival')))))
  await expect
    .poll(async () => {
      const verdicts = await Promise.all([first, second].map((page) => page.getByTestId('verdict').textContent()))
      return verdicts.filter((verdict) => verdict === 'announced').length
    })
    .toBe(1)
})
