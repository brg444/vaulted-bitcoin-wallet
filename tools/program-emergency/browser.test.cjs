const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const { chromium, expect } = require('@playwright/test')
const root = process.cwd()
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
;(async () => {
  await fs.mkdir(path.join(root, '.vault-browser-tests/recovery-qa'), { recursive: true })
  const fixturePath = path.join(root, '.vault-browser-tests/recovery-qa/fixture.cjs')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import { recoveryFixture, sharedSpendingRecoveryFixture } from './src/lib/vault/recovery/testdata/helpers';
import { scalarSecret, FIXTURE_PHONE_DIRECT_P256 } from './src/lib/vault/program/fixtures';
import { wrapPhoneSecret } from './src/lib/vault/prfEnvelope';
import { buildRecoveryHeader, recoveryBackupKey } from './src/lib/vault/recovery/backupCodec';
import { createPortableRecoveryPackage } from './src/lib/vault/recovery/portable';
import { Transaction } from '@arkade-os/sdk';
export async function fixture() {
 const {archive,status,kit}=recoveryFixture(true);
 const enrollment={vaultId:status.vaultId,credId:'ab'.repeat(32),webauthnP256:FIXTURE_PHONE_DIRECT_P256,phoneBip340Pub:kit.descriptor.keys.phoneBip340,phoneDirectP256:kit.descriptor.keys.phoneDirectP256,...await wrapPhoneSecret(scalarSecret(9),scalarSecret(3))};
 const header=buildRecoveryHeader(kit,status,enrollment);
 return createPortableRecoveryPackage({name:'vaulted-recovery',version:1,header,archive},await recoveryBackupKey(scalarSecret(3),header));
}
export async function lightFixture() {
 const {archive,status,kit}=sharedSpendingRecoveryFixture();
 const enrollment={vaultId:status.vaultId,credId:'ac'.repeat(32),webauthnP256:FIXTURE_PHONE_DIRECT_P256,phoneBip340Pub:kit.descriptor.keys.phoneBip340,phoneDirectP256:kit.descriptor.keys.phoneDirectP256,...await wrapPhoneSecret(scalarSecret(9),new Uint8Array(32).fill(7))};
 const header=buildRecoveryHeader(kit,status,enrollment);
 return createPortableRecoveryPackage({name:'vaulted-recovery',version:1,header,archive},await recoveryBackupKey(new Uint8Array(32).fill(7),header));
}
export function signLight(bytes) { const tx=Transaction.fromPSBT(bytes); tx.sign(new Uint8Array(32).fill(7)); return tx.toPSBT(); }
export function sign(bytes) { const tx=Transaction.fromPSBT(bytes); tx.sign(scalarSecret(4)); tx.sign(scalarSecret(5)); return tx.toPSBT(); }
`,
    },
    outfile: fixturePath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    define: { 'import.meta.env': '{}' },
  })
  const fixture = require(fixturePath)
  const pkg = await fixture.fixture()
  const artifact = path.join(root, '.vault-browser-tests/program-recovery/mutinynet')
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/esplora/')) {
        const part = req.url.slice('/esplora/'.length)
        let body
        if (part === 'fee-estimates') body = { 1: 1, 3: 1, 6: 1 }
        else if (part.endsWith('/status')) body = { confirmed: true, block_height: 1, block_time: 1 }
        else if (part.endsWith('/outspends')) body = [{ spent: false }]
        else if (part === 'blocks/tip/height') body = 10000
        else if (part === 'blocks/tip/hash') body = '01'.repeat(32)
        else if (part.startsWith('block/')) body = { height: 10000, timestamp: 2000000000, id: '01'.repeat(32) }
        else if (part.endsWith('/utxo') || part.endsWith('/txs')) body = []
        else throw new Error('Unexpected Bitcoin request ' + part)
        res.setHeader('Content-Type', 'application/json')
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
        return
      }
      const name = req.url === '/' ? 'index.html' : req.url.slice(1)
      if (!['index.html', 'recovery.js', 'recovery.js.map'].includes(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : 'text/javascript')
      res.end(await fs.readFile(path.join(artifact, name)))
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const requests = []
    const blocked = []
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/*', (route) => {
      const request = route.request()
      requests.push({ url: request.url(), method: request.method() })
      if (new URL(request.url()).origin === origin) return route.continue()
      blocked.push(request.url())
      return route.abort()
    })
    await page.goto(origin)
    await page
      .locator('#file')
      .setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)) })
    await page.locator('#review').waitFor({ state: 'visible' })
    if (!(await page.locator('#amount').innerText()).includes('40,000')) throw new Error('Missing saved amount')
    if (!(await page.locator('#requirements').innerText()).includes('hardware and recovery keys'))
      throw new Error('Wrong signers')
    await page.screenshot({ path: path.join(root, '.vault-browser-tests/recovery-qa/review.png'), fullPage: true })
    await page.locator('#destination').fill(pkg.archive.kit.descriptor.savings.address)
    await page.locator('#prepare').click()
    await page.locator('#signature').waitFor({ state: 'visible' })
    if (await page.locator('#sign-phone').isVisible()) throw new Error('Unexpected phone request')
    await expect(page.locator('#signing-outputs')).toContainText(pkg.archive.kit.descriptor.savings.address)
    await expect(page.locator('#signing-outputs')).toContainText('sats')
    await expect(page.locator('#signing-fee')).toContainText('Transaction fee:')
    await page.screenshot({ path: path.join(root, '.vault-browser-tests/recovery-qa/signing.png'), fullPage: true })
    const downloadEvent = page.waitForEvent('download')
    await page.locator('#save-psbt').click()
    const download = await downloadEvent
    const unsigned = await fs.readFile(await download.path())
    const signed = fixture.sign(new Uint8Array(unsigned))
    await page
      .locator('#signed-file')
      .setInputFiles({ name: 'signed.psbt', mimeType: 'application/octet-stream', buffer: Buffer.from(signed) })
    await page.waitForFunction(() => document.querySelector('#signed-file').value === '')
    if (await page.locator('#sign-error').innerText()) throw new Error(await page.locator('#sign-error').innerText())
    await page.locator('#finish-signing').click()
    await page.locator('#prepared').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(root, '.vault-browser-tests/recovery-qa/prepared.png'), fullPage: true })
    const savedEvent = page.waitForEvent('download')
    await page.locator('#save').click()
    const saved = await savedEvent
    const preparedFile = await fs.readFile(await saved.path())
    await page.reload()
    await page
      .locator('#file')
      .setInputFiles({ name: 'prepared.json', mimeType: 'application/json', buffer: preparedFile })
    await page.locator('#prepared').waitFor({ state: 'visible' })
    await expect(page.locator('#signature')).toBeHidden()
    await page.locator('#change-file').click()
    await page.locator('#file').setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{malformed'),
    })
    await expect(page.locator('#error')).not.toBeEmpty()
    await expect(page.locator('#prepared')).toBeHidden()
    await expect(page.locator('#review')).toBeHidden()
    const light = await fixture.lightFixture()
    await page.reload()
    await page
      .locator('#file')
      .setInputFiles({ name: 'light.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(light)) })
    await expect(page.locator('#review')).toBeVisible()
    await expect(page.locator('#requirements')).toContainText('wallet key unlocked by your original passkey')
    expect(await page.locator('#program option').evaluateAll((options) => options.map((o) => o.value))).toEqual([
      'spending',
      'boarding',
    ])
    expect(await page.locator('#fee-key option').evaluateAll((options) => options.map((o) => o.value))).toEqual([
      'phone',
    ])
    await page.locator('#destination').fill(light.archive.status.vtxoBoardingAddress)
    await page.locator('#prepare').click()
    await expect(page.locator('#signature')).toBeVisible()
    const lightDownloadEvent = page.waitForEvent('download')
    await page.locator('#save-psbt').click()
    const lightDownload = await lightDownloadEvent
    const lightSigned = fixture.signLight(new Uint8Array(await fs.readFile(await lightDownload.path())))
    await page
      .locator('#signed-file')
      .setInputFiles({ name: 'signed.psbt', mimeType: 'application/octet-stream', buffer: Buffer.from(lightSigned) })
    await page.waitForFunction(() => document.querySelector('#signed-file').value === '')
    await expect(page.locator('#sign-error')).toBeEmpty()
    await page.locator('#finish-signing').click()
    await expect(page.locator('#prepared')).toBeVisible()
    await page.screenshot({
      path: path.join(root, '.vault-browser-tests/recovery-qa/light-prepared.png'),
      fullPage: true,
    })
    if (requests.some((request) => request.method === 'POST')) throw new Error('Unexpected broadcast')
    if (blocked.length) throw new Error('Unexpected external request: ' + blocked.join(', '))
    if (errors.length) throw new Error(errors.join('\n'))
    await fs.writeFile(
      path.join(root, '.vault-browser-tests/recovery-qa/result.json'),
      JSON.stringify(
        {
          passed: true,
          scope: 'Advanced and fresh Light portable import and actual PSBT handoff; mocked Bitcoin, no broadcast',
          phoneRequested: false,
          resumed: true,
          requests,
        },
        null,
        2,
      ),
    )
    process.stdout.write('Portable recovery browser handoff passed\n')
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
