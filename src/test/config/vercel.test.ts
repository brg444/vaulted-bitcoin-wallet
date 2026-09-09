import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Vercel worker caching', () => {
  it.each(['/vault-wallet-service-worker.mjs'])('serves %s without caching', (source) => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[]
    }
    expect(config.headers.find((entry) => entry.source === source)?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'no-store, max-age=0',
    })
  })

  it('restricts connections to the configured services and pinned Lightning endpoints', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[]
    }
    const csp = config.headers
      .find((entry) => entry.source === '/(.*)')
      ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value
    const connectSrc = csp
      ?.split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'connect-src')

    expect(connectSrc).toEqual([
      'connect-src',
      "'self'",
      'https://emulator.mutinynet.arkade.sh',
      'https://mutinynet.arkade.sh',
      'https://blockchain.info',
      'wss://nostr.arkade.sh',
    ])
  })

  it.each(['vercel.json', 'vercel.mainnet.json'])('routes open enrollment through a flat function in %s', (file) => {
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    const session = config.rewrites.findIndex((entry) => entry.source === '/v1/enroll/session')
    const enrollment = config.rewrites.findIndex((entry) => entry.source === '/v1/enroll/:action')
    expect(session).toBeGreaterThanOrEqual(0)
    expect(session).toBeLessThan(enrollment)
    expect(config.rewrites[session].destination).toBe('/api/gateway?route=enroll-session')
    expect(readFileSync('api/gateway.ts', 'utf8')).toContain('./authorizer/[...path].js')
  })

  it.each(['vercel.json', 'vercel.mainnet.json'])(
    'routes Light enrollment through the existing gateway in %s',
    (file) => {
      const config = JSON.parse(readFileSync(file, 'utf8')) as {
        rewrites: { source: string; destination: string }[]
      }
      expect(config.rewrites).toContainEqual({
        source: '/v1/light/renew/:phase',
        destination: '/api/gateway?route=light-renew&phase=:phase',
      })
      expect(config.rewrites).toContainEqual({
        source: '/v1/light/enroll/:phase',
        destination: '/api/gateway?route=light-enroll&phase=:phase',
      })
      expect(config.rewrites).toContainEqual({
        source: '/v1/recovery-archive/:phase',
        destination: '/api/gateway?route=recovery-archive&phase=:phase',
      })
      expect(config.rewrites).toContainEqual({
        source: '/v1/light/backup/:phase',
        destination: '/api/gateway?route=light-backup&phase=:phase',
      })
    },
  )

  it.each(['vercel.json', 'vercel.mainnet.json'])(
    'routes connector authorization and operation reads through flat functions in %s',
    (file) => {
      const config = JSON.parse(readFileSync(file, 'utf8'))
      expect(config.rewrites).toContainEqual({
        source: '/v1/connector/operation',
        destination: '/api/v1/connector-operation',
      })
      expect(config.rewrites).toContainEqual({
        source: '/v1/connector/withdraw/authorize',
        destination: '/api/v1/connector-withdraw-authorize',
      })
    },
  )

  it('routes readiness through the authorizer gateway', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    expect(config.rewrites).toContainEqual({
      source: '/health',
      destination: '/api/gateway?route=health',
    })
    expect(config.rewrites).toContainEqual({
      source: '/ready',
      destination: '/api/gateway?route=ready',
    })
  })

  it('routes every nested boarding phase through a flat serverless function', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    expect(config.rewrites).toContainEqual({
      source: '/v1/vtxo/board/:phase',
      destination: '/api/gateway?route=board&phase=:phase',
    })
    expect(config.rewrites).toContainEqual({
      source: '/v1/kit',
      destination: '/api/kit',
    })
  })

  it('keeps the mainnet deployment explicit and isolated from Mutinynet', () => {
    const config = JSON.parse(readFileSync('vercel.mainnet.json', 'utf8')) as {
      buildCommand: string
      env?: Record<string, string>
      headers: { source: string; headers: { key: string; value: string }[] }[]
      rewrites: { source: string; destination: string }[]
    }
    const csp = config.headers
      .find((entry) => entry.source === '/(.*)')
      ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value
    const connectSrc = csp
      ?.split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'connect-src')

    expect(config.buildCommand).toBe('pnpm build:mainnet')
    expect(config.env).toEqual({
      VAULT_RELEASE_NETWORK: 'mainnet',
      VITE_VAULT_RELEASE_NETWORK: 'mainnet',
      VITE_VAULT_LIGHTNING_SEND: 'true',
    })
    expect(config.rewrites).toContainEqual({
      source: '/esplora/:path*',
      destination: 'https://mempool.space/api/:path*',
    })
    expect(connectSrc).toEqual([
      'connect-src',
      "'self'",
      'https://ln.getvaulted.xyz',
      'https://emulator.arkade.computer',
      'https://arkade.computer',
      'https://mempool.arkade.sh',
      'wss://mempool.arkade.sh',
      'https://blockchain.info',
      'wss://nostr.arkade.sh',
    ])
    expect(csp).not.toContain('mutinynet')
    expect(csp).not.toContain('app.getvaulted.xyz')
    expect(config.rewrites).toContainEqual({
      source: '/v1/lnurl/:phase',
      destination: '/api/gateway?route=lnurl&phase=:phase',
    })
    expect(JSON.stringify(config)).not.toContain('mutinynet')
  })

  it('does not put mainnet origins or the production wallet host in the Mutinynet deployment', () => {
    const config = readFileSync('vercel.json', 'utf8')
    expect(config).toContain('mutinynet')
    expect(config).not.toContain('arkade.computer')
    expect(config).not.toContain('app.getvaulted.xyz')
    expect(config).not.toContain('mempool.space')
  })
})
