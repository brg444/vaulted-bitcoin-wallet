import type { Page } from '@playwright/test'

/** Read the exact destination copied by the shared Receive screen. */
export async function copyArkadeReceiveAddress(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByTestId('receive-arkade-address').click()
  return page.evaluate(() => navigator.clipboard.readText())
}
