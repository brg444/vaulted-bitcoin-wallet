const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const { chromium, expect } = require('@playwright/test')
const { Transaction } = require('@arkade-os/sdk')
const { hex } = require('@scure/base')
const root = process.cwd()
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
async function portableHandoff() {
  await fs.mkdir(path.join(root, '.vault-browser-tests/recovery-qa'), { recursive: true })
  const fixturePath = path.join(root, '.vault-browser-tests/recovery-qa/fixture.cjs')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import { sharedSpendingRecoveryFixture } from './src/lib/vault/recovery/testdata/helpers';
import { scalarSecret, FIXTURE_PHONE_DIRECT_P256 } from './src/lib/vault/program/fixtures';
import { wrapPhoneSecret } from './src/lib/vault/prfEnvelope';
import { buildRecoveryHeader, recoveryBackupKey } from './src/lib/vault/recovery/backupCodec';
import { createPortableRecoveryPackage } from './src/lib/vault/recovery/portable';
import { Transaction } from '@arkade-os/sdk';
import { HDKey } from '@scure/bip32';
import { ledgerBip32Versions } from './src/lib/vault/program/ledgerNativeKeys';
import { ledgerRecoveryFixture } from './src/lib/vault/recovery/testdata/ledger';
export async function fixture() {
 const {file}=await ledgerRecoveryFixture(true);
 return createPortableRecoveryPackage(file,await recoveryBackupKey(scalarSecret(3),file.header));
}
export async function lightFixture() {
 const {archive,status,kit}=sharedSpendingRecoveryFixture();
 const enrollment={vaultId:status.vaultId,credId:'ac'.repeat(32),webauthnP256:FIXTURE_PHONE_DIRECT_P256,phoneBip340Pub:kit.descriptor.keys.phoneBip340,phoneDirectP256:kit.descriptor.keys.phoneDirectP256,...await wrapPhoneSecret(scalarSecret(9),new Uint8Array(32).fill(7))};
 const header=buildRecoveryHeader(kit,status,enrollment);
 return createPortableRecoveryPackage({name:'vaulted-recovery',version:1,header,archive},await recoveryBackupKey(new Uint8Array(32).fill(7),header));
}
export function signLight(bytes) { const tx=Transaction.fromPSBT(bytes); tx.sign(new Uint8Array(32).fill(7)); return tx.toPSBT(); }
export function sign(bytes) {
 const tx=Transaction.fromPSBT(bytes);
 for (const fill of [0x42,0x44]) {
   const nodes=[HDKey.fromMasterSeed(new Uint8Array(32).fill(fill),ledgerBip32Versions('mutinynet'))];
   try {
     for (const index of [0x80000056,0x80000001,0x80000000,12,0]) nodes.push(nodes.at(-1).deriveChild(index));
     tx.sign(nodes.at(-1).privateKey);
   } finally { for (const node of nodes) node.wipePrivateData(); }
 }
 return tx.toPSBT();
}
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
    const retired = [
      { name: 'vaulted-light-recovery-package', version: 1 },
      { name: 'vaulted-light-backup', version: 1 },
      { name: 'vaulted-light-recovery', version: 1 },
      { name: 'arkade-recovery-kit', version: 3, descriptor: { schema: 'arkade-vault/savings-v1' } },
      { name: 'arkade-recovery-kit', version: 4, descriptor: { schema: 'arkade-vault/savings-v1' }, unlock: {} },
      { name: 'arkade-connector-enrollment', version: 1 },
      { name: 'vaulted-recovery-action', version: 1, source: { light: {} }, prepared: {} },
      { name: 'vaulted-recovery-signing', version: 1, source: { publicKit: {} } },
      { name: 'vaulted-recovery-action', version: 1, source: { ledgerKit: pkg.archive.kit, light: {} }, prepared: {} },
    ]
    for (const data of retired) {
      const before = requests.length
      await page.locator('#file').setInputFiles({
        name: 'discarded.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(data)),
      })
      await expect(page.locator('#error')).toContainText('Unsupported wallet recovery')
      await expect(page.locator('#review')).toBeHidden()
      await expect(page.locator('#prepared')).toBeHidden()
      await expect(page.locator('#unlock')).toBeHidden()
      await expect(page.locator('#signature')).toBeHidden()
      if (requests.length !== before) throw new Error('Discarded source triggered a network request')
    }
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
          retiredSourcesRejected: retired.length,
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
}

