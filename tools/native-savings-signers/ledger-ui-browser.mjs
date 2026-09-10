// Public fixtures only: checks rendered Ledger flows without a connected signer.
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'tools/native-savings-signers/evidence/ledger-ui'
mkdirSync(output, { recursive: true })
const server = await createServer({
  root,
  configFile: false,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  define: { __VAULT_E2E_OPERATOR_ORIGIN__: '""', 'import.meta.env.VITE_VAULT_RELEASE_NETWORK': '"mainnet"' },
})
const browser = await chromium.launch({ headless: true })
const results = []
try {
  await server.listen()
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tools/native-savings-signers/ledger-client-browser.html`,
    )
    await page.evaluate(async (width) => {
      const { setupLedgerUi } = await import('/tools/native-savings-signers/ledger-ui-fixture.js')
      await setupLedgerUi(width)
    }, width)
    for (const flow of ['receive', 'setup', 'plan', 'payment', 'recovery']) {
      await page.evaluate((flow) => window.showLedgerFixture(flow), flow)
      await page.locator('.qg-screen').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const text = await page.locator('body').innerText()
      if (/signer reserve|Import unsigned deposit|240-sat anchor/.test(text))
        throw new Error(`Connector copy in ${flow}`)
      if (flow === 'receive') await page.getByRole('img', { name: 'Payment request QR code' }).waitFor()
      if (flow === 'payment' && (!text.includes('20,000 sats') || !text.includes('1,000 sats')))
        throw new Error('Payment amount or fee not rendered')
      if (flow === 'plan' && (!text.includes('offline recovery tool') || !text.includes('bypass the recovery delay')))
        throw new Error('Accepted recovery tradeoff missing from setup review')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      if (overflow) throw new Error(`Horizontal overflow at ${width}px: ${flow}`)
      await page.screenshot({ path: `${output}/${flow}-${width}.png`, fullPage: true })
      results.push({ width, flow, horizontalOverflow: false })
    }
    if (errors.length) throw new Error(errors.join('\n'))
    await page.close()
  }
  writeFileSync(
    output + '/result.json',
    JSON.stringify({ scope: 'Rendered public fixtures; no hardware approval', results }, null, 2) + '\n',
  )
  console.log(JSON.stringify(results))
} finally {
  await browser.close()
  await server.close()
}
