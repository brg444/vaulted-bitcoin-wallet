import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

for (const width of [320, 390, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`payment activity and arrivals at ${width}px in ${theme} @polish`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `
          import React from '/node_modules/.vite/deps/react.js';
          import { VaultHistoryList } from '/src/screens/Vault/History.tsx';
          import PaymentArrivalBanners from '/src/screens/Vault/PaymentArrivals.tsx';
          import { describePayment } from '/src/lib/vault/payments.ts';
          import QgScreen from '/src/screens/Vault/qg/QgScreen.tsx';
          const received = {txid:'${'ab'.repeat(32)}',type:'received',amount:123456789,confirmed:true,account:'spend'};
          const confirmed = {txid:'${'cd'.repeat(32)}',type:'sent',amount:12000,confirmed:true,account:'spend',activity:'bitcoin'};
          const attention = {txid:'${'ef'.repeat(32)}',type:'sent',amount:5000,confirmed:true,account:'spend',activity:'lightning',lightningState:'failed',lightningRfqId:'failed-rfq'};
          export default function PaymentFixture(){
            const [arrivals,setArrivals]=React.useState([{key:'arrival-a',item:received},{key:'arrival-b',item:{...received,txid:'${'12'.repeat(32)}'}}]);
            const [selected,setSelected]=React.useState(null);
            return React.createElement(QgScreen,{title:'Payment activity'},
              React.createElement(PaymentArrivalBanners,{arrivals,onOpen:a=>setSelected(a.item),onDismiss:key=>setArrivals(old=>old.filter(a=>a.key!==key))}),
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
      await expect(page.getByRole('button', { name: 'View details', exact: true })).toHaveCount(2)
      await page.getByRole('button', { name: 'View details', exact: true }).first().click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Received')
      await page
        .getByRole('button', { name: /Dismiss arrival/ })
        .first()
        .click()
      await expect(page.getByRole('button', { name: 'View details', exact: true })).toHaveCount(1)
      await page.getByTestId('vault-tx-' + 'cd'.repeat(32)).click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Sent')
      await page.getByTestId('vault-tx-' + 'ef'.repeat(32)).click()
      await expect(page.getByTestId('selected-payment')).toHaveText('Needs recovery')
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath('payment-activity.png'), fullPage: true })
    })
  }
}

test('one announcement across two tabs observing the same payment', async ({ context }) => {
  const first = await context.newPage()
  const second = await context.newPage()
  for (const page of [first, second]) {
    await mockEnrollmentAccess(page, 'open')
    await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
        import React from '/node_modules/.vite/deps/react.js';
        import { usePaymentArrivals } from '/src/vault/usePaymentArrivals.ts';
        import PaymentArrivalBanners from '/src/screens/Vault/PaymentArrivals.tsx';
        export default function ArrivalFixture(){
          const [history,setHistory]=React.useState([]);
          const state=usePaymentArrivals(history,{network:'mutinynet',vaultId:'two-tab-fixture'},false,true);
          React.useEffect(()=>{
            const add=()=>setHistory([{txid:'${'34'.repeat(32)}',type:'received',amount:1234,confirmed:true,account:'spend'}]);
            window.addEventListener('test-arrival',add);
            return ()=>window.removeEventListener('test-arrival',add);
          },[]);
          return React.createElement('main',null,React.createElement('h1',null,'Arrival fixture'),React.createElement(PaymentArrivalBanners,{arrivals:state.arrivals,onOpen:()=>{},onDismiss:state.dismissArrival}));
        }
      `,
      }),
    )
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Arrival fixture' })).toBeVisible()
  }
  await Promise.all([first, second].map((page) => page.evaluate(() => window.dispatchEvent(new Event('test-arrival')))))
  await expect
    .poll(
      async () =>
        (await first.getByRole('button', { name: 'View details' }).count()) +
        (await second.getByRole('button', { name: 'View details' }).count()),
    )
    .toBe(1)
  await Promise.all([first, second].map((page) => page.evaluate(() => window.dispatchEvent(new Event('test-arrival')))))
  expect(
    (await first.getByRole('button', { name: 'View details' }).count()) +
      (await second.getByRole('button', { name: 'View details' }).count()),
  ).toBe(1)
})