// Published BIP39 test vector only. Never accesses a user wallet.
const GENERATED_APP_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function buildGeneratedAppFixture() {
  const fixturePath = path.join(root, '.vault-browser-tests/recovery-qa/generated-app-fixture.cjs')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import { fixture } from './src/lib/vault/vtxo/ledgerRecoveryFee.fixture';
import { buildLedgerSpendingRecoveryPsbt, inspectLedgerSpendingRecovery } from './src/lib/vault/vtxo/ledgerSpendingRecovery';
import { validateLedgerOfflineRequest } from './src/lib/vault/vtxo/ledgerOfflineRequest';
import { acceptRecoveryPsbtSignatures } from './src/lib/vault/recovery/signatureImport';
import { signedPortableMatureBoarding } from './src/lib/vault/recovery/testdata/matureBoardingPortable';
import { Transaction } from '@arkade-os/sdk'; import { hex } from '@scure/base';
export async function spendingRequest(network){
 const fee=await fixture(false,network); const descriptor=fee.file.archive.kit.descriptor;
 const parent=new Transaction({version:2});
 parent.addInput({txid:'34'.repeat(32),index:0});
 parent.addOutput({amount:100000n,script:hex.decode(descriptor.spendingAuthorities.spendingArkScript)});
 const request={descriptor,coin:{txid:parent.id,vout:0,value:100000,parentTxHex:hex.encode(parent.toBytes(true,true))},destination:fee.file.exitPackage.sweepAddress,feeSats:1000};
 return validateLedgerOfflineRequest({name:'vaulted-ledger-offline-spending',version:1,role:'hardware',request,psbt:buildLedgerSpendingRecoveryPsbt(request)});
}
export function verifyLedgerRequest(request,bytes){
 const signed=hex.encode(bytes);
 const merged=acceptRecoveryPsbtSignatures(request.psbt,signed,[request.request.descriptor.spendingAuthorities.externalOwnerWalletPub]);
 const view=inspectLedgerSpendingRecovery(request.request);
 const tx=Transaction.fromPSBT(bytes,{allowUnknownInputs:true,allowUnknownOutputs:true});
 if(!tx.getInput(0).tapScriptSig?.some(([key])=>hex.encode(key.pubKey)===view.requiredKeys.find(k=>k.role==='hardware').publicKey.slice(2)))
   throw new Error('Hardware signature missing');
 return {mergedBytes:merged.length,destination:view.destination,amountSats:view.amountSats,requiredKeys:view.requiredKeys.map(k=>k.role)};
}
export async function matureBoard(network){
 const built=await signedPortableMatureBoarding(network);
 return {file:built.file,txid:built.txid};
}
`,
    },
    outfile: fixturePath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    alias: { vitest: path.join(root, 'tools/program-emergency/vitest-shim.mjs') },
    define: { 'import.meta.env': '{}' },
  })
  delete require.cache[fixturePath]
  return require(fixturePath)
}

function generatedAppServer(onBroadcast) {
  return http.createServer(async (req, res) => {
    try {
      const url = req.url.split('?')[0]
      if (url.startsWith('/esplora/')) {
        const part = url.slice('/esplora/'.length)
        if (req.method === 'POST' && part === 'tx') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          const txid = Transaction.fromRaw(hex.decode(raw)).id
          onBroadcast({ path: url, txid, raw, hexBytes: raw.length })
          res.setHeader('Content-Type', 'text/plain')
          res.end(txid)
          return
        }
        let body
        if (part === 'fee-estimates') body = { 1: 1, 3: 1, 6: 1 }
        else if (part === 'blocks/tip/height') body = 10000
        else if (part === 'blocks/tip/hash') body = '01'.repeat(32)
        else if (part.endsWith('/status')) body = { confirmed: false }
        else if (part.endsWith('/outspends')) body = [{ spent: false }]
        else if (part.endsWith('/utxo') || part.endsWith('/txs')) body = []
        else if (part.startsWith('block/')) body = { height: 10000, timestamp: 2000000000, id: '01'.repeat(32) }
        else if (part.startsWith('tx/')) {
          res.writeHead(404)
          res.end('Transaction not found')
          return
        } else {
          res.writeHead(404)
          res.end('unexpected ' + part)
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(typeof body === 'string' || typeof body === 'number' ? String(body) : JSON.stringify(body))
        return
      }
      const name = url === '/' ? 'mutinynet/index.html' : url.slice(1)
      const data = await fs.readFile(path.join(root, '.vault-browser-tests/program-recovery', name))
      res.setHeader(
        'Content-Type',
        name.endsWith('.html') ? 'text/html' : name.endsWith('.map') ? 'application/json' : 'text/javascript',
      )
      res.end(data)
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500)
      res.end(String(error))
    }
  })
}

async function signGeneratedLedgerSpending(browser, origin, fixture, network) {
  const request = await fixture.spendingRequest(network)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
  try {
    const page = await context.newPage()
    const errors = []
    const blocked = []
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)))
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      blocked.push(route.request().url())
      return route.abort()
    })
    const loaded = await page.goto(`${origin}/${network}/offline-sign.html`)
    if (!loaded || !loaded.ok()) throw new Error(network + ' offline-sign page failed to load')
    await page.locator('#request-file').setInputFiles({
      name: 'Vaulted offline Spending request.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(request)),
    })
    await expect(page.locator('#review')).toBeVisible({ timeout: 15000 })
    await page.locator('#offline').click()
    await expect(page.locator('#secret')).toBeHidden()
    await expect(page.locator('#error')).toContainText('Disconnect')
    await context.setOffline(true)
    await page.locator('#offline').click()
    await expect(page.locator('#secret')).toBeVisible()
    await page.locator('#mnemonic').fill(GENERATED_APP_TEST_MNEMONIC)
    await page.locator('#accept').check()
    await page.locator('#sign').click()
    await expect(page.locator('#download')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('#mnemonic')).toHaveValue('')
    await expect(page.locator('#passphrase')).toHaveValue('')
    await expect(page.locator('#secret')).toBeHidden()
    const event = page.waitForEvent('download')
    event.catch(() => undefined)
    await page.locator('#download').click()
    const download = await event
    const signed = new Uint8Array(await fs.readFile(await download.path()))
    const verified = fixture.verifyLedgerRequest(request, signed)
    if (errors.length) throw new Error(network + ' offline-sign page errors: ' + errors.join('\n'))
    if (blocked.length) throw new Error(network + ' offline-sign external requests: ' + blocked.join(', '))
    return { network, kind: request.name, signedBytes: signed.length, verified, errors, blocked }
  } finally {
    await context.close()
  }
}

async function executeGeneratedMatureBoarding(browser, origin, fixture, network, broadcasts) {
  const before = broadcasts.length
  const built = await fixture.matureBoard(network)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
  try {
    const page = await context.newPage()
    const errors = []
    const blocked = []
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)))
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      blocked.push(route.request().url())
      return route.abort()
    })
    const opened = await page.goto(`${origin}/${network}/index.html`)
    if (!opened || !opened.ok()) throw new Error(network + ' recovery page failed to load')
    await page.locator('#file').setInputFiles({
      name: `mature-board-${network}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(built.file)),
    })
    await page.locator('#program').waitFor({ timeout: 15000 })
    const options = await page.locator('#program option').evaluateAll((nodes) => nodes.map((o) => o.value))
    if (!options.includes('mature-boarding')) throw new Error(network + ' missing mature-boarding option')
    await page.locator('#program').selectOption('mature-boarding')
    await page.locator('#prepare').click()
    await expect(page.locator('#prepared')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#signature')).toBeHidden()
    const downloadEvent = page.waitForEvent('download', { timeout: 15000 })
    downloadEvent.catch(() => undefined)
    await page.locator('#execute').click()
    const saved = await downloadEvent
    const plan = JSON.parse((await fs.readFile(await saved.path())).toString('utf8'))
    await page.waitForFunction(
      () => (document.querySelector('#events')?.textContent || '').includes('"status":"broadcast"'),
      null,
      { timeout: 20000 },
    )
    const events = ((await page.locator('#events').textContent()) || '').trim()
    const errorText = ((await page.locator('#error').textContent()) || '').trim()
    if (errorText) throw new Error(network + ' mature execute error: ' + errorText)
    if (errors.length) throw new Error(network + ' recovery page errors: ' + errors.join('\n'))
    if (blocked.length) throw new Error(network + ' recovery external requests: ' + blocked.join(', '))
    const postedNow = broadcasts.slice(before)
    if (postedNow.length !== 1) throw new Error(network + ' expected one mocked broadcast, got ' + postedNow.length)
    const posted = postedNow
    const parsed = JSON.parse(events.split('\n').find((line) => line.includes('broadcast')))
    if (parsed.txid !== posted[0].txid) throw new Error(network + ' broadcast txid mismatch')
    // Exact saved-attempt identity: the broadcast must be the journal's own
    // transaction, not merely an agreeing rebuild.
    if (posted[0].txid !== built.txid) throw new Error(network + ' broadcast txid is not the saved attempt')
    const journalHex = (built.file.matureBoardingJournal.hex || '').toLowerCase()
    if (posted[0].raw.toLowerCase() !== journalHex)
      throw new Error(network + ' broadcast bytes differ from the saved attempt')
    // The #execute download is the prepared action wrapping the exact signed
    // sweep: its inputs must equal the uploaded journal's evidence inputs.
    if (plan.name !== 'vaulted-recovery-action') throw new Error(network + ' prepared action has wrong name')
    const journalInputs = await evidenceInputOutpoints(built.file)
    const planInputs = new Set(await preparedInputOutpoints(plan))
    for (const outpoint of journalInputs) {
      if (!planInputs.has(outpoint)) throw new Error(network + ' exported plan omits journal input ' + outpoint)
    }
    if (journalInputs.length !== planInputs.size) throw new Error(network + ' exported plan carries unexpected inputs')
    return { network, matureBoardingExposed: true, mockedBroadcast: posted[0], errors, blocked }
  } finally {
    await context.close()
  }
}

