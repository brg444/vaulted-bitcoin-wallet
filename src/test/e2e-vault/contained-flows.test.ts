import { CONNECTOR_TEST_DESCRIPTOR } from './fixtures/connector'
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

test('another vault on the same device accepts a different editable hardware descriptor', async ({
  page,
  authorizer,
  passkey,
}) => {
  void passkey
  await reachPasskeySetup(page)
  await page.getByTestId('enrollment-token').fill(authorizer.invite)
  await page.getByRole('button', { name: 'Create Vault' }).click()
  await page.getByRole('button', { name: 'I’ll save a separate copy later' }).click()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByTestId('settings-signout').click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Set up another vault' }).click()
  await page.getByRole('button', { name: /^Standard/ }).click()
  const descriptor = page.getByRole('textbox', { name: 'Wallet descriptor' })
  await expect(descriptor).toBeEditable()
  await expect(descriptor).toBeEmpty()
  await descriptor.fill(CONNECTOR_TEST_DESCRIPTOR.replace('/0/*)', '/1/*)'))
  await page.getByRole('button', { name: 'Use this hardware key' }).click()
  await expect(page.getByRole('heading', { name: 'Spending limits', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(descriptor).toHaveValue(CONNECTOR_TEST_DESCRIPTOR.replace('/0/*)', '/1/*)'))
  await expect(descriptor).toBeEditable()
})
