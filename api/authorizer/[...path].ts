import { createHash } from 'node:crypto'
import { isMainnetWalletHost } from '../mainnetHosts.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
])

// fetch() rebuffers the body, so these would lie about the bytes we send.
const REBUFFERED = new Set(['accept-encoding', 'content-encoding', 'content-length', 'content-md5'])

export const MAX_GATEWAY_BYTES = 1024 * 1024
export const GATEWAY_UPSTREAM_TIMEOUT_MS = 20_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 60
const LOCAL_CACHE_CONTROL = 'no-store, max-age=0'

const FLAT_VTXO_PATHS: Record<string, string> = {
  '/api/v1/vtxo-operation': '/v1/vtxo/operation',
  '/api/v1/vtxo-reserve': '/v1/vtxo/reserve',
  '/api/v1/vtxo-abort': '/v1/vtxo/abort',
  '/api/v1/vtxo-authorize': '/v1/vtxo/authorize',
  '/api/v1/vtxo-checkpoints-authorize': '/v1/vtxo/checkpoints/authorize',
  '/api/v1/vtxo-finalize': '/v1/vtxo/finalize',
}

const BOARD_PHASES = new Set(['prepare', 'register', 'release', 'final'])

const rateBuckets = new Map<string, { count: number; resetAt: number }>()

function authorizerOrigin(): string {
  return String(process.env.AUTHORIZER_ORIGIN || '').replace(/\/$/, '')
}

function gatewaySecret(): string {
  return String(process.env.AUTHORIZER_GATEWAY_SECRET || '').trim()
}

export function isMainnetGatewayRelease(value = process.env.VAULT_RELEASE_NETWORK): boolean {
  return String(value || '').trim() === 'mainnet'
}

export function allowAuthorizerPath(path: string): boolean {
  return path === '/health' || path === '/ready' || path === '/v1' || path.startsWith('/v1/')
}

