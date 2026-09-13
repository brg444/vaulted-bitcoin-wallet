import { expect, test } from '@playwright/test'
import { Transaction } from '@scure/btc-signer'
import { hex } from '@scure/base'

const fixturePath = '/src/test/e2e-vault/fixtures/ledger-payment-owner.tsx'

for (const cancel of [false, true]) {
  test(`Ledger owner retains real signatures and exact resumption, cancel=${cancel}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/src/lib/vault/ledgerClient.ts*', async (route) => {
      if (new URL(route.request().url()).searchParams.has('ledger-original')) return route.continue()
      await route.fulfill({
        contentType: 'application/javascript',
        body: `export * from '/src/lib/vault/ledgerClient.ts?ledger-original'; export { connectLedgerSavings } from '${fixturePath}';`,
      })
    })
    let broadcasts = 0
    await page.route('**/esplora/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/esplora/tx' && route.request().method() === 'POST') {
        broadcasts++
        const stored = await page.evaluate(
          async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
          fixturePath,
        )
        expect(stored.pending.phase).toBe('signed')
        expect(stored.pending.phonePsbt).toBeTruthy()
        expect(stored.pending.signedPsbt).toBeTruthy()
        expect(route.request().postData()).toBe(stored.pending.txHex)
        const txid = Transaction.fromRaw(hex.decode(stored.pending.txHex)).id
        expect(txid).toBe(stored.pending.candidateId)
        return route.fulfill({ body: txid })
      }
      if (path.endsWith('/status')) {
        const saved = await page.evaluate(
          async (path) => (await import(/* @vite-ignore */ path)).storedPayment().pending,
          fixturePath,
        )
        if (saved.payment.coins.some((coin: { txid: string }) => path === `/esplora/tx/${coin.txid}/status`))
          return route.fulfill({ json: { confirmed: true } })
        return route.fulfill({ status: 404, body: 'missing' })
      }
      if (path.includes('/outspend/')) return route.fulfill({ json: { spent: false } })
      throw new Error(`Unexpected Ledger fixture request ${path}`)
    })
    await page.goto('/tools/native-savings-signers/ledger-client-browser.html')
    await page.evaluate(
      async ({ path, cancel }) => (await import(/* @vite-ignore */ path)).mountLedgerPayment(cancel),
      { path: fixturePath, cancel },
    )
    await page.getByRole('button', { name: 'Approve phone', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review your payment' })).toBeVisible()
    await expect(page.getByText('20,000 sats', { exact: true })).toBeVisible()
    await expect(page.getByText('1,000 sats', { exact: true })).toBeVisible()
    const original = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).storedPayment().pending,
      fixturePath,
    )
    await page.getByRole('button', { name: 'Approve with Ledger', exact: true }).click()
    if (cancel) {
      await expect
        .poll(() =>
          page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).events.includes('sign'), fixturePath),
        )
        .toBe(true)
      await page.getByRole('button', { name: 'Leave approval' }).click()
      await page.getByRole('button', { name: 'Release device response' }).click()
      await expect(page.getByTestId('owner-pending')).toHaveText('idle')
      const saved = await page.evaluate(
        async (path) => (await import(/* @vite-ignore */ path)).storedPayment().pending,
        fixturePath,
      )
      expect(saved).toEqual(original)
      expect(broadcasts).toBe(0)
      await page.getByRole('button', { name: 'Reopen saved payment' }).click()
      await page.getByRole('button', { name: 'Approve with Ledger', exact: true }).click()
    }
    await expect(page.getByTestId('payment-complete')).toHaveText(original.candidateId)
    await expect(page.getByTestId('owner-pending')).toHaveText('idle')
    expect(broadcasts).toBe(1)
    const events = await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).events, fixturePath)
    expect(events.filter((event: string) => event === 'passkey')).toHaveLength(1)
    expect(events.filter((event: string) => event === 'close')).toHaveLength(cancel ? 2 : 1)
    expect(errors).toEqual([])
  })
}
