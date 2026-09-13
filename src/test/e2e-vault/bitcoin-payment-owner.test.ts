import { expect, test } from '@playwright/test'

const fixturePath = '/src/test/e2e-vault/fixtures/bitcoin-payment-owner.tsx'
for (const lock of [false, true]) {
  test(`Bitcoin owner retains signed preparation through browser cancellation, lock=${lock}`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/tools/native-savings-signers/ledger-client-browser.html')
    const facts = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).mountBitcoinPayment(),
      fixturePath,
    )
    const requests: { phase: string; body: Record<string, unknown> }[] = []
    let releaseUncertain = lock
    await page.route('**/v1/vtxo/bitcoin/**', async (route) => {
      const phase = new URL(route.request().url()).pathname.split('/').pop()!
      if (phase === 'info')
        return route.fulfill({ json: { version: 1, maxInputs: 1, descriptorHash: facts.descriptorHash } })
      const body = route.request().postDataJSON()
      requests.push({ phase, body })
      if (phase === 'prepare') {
        const saved = await page.evaluate(
          async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
          fixturePath,
        )
        expect(saved.prepareRequest).toEqual(body)
        const prepared = await page.evaluate(
          async ({ path, body }) => (await import(/* @vite-ignore */ path)).prepare(body),
          { path: fixturePath, body },
        )
        return route.fulfill({ json: prepared })
      }
      if (phase === 'release') return route.fulfill({ json: { state: releaseUncertain ? 'uncertain' : 'released' } })
      if (phase === 'status') return route.fulfill({ json: { state: releaseUncertain ? 'prepared' : 'released' } })
      throw new Error(`Unexpected Bitcoin signing or dispatch request: ${phase}`)
    })
    await page.route('**/v1/indexer/vtxos*', (route) =>
      route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: {
          page: { current: 0, next: 0, total: 1 },
          vtxos: [
            {
              outpoint: { txid: 'bb'.repeat(32), vout: 0 },
              amount: '40000',
              script: facts.script,
              isPreconfirmed: false,
              isSpent: false,
              isSwept: false,
              isUnrolled: false,
              expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
              createdAt: String(Math.floor(Date.now() / 1000)),
              commitmentTxids: ['cc'.repeat(32)],
              virtualStatus: { state: 'settled' },
            },
          ],
        },
      }),
    )
    await page.getByRole('button', { name: 'Review Bitcoin', exact: true }).click()
    await expect(page.locator('h1, h2, [data-testid=bitcoin-owner-error]').first()).toBeVisible()
    if (await page.getByTestId('bitcoin-owner-error').isVisible()) {
      const logs = await page.evaluate(
        async (path) => (await import(/* @vite-ignore */ path)).getLogs(),
        '/src/lib/logs.ts',
      )
      throw new Error(JSON.stringify({ requests, logs }))
    }
    await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
    await expect(page.locator('.qg-review-amount')).toContainText('1,500')
    await expect(page.getByText('Total').locator('..')).toContainText('1,900')
    const before = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
      fixturePath,
    )
    expect(before.stage).toBe('prepared')
    await page.screenshot({ path: testInfo.outputPath(`bitcoin-owner-review-${lock}.png`), fullPage: true })
    await page.getByRole('button', { name: lock ? 'Lock account' : 'Go back', exact: true }).click()
    await expect(page.getByTestId('bitcoin-owner-pending')).toHaveText('idle')
    await expect(page.getByTestId('bitcoin-owner-completion')).toBeEmpty()
    const after = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
      fixturePath,
    )
    if (lock) {
      expect(after).toEqual(before)
      releaseUncertain = false
      await page.getByRole('button', { name: 'Unlock fixture account' }).click()
      await page.getByRole('button', { name: 'Check retained payment' }).click()
      await expect
        .poll(() => page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).storedPayment(), fixturePath))
        .toBeNull()
    } else expect(after).toBeNull()
    expect(requests.filter((request) => request.phase === 'prepare')).toHaveLength(1)
    for (const request of requests) expect(request.body.operationId).toBe(before.operationId)
    expect(
      await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).passkeyCount(), fixturePath),
    ).toBe(1)
    expect(errors).toEqual([])
  })
}