function requestHost(hostHeader: string | string[] | undefined): string {
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  return String(host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
}

// Browser CSRF filter only. Missing Origin/Sec-Fetch-Site is allowed so
// non-browser callers can use the public cryptographically authorized API.
// This is not caller authentication.
export function sameOriginAllowed(input: {
  host?: string | string[]
  origin?: string | string[]
  secFetchSite?: string | string[]
}): boolean {
  const site = String(Array.isArray(input.secFetchSite) ? input.secFetchSite[0] : input.secFetchSite || '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = String(Array.isArray(input.origin) ? input.origin[0] : input.origin || '').trim()
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === requestHost(input.host)
  } catch {
    return false
  }
}

export function allowGatewayRate(key: string, now = Date.now()): boolean {
  const id = String(key || 'unknown')
  const bucket = rateBuckets.get(id)
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(id, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (bucket.count >= RATE_LIMIT) return false
  bucket.count += 1
  return true
}

function rateIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function requestVaultId(pathAndQuery: string, body?: Buffer): string {
  const query = new URLSearchParams(pathAndQuery.split('?')[1] || '')
  const fromQuery = query.get('vault') || query.get('vaultId') || ''
  if (fromQuery) return fromQuery
  if (!body?.byteLength) return ''
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { vaultId?: unknown }
    return typeof parsed.vaultId === 'string' ? parsed.vaultId : ''
  } catch {
    return ''
  }
}

export async function allowMainnetGatewayRate(
  client: string,
  vaultId = '',
  enrollmentSession = false,
): Promise<boolean> {
  const origin = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '')
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
  if (!origin || !token) throw new Error('shared durable rate limit is not configured')
  const window = Math.floor(Date.now() / RATE_WINDOW_MS)
  const keys = [`vault-rate:client:${rateIdentity(client)}:${window}`]
  if (vaultId) keys.push(`vault-rate:vault:${rateIdentity(vaultId)}:${window}`)
  if (enrollmentSession) keys.push(`vault-rate:enrollment:${rateIdentity(client)}:${window}`)
  const commands = keys.flatMap((key) => [
    ['INCR', key],
    ['PEXPIRE', key, String(RATE_WINDOW_MS * 2), 'NX'],
  ])
  const response = await fetch(`${origin}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error('shared durable rate limit is unavailable')
  const results = (await response.json()) as { result?: unknown; error?: unknown }[]
  return keys.every(
    (_, index) =>
      Number(results[index * 2]?.result) <= (enrollmentSession && index === keys.length - 1 ? 5 : RATE_LIMIT) &&
      !results[index * 2]?.error,
  )
}

export function clientAddress(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (first) return String(first).split(',')[0].trim()
  return String(headers['x-real-ip'] || 'unknown')
}

type VercelLikeReq = {
  method?: string
  headers: Record<string, string | string[] | undefined>
  query?: { path?: string | string[] }
  url?: string
  on(event: 'data', fn: (chunk: Buffer) => void): void
  on(event: 'end', fn: () => void): void
  on(event: 'error', fn: (err: Error) => void): void
}

type VercelLikeRes = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string | Buffer): void
}

export function publicAuthorizerPath(url = ''): string {
  const q = url.includes('?') ? url.slice(url.indexOf('?')) : ''
  const raw = (url.split('?')[0] || '/').replace(/\/+$/, '') || '/'
  if (raw === '/api/health' || raw === '/health') return '/health' + q
  if (raw === '/api/ready' || raw === '/ready') return '/ready' + q
  if (FLAT_VTXO_PATHS[raw]) return FLAT_VTXO_PATHS[raw] + q
  if (raw.startsWith('/api/authorizer/')) return raw.slice('/api/authorizer'.length) + q
  if (raw === '/api/authorizer') return '/' + q
  if (raw === '/api/gateway') {
    const params = new URLSearchParams(q)
    const route = params.get('route') || ''
    if (route === 'health') return '/health'
    if (route === 'ready') return '/ready'
    if (route === 'enroll-session') return '/v1/enroll/session'
    const phase = params.get('phase') || ''
    if (route === 'light-renew' && new Set(['prepare', 'register', 'final', 'status', 'release']).has(phase))
      return `/v1/light/renew/${phase}`
    if (route === 'light-enroll' && new Set(['start', 'propose', 'finish']).has(phase))
      return `/v1/light/enroll/${phase}`
    if (route === 'board' && BOARD_PHASES.has(phase)) return `/v1/vtxo/board/${phase}`
    return raw + q
  }
  if (raw.startsWith('/api/v1')) return raw.slice('/api'.length) + q
  return raw + q
}

function targetPath(req: VercelLikeReq): string {
  if (req.url) return publicAuthorizerPath(req.url)
  const parts = req.query?.path
  const joined = Array.isArray(parts) ? parts.join('/') : String(parts || '')
  return '/' + joined.replace(/^\/+/, '')
}

function declaredLength(headers: Record<string, string | string[] | undefined>): number {
  const raw = headers['content-length']
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

export function readBoundedRequest(req: VercelLikeReq, maxBytes = MAX_GATEWAY_BYTES): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return Promise.resolve(undefined)
  const declared = declaredLength(req.headers)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new Error('API request too large'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.byteLength
      if (total > maxBytes) {
        reject(new Error('API request too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined))
    req.on('error', () => reject(new Error('gateway body')))
  })
}

export async function readBoundedUpstream(res: Response, maxBytes = MAX_GATEWAY_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('API response too large')
  }
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error('API response too large')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('API response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function localResponse(res: VercelLikeRes) {
  res.setHeader('Cache-Control', LOCAL_CACHE_CONTROL)
}

function jsonError(res: VercelLikeRes, status: number, message: string) {
  localResponse(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: message }))
}

export default async function handler(req: VercelLikeReq, res: VercelLikeRes) {
  const origin = authorizerOrigin()
  if (!origin) {
    jsonError(res, 503, 'vault service is not running')
    return
  }
  const pathAndQuery = targetPath(req)
  const pathOnly = pathAndQuery.split('?')[0]
  if (!allowAuthorizerPath(pathOnly)) {
    localResponse(res)
    res.statusCode = 404
    res.end()
    return
  }
  if (!sameOriginAllowed(req.headers)) {
    jsonError(res, 403, 'cross-origin authorizer access denied')
    return
  }
  const secret = gatewaySecret()
  const mainnet = isMainnetGatewayRelease()
  if (mainnet) {
    if (!secret) {
      jsonError(res, 503, 'gateway authentication is not configured')
      return
    }
    if (!isMainnetWalletHost(requestHost(req.headers.host))) {
      jsonError(res, 403, 'mainnet gateway host is not this release')
      return
    }
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase()
    if (!value || HOP_BY_HOP.has(name) || REBUFFERED.has(name)) continue
    headers[key] = Array.isArray(value) ? value.join(',') : value
  }
  if (secret) headers['x-vault-gateway-secret'] = secret

  let body: Buffer | undefined
  try {
    body = await readBoundedRequest(req)
  } catch {
    jsonError(res, 413, 'API request too large')
    return
  }
  if (pathOnly !== '/health' && pathOnly !== '/ready') {
    try {
      const allowed = mainnet
        ? await allowMainnetGatewayRate(
            clientAddress(req.headers),
            requestVaultId(pathAndQuery, body),
            pathOnly === '/v1/enroll/session',
          )
        : allowGatewayRate(clientAddress(req.headers))
      if (!allowed) {
        jsonError(res, 429, 'too many requests')
        return
      }
    } catch {
      jsonError(res, 503, 'shared rate limit is unavailable')
      return
    }
  }
  let upstream: Response
  try {
    upstream = await fetch(origin + pathAndQuery, {
      method: req.method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(GATEWAY_UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    jsonError(res, 502, 'vault service is not running')
    return
  }
  let payload: Buffer
  try {
    payload = await readBoundedUpstream(upstream)
  } catch {
    jsonError(res, 502, 'API response too large')
    return
  }
  if (pathOnly === '/ready') {
    try {
      const ready = JSON.parse(payload.toString('utf8'))
      if (!ready || typeof ready !== 'object' || Array.isArray(ready)) throw new Error('invalid readiness')
      payload = Buffer.from(
        JSON.stringify({
          ok: ready.ok,
          schema: ready.schema,
          network: ready.network,
          enrollTemplate: ready.enrollTemplate,
          arkadeOrigin: 'configured',
          arkadeVersion: ready.arkadeVersion,
          ...(ready.error ? { error: 'service unavailable' } : {}),
        }),
      )
    } catch {
      jsonError(res, 502, 'invalid readiness response')
      return
    }
  }
  if ((pathOnly.startsWith('/v1/vtxo/board') || pathOnly === '/v1/vtxo/reserve') && upstream.status >= 400) {
    console.error(
      'vault funding upstream',
      JSON.stringify({
        status: upstream.status,
        path: pathOnly,
      }),
    )
  }
  res.statusCode = upstream.status
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (!HOP_BY_HOP.has(name) && !REBUFFERED.has(name)) res.setHeader(key, value)
  })
  res.setHeader('Content-Length', String(payload.byteLength))
  res.end(payload)
}
