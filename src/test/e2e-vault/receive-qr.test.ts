import { expect, test } from '@playwright/test'

test.skip(
  process.env.VITE_VAULT_LIGHTNING_RECEIVE !== 'true' || process.env.VITE_VAULT_LNURL !== 'true',
  'Requires the Lightning receive and reusable address feature flags.',
)

for (const dark of [false, true]) {
  test(`@design-review primary Lightning QR scans from actual ${dark ? 'dark' : 'light'} screen pixels`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 667 })
    await page.goto(`/src/test/e2e-vault/fixtures/receive-primary.html?active${dark ? '&dark' : ''}`)
    const qr = page.getByRole('img', { name: 'Lightning address QR code', exact: true })
    await expect(qr.locator('svg')).toBeVisible()
    const pixels = await qr.screenshot({ path: testInfo.outputPath('qr.png'), scale: 'css', animations: 'disabled' })
    const decoded = await page.evaluate(
      async (url) => {
        const scannerPath = '/node_modules/qr-scanner/qr-scanner.min.js'
        const { default: QrScanner } = await import(/* @vite-ignore */ scannerPath)
        const result = await QrScanner.scanImage(url, { returnDetailedScanResult: true })
        return result.data as string
      },
      `data:image/png;base64,${pixels.toString('base64')}`,
    )
    const expected = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.startsWith('vaulted:lnurl:v1:'))!
      return JSON.parse(localStorage.getItem(key)!).lnurl as string
    })
    expect(decoded).toBe(expected)
  })
}
