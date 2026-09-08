import { UR, UREncoder } from '@ngraveio/bc-ur'
import { CONNECTOR_TEST_DESCRIPTOR } from './fixtures/connector'
import { test, expect, reachPasskeySetup } from './fixtures/passkey'

const descriptorQrEncoder = new UREncoder(UR.fromBuffer(Buffer.from(CONNECTOR_TEST_DESCRIPTOR)), 30)
const descriptorQrParts = Array.from({ length: descriptorQrEncoder.fragmentsLength }, () =>
  descriptorQrEncoder.nextPart(),
).reverse()

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
    await expect(next).toBeEnabled()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    await page.getByRole('button', { name: 'Access and recovery help' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Wallet help' })).not.toBeVisible()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
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
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  const descriptor = page.getByRole('textbox', { name: 'Wallet descriptor' })
  await expect(descriptor).toBeEditable()
  await expect(descriptor).toBeEmpty()
  await descriptor.fill(CONNECTOR_TEST_DESCRIPTOR.replace('/0/*)', '/1/*)'))
  await page.getByRole('button', { name: 'Use this hardware key' }).click()
  await expect(page.getByRole('heading', { name: 'Spending limits', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect(descriptor).toHaveValue(CONNECTOR_TEST_DESCRIPTOR.replace('/0/*)', '/1/*)'))
  await expect(descriptor).toBeEditable()
})

test('descriptor upload, QR fallback, and animated QR decoding preserve editable review', async ({
  page,
  authorizer,
}) => {
  void authorizer
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: /^Standard/ }).click()
  await page.getByLabel('Descriptor file', { exact: true }).setInputFiles({
    name: 'descriptor.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      `# Receive descriptor:\n${CONNECTOR_TEST_DESCRIPTOR}\n# Change descriptor:\n${CONNECTOR_TEST_DESCRIPTOR.replace('/0/*)', '/1/*)')}`,
    ),
  })
  await expect(page.getByText('Review imported descriptor')).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Wallet descriptor' })
  await expect(input).toHaveValue(CONNECTOR_TEST_DESCRIPTOR)
  const result = await page.evaluate(async (parts) => {
    const source = '/src/lib/vault/descriptorQr.ts'
    const { DescriptorQrDecoder } = await import(source)
    const decoder = new DescriptorQrDecoder('mutinynet')
    let result
    for (const part of parts) result = decoder.receive(part)
    return result
  }, descriptorQrParts)
  expect(result.descriptor).toBe(CONNECTOR_TEST_DESCRIPTOR)
  await page.getByRole('button', { name: 'Scan descriptor QR code' }).click()
  await expect(page.getByRole('heading', { name: 'Scan wallet descriptor' })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input).toHaveValue(CONNECTOR_TEST_DESCRIPTOR)
  await expect(input).toBeEditable()
})
