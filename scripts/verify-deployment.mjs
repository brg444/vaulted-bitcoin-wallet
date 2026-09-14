import { createHash } from 'node:crypto'
import { assertGuardianRelease } from './release-verification.mjs'

const [canonicalUrl, deploymentTarget, expectedNetwork, expectedSigningOrigin, expectedRpId] = process.argv.slice(2)

if (
  !canonicalUrl ||
  !deploymentTarget ||
  !['mainnet', 'mutinynet'].includes(expectedNetwork) ||
  !expectedSigningOrigin
) {
  throw new Error(
    'usage: pnpm verify:deployment <canonical-url> <deployment-url-or-index-asset> <mainnet|mutinynet> <expected-signing-origin> [expected-rp-id]',
  )
}

async function indexAsset(origin) {
  const response = await fetch(new URL(`/index.html?verify=${Date.now()}`, origin), {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`${origin} returned ${response.status}`)
  const match = (await response.text()).match(/index-[A-Za-z0-9_-]+\.js/)
  if (!match) throw new Error(`${origin} has no versioned index bundle`)
  return match[0]
}

const canonicalAsset = await indexAsset(canonicalUrl)
const deploymentAsset = /^index-[A-Za-z0-9_-]+\.js$/.test(deploymentTarget)
  ? deploymentTarget
  : await indexAsset(deploymentTarget)

if (canonicalAsset !== deploymentAsset) {
  throw new Error(`canonical alias is stale: ${canonicalAsset} != ${deploymentAsset}`)
}

console.log(`verified ${canonicalAsset}`)

async function releaseResponse(path) {
  const response = await fetch(new URL(path, canonicalUrl), {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response
}
const manifest = await (await releaseResponse('/release.json')).json()
if (manifest.network !== expectedNetwork) throw new Error('Compiled release network mismatch')
if (expectedNetwork === 'mainnet') {
  for (const feature of ['lightOnlyEnrollment', 'lightningSend', 'lightningReceive', 'lightningAddress']) {
    if (manifest.features?.[feature] !== true) throw new Error(`Released wallet feature missing: ${feature}`)
  }
}
const worker = await (await releaseResponse('/vault-wallet-service-worker.mjs')).arrayBuffer()
if (createHash('sha256').update(new Uint8Array(worker)).digest('hex') !== manifest.workerSha256) {
  throw new Error('Service worker differs from the release manifest')
}
const ready = await (await releaseResponse('/ready')).json()
const status = await (await releaseResponse('/v1/status')).json()
const verified = assertGuardianRelease({
  ready,
  status,
  network: expectedNetwork,
  expectedOrigin: expectedSigningOrigin,
  expectedRpId,
})
console.log(`verified ${expectedNetwork} app, worker, and Guardian (${verified.origin}, schema ${verified.schema})`)