async function evidenceInputOutpoints(file) {
  const { Transaction: SdkTransaction } = require('@arkade-os/sdk')
  const { hex: scureHex } = require('@scure/base')
  const evidence = file.matureBoardingJournal?.evidence
  if (!evidence || typeof evidence.psbt !== 'string')
    throw new Error('uploaded file carries no mature boarding evidence')
  return psbtInputOutpoints(SdkTransaction, scureHex, evidence.psbt)
}

async function preparedInputOutpoints(plan) {
  const { Transaction: SdkTransaction } = require('@arkade-os/sdk')
  const { hex: scureHex } = require('@scure/base')
  const raw = plan.prepared?.psbt ?? plan.psbt
  if (typeof raw !== 'string') throw new Error('prepared action carries no signed sweep')
  return psbtInputOutpoints(SdkTransaction, scureHex, raw)
}

function psbtInputOutpoints(SdkTransaction, scureHex, raw) {
  const text = raw.trim()
  const bytes = /^[0-9a-fA-F\s]+$/.test(text) ? scureHex.decode(text) : Buffer.from(text, 'base64')
  const tx = SdkTransaction.fromPSBT(bytes)
  const out = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    out.push(`${input.txid?.length ? scureHex.encode(input.txid) : ''}:${input.index}`)
  }
  return out
}

async function generatedAppRegression() {
  const fixture = await buildGeneratedAppFixture()
  const broadcasts = []
  const server = generatedAppServer((entry) => broadcasts.push(entry))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const browser = await chromium.launch({ headless: true })
  const report = { ledgerSpending: {}, matureBoarding: {} }
  try {
    for (const network of ['mutinynet', 'mainnet']) {
      report.ledgerSpending[network] = await signGeneratedLedgerSpending(browser, origin, fixture, network)
      report.matureBoarding[network] = await executeGeneratedMatureBoarding(
        browser,
        origin,
        fixture,
        network,
        broadcasts,
      )
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
  await fs.writeFile(
    path.join(root, '.vault-browser-tests/recovery-qa/generated-app-result.json'),
    JSON.stringify(report, null, 2),
  )
  process.stdout.write('Generated-app mature-boarding and Ledger offline-signing regression passed\n')
}

portableHandoff()
  .then(generatedAppRegression)
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
