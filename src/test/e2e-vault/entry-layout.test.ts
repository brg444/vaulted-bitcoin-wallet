import { expect, test } from '@playwright/test'

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
]) {
  for (const entry of ['welcome', 'unlock'] as const) {
    test(`@visual-refinement ${entry} keeps its content and recovery actions accessible at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport)
      // These entry screens must remain usable when the service is unavailable.
      await page.route('**/v1/**', (route) =>
        route.fulfill({ status: 503, json: { error: 'Synthetic offline service' } }),
      )
      await page.goto('/')
      if (entry === 'unlock') {
        await page.evaluate(
          async ([storePath, fixturePath]) => {
            const store = await import(/* @vite-ignore */ storePath)
            const { PROGRAM_FIXTURE: fixture } = await import(/* @vite-ignore */ fixturePath)
            // A locked enrollment needs no live status, address pin, or network policy.
            store.saveEnrollment({
              vaultId: fixture.vaultId,
              credId: '11'.repeat(32),
              webauthnP256: fixture.phoneDirectP256,
              phoneDirectP256: fixture.phoneDirectP256,
              phoneBip340Pub: fixture.phonePub,
              nonce: '22'.repeat(12),
              ciphertext: '33'.repeat(48),
            })
            store.saveSelectedVaultId(fixture.vaultId)
            store.setSessionLocked(true)
          },
          ['/src/lib/vault/enrollmentStore.ts', '/src/lib/vault/program/fixtures.ts'],
        )
        await page.reload()
      }
      const root = page.locator(`.qg-screen-${entry}`)
      await expect(root).toBeVisible()
      const heading = root.locator('h1')
      await expect(heading).toBeInViewport({ ratio: 1 })
      const bounds = await root.evaluate((node) => {
        const main = node.querySelector('main')!,
          footer = node.querySelector('footer')!,
          heading = main.querySelector('h1')!
        return {
          headingBottom: heading.getBoundingClientRect().bottom,
          mainBottom: main.getBoundingClientRect().bottom,
          mainHeight: main.clientHeight,
          mainScrollHeight: main.scrollHeight,
          footerTop: footer.getBoundingClientRect().top,
        }
      })
      expect(bounds.headingBottom).toBeLessThanOrEqual(bounds.mainBottom)
      expect(bounds.mainScrollHeight).toBeLessThanOrEqual(bounds.mainHeight + 1)
      expect(bounds.footerTop).toBeGreaterThanOrEqual(bounds.mainBottom - 1)
      await page.screenshot({ path: testInfo.outputPath(`${entry}-${viewport.width}-content.png`) })
      for (const name of [
        'Access and recovery help',
        'Restore encrypted cloud backup',
        'Restore encrypted backup from a file',
        entry === 'welcome' ? 'Get started' : 'Unlock with passkey',
      ]) {
        const button = root.getByRole('button', { name, exact: true })
        await button.scrollIntoViewIfNeeded()
        await expect(button).toBeInViewport({ ratio: 1 })
        expect(
          await button.evaluate((node) => {
            const box = node.getBoundingClientRect()
            return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
          }),
        ).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${entry}-${viewport.width}-actions.png`) })
    })
  }
}
