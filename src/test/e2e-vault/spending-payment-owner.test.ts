import { expect, test } from '@playwright/test'

const fixturePath = '/src/test/e2e-vault/fixtures/spending-payment-owner.tsx'
for (const cancelAt of ['reservation', 'authorization'] as const) {
  test(`Spending owner preserves exact payment through browser ${cancelAt} interruption and reload`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // The account repository boundary is controlled; review, passkey decryption,
    // reservation validation, signing and journal persistence run production code.
    await page.route('**/src/lib/vault/vtxo/walletWorker.ts*', async (route) => {
      if (route.request().url().includes('spending-fixture-original')) return route.continue()
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
        export * from '/src/lib/vault/vtxo/walletWorker.ts?spending-fixture-original';
        export const ensureVaultWalletWorker=async()=>({});
        export const withActiveVaultWalletState=async(_id,run)=>{
          const {spendingRepository}=await import('${fixturePath}');
          return run({swapRepository:spendingRepository});
        };
      `,
      })
    })
    await page.goto('/tools/native-savings-signers/ledger-client-browser.html')
    const facts = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).mountSpendingPayment(),
      fixturePath,
    )
    const requests: { phase: string; body: Record<string, unknown> }[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/v1/info', async (route) => {
      const original = await route.fetch()
      return route.fulfill({ response: original, json: { ...(await original.json()), ...facts.operatorInfo } })
    })
    await page.route('**/v1/vtxo/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'GET') {
        const saved = await page.evaluate(
          async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
          fixturePath,
        )
        return route.fulfill({
          json: {
            operationId: saved.operationId,
            bundleDigest: saved.bundleDigest,
            state: 'reserved',
            arkTxid: saved.arkTxid,
            expiresAt: saved.reservationExpires,
            feeSats: saved.feeSats,
            feePolicyDigest: saved.feePolicyDigest,
            changeSats: saved.changeSats,
            changeVout: saved.changeVout,
          },
        })
      }
      const phase = path.split('/').pop()!
      const body = route.request().postDataJSON()
      requests.push({ phase, body })
      if (phase === 'reserve') {
        if (cancelAt === 'reservation') await held
        return route.fulfill({ json: { ...facts.reservation, operationId: body.operationId } })
      }
      if (phase === 'authorize') {
        await held
        return route.fulfill({ status: 503, json: { error: 'Response lost after approval' } })
      }
      throw new Error(`Unexpected payment mutation: ${phase}`)
    })
    await page.getByRole('button', { name: 'Review Spending', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
    await expect(page.locator('.qg-review-amount')).toContainText('12,000')
    expect(
      await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).passkeyCount(), fixturePath),
    ).toBe(0)
    await page.getByRole('button', { name: 'Approve payment', exact: true }).click()
    await expect.poll(() => requests.filter((request) => request.phase === 'reserve').length).toBe(1)
    if (cancelAt === 'authorization') {
      await expect(page.getByTestId('spending-owner-event')).toHaveText('fee-changed')
      await expect(page.getByText('Total', { exact: true }).locator('..')).toContainText('12,500')
      // Hide only the fixture controls so the capture uses the application's full frame.
      await page.getByTestId('spending-fixture-controls').evaluate((element) => {
        element.setAttribute('hidden', '')
      })
      await page.screenshot({ path: testInfo.outputPath('spending-fee-review.png'), fullPage: true })
      await page.getByTestId('spending-fixture-controls').evaluate((element) => {
        element.removeAttribute('hidden')
      })
      await page.getByRole('button', { name: 'Approve payment', exact: true }).click()
      await expect.poll(() => requests.filter((request) => request.phase === 'authorize').length).toBe(1)
    }
    const before = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
      fixturePath,
    )
    expect(before.operationId).toBe(requests[0].body.operationId)
    expect(before.reservePhoneSignature).toBe(requests[0].body.phoneSignature)
    await page.getByRole('button', { name: 'Lock account', exact: true }).click()
    release()
    await expect(page.getByTestId('spending-owner-pending')).toHaveText('idle')
    await expect(page.getByTestId('spending-owner-event')).toBeEmpty()
    const retained = await page.evaluate(
      async (path) => (await import(/* @vite-ignore */ path)).storedPayment(),
      fixturePath,
    )
    expect(retained.stage).toBe('reserved')
    expect(retained.operationId).toBe(before.operationId)
    expect(retained.reservedInputs).toEqual(facts.reservation.inputs)
    expect(retained.unsignedCheckpointPsbts).toHaveLength(1)
    expect(requests.map((request) => request.phase)).toEqual(
      cancelAt === 'reservation' ? ['reserve'] : ['reserve', 'authorize'],
    )
    await page.reload()
    await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).mountSpendingPayment(), fixturePath)
    await page.getByRole('button', { name: 'Open retained payment', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
    await expect(page.getByText('Total', { exact: true }).locator('..')).toContainText('12,500')
    expect(
      await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).storedPayment(), fixturePath),
    ).toEqual(retained)
    expect(
      await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).passkeyCount(), fixturePath),
    ).toBe(0)
    expect(errors).toEqual([])
  })
}
