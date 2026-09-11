import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workerUrl = '/vault-notify-service-worker.js'

function vercelSourceToRegExp(source: string): RegExp | null {
  // Vercel rewrite sources mix :params and raw regex; only the catch-all is a
  // full regex here. Anything else matching the worker path would shadow it.
  if (source.includes('(')) return new RegExp(`^${source}$`)
  const pattern = source.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')
  return new RegExp(`^${pattern}$`)
}

describe('notify worker deployment route', () => {
  it('ships a self-contained worker from public/', () => {
    const path = join(root, 'public', 'vault-notify-service-worker.js')
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/addEventListener\('push'/)
    expect(source).toMatch(/addEventListener\('notificationclick'/)
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/fetch\(/)
  })

  for (const config of ['vercel.json', 'vercel.mainnet.json']) {
    it(`${config} serves the worker as a static asset with no-store headers`, () => {
      const parsed = JSON.parse(readFileSync(join(root, config), 'utf8')) as {
        headers: { source: string; headers: { key: string; value: string }[] }[]
        rewrites: { source: string; destination: string }[]
      }
      // Static dist files preempt rewrites on Vercel; the headers entry proves
      // the deploy treats this path as a static asset, like the wallet worker.
      const headers = parsed.headers.find((h) => h.source === workerUrl)
      expect(headers).toBeDefined()
      expect(headers!.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store, max-age=0' })
      // No rewrite shadows the worker before static preemption except the
      // static-preempted SPA catch-all.
      const matching = parsed.rewrites.filter((r) => vercelSourceToRegExp(r.source)?.test(workerUrl))
      expect(matching.map((r) => r.destination)).toEqual(['/index.html'])
      // The worker scope has no server route: it is client-side only.
      expect(parsed.rewrites.some((r) => vercelSourceToRegExp(r.source)?.test('/__vault-notify/'))).toBe(true)
      // CSP allows same-origin worker registration.
      const csp = parsed.headers.find((h) => h.source === '/(.*)')!.headers.find((h) => h.key === 'Content-Security-Policy')!.value
      expect(csp).toMatch(/worker-src 'self'/)
    })
  }

  it('keeps release env flags unchanged', () => {
    for (const config of ['vercel.json', 'vercel.mainnet.json']) {
      const parsed = JSON.parse(readFileSync(join(root, config), 'utf8')) as { env: Record<string, string> }
      expect(parsed.env).toMatchObject({
        VAULT_RELEASE_NETWORK: 'mainnet',
        VITE_VAULT_LIGHTNING_SEND: 'true',
        VITE_VAULT_LIGHTNING_RECEIVE: 'true',
        VITE_VAULT_LNURL: 'true',
      })
    }
  })
})
