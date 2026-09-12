import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'

// Exercise the compiled app with a mainnet service response. Headers alone
// cannot detect a mainnet deployment accidentally built with Mutinynet defaults.
const root = resolve(import.meta.dirname, '..')
const pack = JSON.parse(await readFile(resolve(root, 'src/lib/vault/contract-pack.mainnet.json'), 'utf8'))
const schema = pack.programs['vault-policy-v1'].policySchema
const origin = 'https://rc.getvaulted.xyz'
const publicStatus = {
  network: 'mainnet',
  clientOrigin: origin,
  rpId: 'rc.getvaulted.xyz',
  templateVersion: 'vaulted-spending-v1',
  policyVersion: schema.schema,
  enrollmentMode: 'token',
  spendingPolicyCapabilities: {
    program: schema.program,
    schema: schema.schema,
    period: schema.period,
    bounds: schema.bounds,
    presets: Object.entries(schema.presets).map(([id, policy]) => ({
      id,
      label: id === 'lower-exposure' ? 'Lower exposure' : 'Everyday',
      policy: { program: schema.program, schema: schema.schema, period: schema.period, ...policy },
    })),
  },
}
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const browser = await chromium.launch()
try {
  for (const network of ['mainnet', 'mutinynet']) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      await context.addInitScript(() => {
        window.passkeyRequests = []
        Object.defineProperty(navigator, 'credentials', {
          value: {
            get: async (options) => {
              window.passkeyRequests.push(options.publicKey.rpId)
              return null
            },
          },
        })
      })
      // No requests leave this isolated browser, and no real credentials are used.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) return route.abort()
        if (url.pathname === '/v1/status') return route.fulfill({ json: { ...publicStatus, network } })
        if (url.pathname.startsWith('/v1/')) return route.fulfill({ status: 503, json: { ok: false } })
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        try {
          const body = await readFile(resolve(root, 'dist', file))
          return route.fulfill({ body, contentType: contentTypes[extname(file)] || 'application/octet-stream' })
        } catch {
          return route.fulfill({ status: 404 })
        }
      })
      const page = await context.newPage()
      await page.goto(origin)
      await page.getByRole('button', { name: 'Sign in to an existing vault' }).click()
      if (network === 'mainnet') {
        await page.waitForFunction(() => window.passkeyRequests.length === 1, null, { timeout: 10_000 })
        assert.deepEqual(await page.evaluate(() => window.passkeyRequests), ['rc.getvaulted.xyz'])
      } else {
        await page.getByText('Something went wrong. Try again.', { exact: true }).waitFor()
        assert.deepEqual(await page.evaluate(() => window.passkeyRequests), [])
      }
    } finally {
      await context.close()
    }
  }
  console.log('Compiled mainnet app accepts mainnet policy and rejects Mutinynet before requesting a passkey.')
} finally {
  await browser.close()
}
