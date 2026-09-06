import { expect, test } from './fixtures/passkey'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'

const RUNTIME = process.env.VAULT_LIGHT_BROWSER_API || ''
const CONTROL = `http://127.0.0.1:${process.env.VAULT_E2E_OPERATOR_PORT || 18888}`
test.skip(!RUNTIME, 'Run with the opt-in Light Go browser harness')
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }))

test('Light enrolls through the Go runtime with a real PRF passkey and verifies its saved file', async ({
  page,
  passkey,
}) => {
  void passkey
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (
      url.pathname !== '/v1/status' &&
      url.pathname !== '/v1/enroll/session' &&
      !url.pathname.startsWith('/v1/light/')
    ) {
      await route.continue()
      return
    }
    const response = await page.request.fetch(`${RUNTIME}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postData() || undefined,
    })
    if (url.pathname === '/v1/light/enroll/finish' && response.ok())
      await page.request.post(`${CONTROL}/__vault_e2e_authorizer`, { data: await response.json() })
    await route.fulfill({ response })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: 'Light Passkey spending', exact: false }).click()
  await expect(page.getByRole('heading', { name: 'Everyday bitcoin, with limits' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Invite code' })).toHaveCount(0)
  await page.getByLabel('Per-payment limit, in sats').fill('20000')
  await page.getByLabel('Rolling 24-hour limit, in sats').fill('50000')
  await page.screenshot({ path: '/tmp/vaulted-light-setup-mobile.png', fullPage: true })
  const footer = await page.getByRole('button', { name: 'Create passkey', exact: true }).boundingBox()
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Keep two things safe' })).toBeVisible()
  const secret = (await page.locator('.light-secret').innerText()).trim()
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download recovery file', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()
  const saved = JSON.parse(await readFile(path!, 'utf8'))
  expect(saved).not.toHaveProperty('token')
  expect(saved.descriptor.spendingPolicy.txRecipientCapSats).toBe(20000)
  // Reload with only encrypted staged material, then reopen the saved file.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Keep two things safe' })).toBeVisible()
  await expect(page.locator('.light-secret')).toHaveCount(0)
  await page.getByLabel('Enter your saved secret to verify').fill(secret)
  await expect(page.getByRole('button', { name: 'Verify backup and create wallet' })).toBeDisabled()
  await page.getByLabel('Choose the saved recovery file to verify it').setInputFiles(path!)
  await page.getByRole('button', { name: 'Verify backup and create wallet' }).click()
  await expect(page.getByRole('button', { name: 'Security', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '0 sats', exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('50,000 sats available within your rolling 24-hour limit.')).toBeVisible()
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.locator('.light-address')).toHaveText(/^tark1/)
  const originalAddress = (await page.locator('.light-address').innerText()).trim()
  await page.screenshot({ path: '/tmp/vaulted-light-receive-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.locator('.light-app').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.evaluate(() => document.documentElement.classList.add('palette-dark'))
  await page.screenshot({ path: '/tmp/vaulted-light-receive-narrow-dark.png', fullPage: true })
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Security', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByText('Passkey + policy cosigner', { exact: true })).toBeVisible()
  const persistent = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(persistent).not.toContain(secret)
  // Keep the original authenticator but remove this device's app record.
  // Restoring the downloaded file must recover the same script and policy.
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('vaulted:active-setup', 'light')
  })
  await page.reload()
  await page.getByRole('button', { name: 'Restore a Light wallet', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles(path!)
  await page.getByRole('button', { name: 'Verify file and unlock', exact: true }).click()
  await expect(page.getByRole('heading', { name: '0 sats', exact: true })).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.locator('.light-address')).toHaveText(originalAddress)
  expect(await passkey.credentials()).toHaveLength(1)
  expect(errors).toEqual([])
})
