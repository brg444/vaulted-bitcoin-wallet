import { CONNECTOR_TEST_DESCRIPTOR } from './fixtures/connector'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'

test.beforeEach(async ({ page }) => {
  await mockEnrollmentAccess(page)
})

const ENROLLMENT_MODULE = '/src/lib/vault/enrollmentStore.ts'

async function expectNoBlockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }))
  expect(blocking).toEqual([])
}

test('@polish welcome is accessible and visually stable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Everyday spending.', { exact: false })).toBeVisible()
  await expect(page.getByText('Setup needs an invite and a compatible hardware wallet.')).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('welcome.png', { animations: 'disabled', fullPage: true })

  await page.evaluate(
    async ({ fixture, modulePath }) => {
      const store = await import(/* @vite-ignore */ modulePath)
      store.saveSelectedVaultId('visual-signin')
      store.saveEnrollment({
        vaultId: 'visual-signin',
        credId: '11'.repeat(32),
        webauthnP256: fixture.phoneDirectP256,
        phoneDirectP256: fixture.phoneDirectP256,
        phoneBip340Pub: fixture.phonePub,
        nonce: '22'.repeat(12),
        ciphertext: '33'.repeat(48),
      })
    },
    { fixture: PROGRAM_FIXTURE, modulePath: ENROLLMENT_MODULE },
  )
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Sign in with your passkey' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('sign-in.png', { animations: 'disabled', fullPage: true })
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Get started' }).click()
  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-how-it-works.png', { animations: 'disabled', fullPage: true })
})

test('@polish every onboarding decision is accessible and visually stable', async ({ context, page }) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Hardware key', exact: true })).toBeVisible()
  const hardwarePub = page.getByTestId('hardware-pub')
  await hardwarePub.fill(CONNECTOR_TEST_DESCRIPTOR)
  await hardwarePub.blur()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-hardware.png', { animations: 'disabled', fullPage: true })

  await page.getByRole('button', { name: 'Use this hardware key' }).click()
  await expect(page.getByRole('heading', { name: 'Protection', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-protection-standard.png', {
    animations: 'disabled',
    fullPage: true,
  })
  await page.getByTestId('protection-advanced').click()
  await expect(page.getByTestId('recovery-pub')).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-protection-advanced.png', {
    animations: 'disabled',
    fullPage: true,
  })
  await page.getByTestId('protection-standard').click()
  await page.getByRole('button', { name: 'Continue with Standard' }).click()

  await expect(page.getByRole('heading', { name: 'Spending limits', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-spending-limits.png', {
    animations: 'disabled',
    fullPage: true,
  })
  await expect(page.getByTestId('policy-tx-cap')).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-spending-limits-custom.png', {
    animations: 'disabled',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Review setup' }).click()

  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-review.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Secure this device' })).toBeVisible()
  await expect(page.getByTestId('enrollment-token')).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('onboarding-device.png', { animations: 'disabled', fullPage: true })
})

test('@polish render failures are safe, accessible, and visually stable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      configurable: true,
      value: () => '00000000-0000-4000-8000-000000000000',
    })
    Object.defineProperty(Storage.prototype, 'getItem', {
      configurable: true,
      value() {
        throw new Error(`raw render payload tb1q${'q'.repeat(40)}`)
      },
    })
  })
  await page.goto('/')
  await expect(page.getByText('Vaulted could not display this screen.')).toBeVisible()
  await expect(page.getByText(/^Incident reference: VLT-/)).toBeVisible()
  await expect(page.getByText(/raw render payload/)).toHaveCount(0)
  await expectNoBlockingAxeViolations(page)
  await expect(page).toHaveScreenshot('render-error.png', { animations: 'disabled', fullPage: true })
})
