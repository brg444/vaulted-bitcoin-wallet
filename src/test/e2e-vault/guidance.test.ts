import { expect, test } from '@playwright/test'
import { buildVaultProgramDescriptor } from '../../lib/vault/program/descriptor'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { buildRecoveryKit } from '../../lib/vault/program/kit'

for (const dark of [false, true]) {
  test(`@visual-refinement access help works before sign-in (${dark ? 'dark' : 'light'})`, async ({
    page,
  }, testInfo) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    await page.getByRole('button', { name: 'Access and recovery help' }).click()
    await page.evaluate((value) => document.documentElement.classList.toggle('palette-dark', value), dark)
    await page.getByRole('radio', { name: 'Both keys are unavailable' }).click()
    await expect(page.getByText(/Check your saved Recovery Kit to identify/)).toBeVisible()
    await page.getByText('Check a saved Recovery Kit', { exact: true }).click()
    const kit = buildRecoveryKit(
      buildVaultProgramDescriptor({ ...PROGRAM_FIXTURE, protectionTier: 'standard', recoveryPub: undefined }),
    )
    await page
      .getByLabel('Recovery Kit file')
      .setInputFiles({ name: 'saved-kit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(kit)) })
    await expect(page.getByText(/This kit uses Standard protection/)).toBeVisible()
    await page.getByRole('button', { name: 'Go back' }).click()
    await page.getByRole('radio', { name: 'The service is unavailable' }).click()
    await expect(
      page
        .getByRole('region', { name: 'Recovery guidance' })
        .getByText(/Starting a new delayed recovery requires both services/),
    ).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    expect(overflow).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('access-help.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close help' }).click()
    await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible()
    await expect(page.getByTestId('account-switcher')).toHaveCount(0)
  })
}
