import { expect, test } from '@playwright/test'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import { expectWalletLayout } from './fixtures/layout'

// Render the real Settings screen with default device preferences. No
// payment, history, or recovery action runs; toggles only persist locally.
function fixtureBody(): string {
  return `
    import React from '/node_modules/.vite/deps/react.js';
    import { ToastProvider } from '/src/components/Toast.tsx';
    import { VaultContext } from '/src/vault/context.ts';
    import Settings from '/src/screens/Vault/Settings.tsx';
    export default function SettingsFixture() {
      const current = React.useContext(VaultContext);
      return React.createElement(ToastProvider, null,
        React.createElement(VaultContext.Provider, { value: {
          ...current, busy: false, liveNetwork: true, navigate: () => {},
          refreshBalance: async () => {}, reset: async () => {}, status: null,
        }}, React.createElement(Settings)));
      }
  `
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`notification preferences toggle at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
      )
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await page.evaluate(() => window.localStorage.clear())
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await expect(page.getByTestId('settings-notifications')).toContainText('On')
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`settings-${width}-${theme}.png`) })

      await page.getByTestId('settings-notifications').click()
      await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
      const banners = page.getByTestId('settings-arrival-banners')
      const haptics = page.getByTestId('settings-arrival-haptics')
      await expect(banners).toHaveAttribute('aria-checked', 'true')
      await expect(haptics).toHaveAttribute('aria-checked', 'true')
      await expectWalletLayout(page)

      await banners.click()
      await expect(banners).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('settings-notifications')).toBeHidden()
      await page.getByTestId('header-back').click()
      await expect(page.getByTestId('settings-notifications')).toContainText('Off')
      expect(await page.evaluate(() => window.localStorage.getItem('arkade-vault-arrival-banners'))).toBe('0')

      // Disabled banners persist across reload; haptics stay independent.
      await page.reload()
      await expect(page.getByTestId('settings-notifications')).toContainText('Off')
      await page.getByTestId('settings-notifications').click()
      await haptics.click()
      await expect(haptics).toHaveAttribute('aria-checked', 'false')
      expect(await page.evaluate(() => window.localStorage.getItem('arkade-vault-arrival-haptics'))).toBe('0')
      expect(await page.evaluate(() => window.localStorage.getItem('arkade-vault-haptics'))).toBeNull()
      await expectWalletLayout(page)
    })
  }
}
