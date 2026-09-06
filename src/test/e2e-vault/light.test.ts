import { expect, test } from './fixtures/passkey'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'

const RUNTIME = process.env.VAULT_LIGHT_BROWSER_API || ''
const CONTROL = `http://127.0.0.1:${process.env.VAULT_E2E_OPERATOR_PORT || 18888}`
test.skip(!RUNTIME, 'Run with the opt-in Light Go browser harness')
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }))

test('Light enrolls through the Go runtime with a real PRF passkey and automatically backs up and restores with its passkey', async ({
  page,
  passkey,
}) => {
  void passkey
  const errors: string[] = []
  let backupChallenges = 0
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
    if (url.pathname === '/v1/light/backup/challenge' && response.ok()) {
      const challenge = await response.json()
      expect(challenge.challengeId).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
      expect(Buffer.from(challenge.challenge, 'hex')).toHaveLength(32)
      backupChallenges++
    }
    await route.fulfill({ response })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey spending/ }).click()
  await expect(page.getByRole('heading', { name: 'Set your spending limits' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Invite code' })).toHaveCount(0)
  await page.getByLabel('Per-payment limit, in sats').fill('20000')
  await page.getByLabel('Rolling 24-hour limit, in sats').fill('50000')
  await page.screenshot({ path: '/tmp/vaulted-light-setup-mobile.png', fullPage: true })
  const footer = await page.getByRole('button', { name: 'Create passkey', exact: true }).boundingBox()
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click()
  await expect(page.getByText('Recovery secret', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible({ timeout: 45000 })
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('50,000 sats remaining in your limit')).toBeVisible()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Savings', exact: true }).click()
  await expect(page.getByText('Watch only', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add address', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Watch your Savings' })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Spending', exact: true }).click()
  await page.screenshot({ path: '/tmp/vaulted-light-refined-home.png', fullPage: true })
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
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible({ timeout: 45000 })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByText('Spending limits', { exact: true })).toBeVisible()
  const persistent = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(persistent).not.toContain('recovery-secret')
  expect(persistent).not.toContain('"token"')
  await expect(page.getByText(/Encrypted cloud backup saved/)).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save a local backup', exact: true }).click()
  const path = await (await download).path()
  const saved = JSON.parse(await readFile(path!, 'utf8'))
  expect(backupChallenges).toBeGreaterThan(0)
  expect(saved.name).toBe('vaulted-light-backup')
  expect(saved.header.recoveryBackup).toBeUndefined()
  // Keep the original authenticator but remove this device's app record.
  // Both cloud and local-file restoration retain the same script and policy.
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('vaulted:active-setup', 'light')
  })
  await page.reload()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey spending/ }).click()
  await page.getByRole('button', { name: 'Restore a Light wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Restore with passkey', exact: true }).click()
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.locator('.light-address')).toHaveText(originalAddress)
  // Exercise the downloaded encrypted file independently of cloud discovery.
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey spending/ }).click()
  await page.getByRole('button', { name: 'Restore a Light wallet', exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles(path!)
  await page.getByRole('button', { name: 'Verify file and unlock', exact: true }).click()
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('50,000 sats remaining in your limit')).toBeVisible()
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(page.locator('.light-address')).toHaveText(originalAddress)
  // The same exported file opens in the independent companion with every
  // Vaulted/Operator API blocked; only the local assets and passkey are used.
  const externalRequests: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/emergency-test/')) {
      const name = url.pathname.split('/').pop()!
      if (!['index.html', 'recovery.js', 'recovery.js.map'].includes(name)) return route.abort()
      return route.fulfill({
        body: await readFile(`.vault-browser-tests/light-recovery/mutinynet/${name}`),
        contentType: name.endsWith('.html') ? 'text/html' : 'text/javascript',
      })
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    externalRequests.push(url.pathname)
    return route.abort()
  })
  await page.goto('/emergency-test/index.html')
  await page.locator('#file').setInputFiles(path!)
  await page.locator('#unlock').click()
  await expect(page.getByRole('heading', { name: 'Saved transaction paths' })).toBeVisible()
  await expect(page.locator('#snapshot')).toContainText('0 outputs')
  expect(externalRequests).toEqual([])
  expect(await passkey.credentials()).toHaveLength(1)
  expect(errors).toEqual([])
})
