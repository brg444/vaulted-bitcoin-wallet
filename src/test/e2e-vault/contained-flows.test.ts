import { test, expect, reachPasskeySetup } from './fixtures/passkey'

for (const height of [667, 844]) {
  test(`backup and Help preserve the primary action at 375 by ${height}`, async ({ page, authorizer, passkey }) => {
    void passkey
    await page.setViewportSize({ width: 375, height })
    await reachPasskeySetup(page)
    await page.getByTestId('enrollment-token').fill(authorizer.invite)
    await page.getByRole('button', { name: 'Create Vault' }).click()
    const download = page.getByRole('button', { name: 'Download Recovery Kit', exact: true })
    await expect(download).toBeInViewport({ ratio: 1 })
    await download.click()
    const next = page.getByRole('button', { name: 'Open your Vault', exact: true })
    await expect(next).toBeInViewport({ ratio: 1 })
    await expect(next).toBeDisabled()
    expect(await page.locator('.qg-main').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    await page.getByRole('button', { name: 'Access and recovery help' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Wallet help' })).not.toBeVisible()
    await expect(page.getByRole('checkbox')).toBeChecked()
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page.getByTestId('account-switcher')).toBeVisible()
  })
}
