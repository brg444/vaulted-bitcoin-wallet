import { expect, test } from '@playwright/test'
import { openLight } from './fixtures/light-ui'

test.skip(process.env.VITE_VAULT_LIGHTNING_SEND !== 'true', 'Lightning send release profile')

const MUTINYNET_INVOICE =
  'lntbs21u1p4ghty5pp500cgfavsavx2prgw3vm4s6ckrjvg9zyjx3k87segw240hr2l2glqdqqcqzzsxqyz5vqsp56tscwj6zyk4k9g2xm4r0tf7s6xemuq2rqm7vea0tfymmzwapaqlq9qxpqysgq49fj3f48wy2utl25xzs8tjg7ak89p3242p2h3e9rk20alxajjqarjusq8222fsa9ncy43ucslfdcdtld2pd58hcxtndmjf0sfyqsf2qpsf0h6s'
const MUTINYNET_INVOICE_TIMESTAMP = 1_787_538_580

test('@ux-lightning a valid invoice reaches the passkey boundary', async ({ page }) => {
  await page.clock.setSystemTime((MUTINYNET_INVOICE_TIMESTAMP + 1) * 1000)
  await page.addInitScript(() => {
    window.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('button')?.textContent?.trim() === 'Review payment') {
        document.documentElement.dataset.lightningPasskeyInClick = String(
          document.documentElement.dataset.lightningPasskeyRequested === 'true',
        )
      }
    })
    // Stub navigator directly, including browser builds without an exposed
    // CredentialsContainer constructor or a platform authenticator.
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: async () => {
          document.documentElement.dataset.lightningPasskeyRequested = 'true'
          document.documentElement.dataset.lightningPasskeyActive = String(navigator.userActivation.isActive)
          throw new Error('E2E passkey boundary reached')
        },
      },
    })
  })
  await openLight(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(MUTINYNET_INVOICE)
  await expect(page.getByRole('button', { name: 'Review payment', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Review payment', exact: true }).tap()
  await expect(page.locator('html')).toHaveAttribute('data-lightning-passkey-requested', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-lightning-passkey-in-click', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-lightning-passkey-active', 'true')
})

test('@ux-lightning explains a rejected invoice before passkey approval', async ({ page }) => {
  await page.clock.setSystemTime(4_000_000_000_000)
  await openLight(page)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(MUTINYNET_INVOICE)
  await expect(page.getByRole('alert')).toHaveText('This Lightning invoice has expired.')
  await expect(page.getByRole('button', { name: 'Review payment', exact: true })).toBeDisabled()
})
