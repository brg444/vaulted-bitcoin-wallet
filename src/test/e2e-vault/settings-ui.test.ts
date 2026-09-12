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
    test(`native notification settings at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await mockEnrollmentAccess(page, 'open')
      await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
      )
      await page.addInitScript(() => {
        Object.assign(window, { notificationPromptCount: 0 })
        if ('Notification' in window) {
          const original = Notification.requestPermission.bind(Notification)
          Notification.requestPermission = (...args) => {
            const observed = window as unknown as { notificationPromptCount: number }
            observed.notificationPromptCount += 1
            return original(...args)
          }
        }
      })
      await page.goto('/')
      await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
      await page.evaluate(() => window.localStorage.clear())
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      // The native entry uses ordinary styling; the rejected banner controls are gone.
      await expect(page.getByTestId('settings-native-notifications')).toContainText('Device alerts')
      expect(
        await page.evaluate(() => (window as unknown as { notificationPromptCount: number }).notificationPromptCount),
      ).toBe(0)
      await expectWalletLayout(page)
      await page.screenshot({ path: testInfo.outputPath(`settings-${width}-${theme}.png`) })

      await page.getByTestId('settings-native-notifications').click()
      await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
      // Opening settings never requests permission, including when the browser starts denied.
      expect(
        await page.evaluate(() => (window as unknown as { notificationPromptCount: number }).notificationPromptCount),
      ).toBe(0)
      // Rejected in-app banner design stays out of the wallet.
      await expect(page.getByTestId('settings-arrival-banners')).toHaveCount(0)
      await expect(page.getByTestId('settings-notifications')).toHaveCount(0)
      await expect(page.getByTestId('native-notifications-status')).toBeVisible()
      await expectWalletLayout(page)
    })
  }
}

test('native haptic preference remains usable with reduced motion', async ({ page }) => {
  await mockEnrollmentAccess(page, 'open')
  await page.route('**/src/screens/Vault/Welcome.tsx*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: fixtureBody() }),
  )
  await page.goto('/')
  await page.getByTestId('settings-haptics').click()
  const control = page.getByRole('switch', { name: 'Haptic feedback' })
  await expect(control).toBeVisible()
  await expect(control).toHaveAttribute('switch', '')
  await expect(control).toBeChecked()
  await control.click()
  await expect(control).not.toBeChecked()
  await control.click()
  await expect(control).toBeChecked()
  expect(await control.evaluate((element) => getComputedStyle(element).appearance)).not.toBe('none')
  await expectWalletLayout(page)
})
