// Published BIP39 test vectors only. This test never accesses a user wallet.
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { chromium, expect } from '@playwright/test'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const root = process.cwd(),
  dir = root + '/.vault-browser-tests/ledger-offline'
await mkdir(dir, { recursive: true })
await build({
  stdin: {
    resolveDir: root,
    contents: `
import {fixture, seed} from './src/lib/vault/vtxo/ledgerRecoveryFee.fixture';
import {inspectLedgerRecoveryFee,signLedgerRecoveryFeeWithSeed} from './src/lib/vault/vtxo/ledgerRecoveryFee';
import {buildLedgerSpendingRecoveryPsbt,signLedgerSpendingRecoveryWithSeed} from './src/lib/vault/vtxo/ledgerSpendingRecovery';
import {validateLedgerOfflineRequest} from './src/lib/vault/vtxo/ledgerOfflineRequest';
import {acceptRecoveryPsbtSignatures} from './src/lib/vault/recovery/signatureImport';
import {Transaction} from '@arkade-os/sdk'; import {hex} from '@scure/base';
export async function requests(advanced,network){
 const fee=await fixture(advanced,network); const descriptor=fee.file.archive.kit.descriptor;
 const parent=new Transaction({version:2});parent.addInput({txid:'34'.repeat(32),index:0});parent.addOutput({amount:100000n,script:hex.decode(descriptor.spendingAuthorities.spendingArkScript)});
 const request={descriptor,coin:{txid:parent.id,vout:0,value:100000,parentTxHex:hex.encode(parent.toBytes(true,true))},destination:fee.file.exitPackage.sweepAddress,feeSats:1000};
 return [validateLedgerOfflineRequest({name:'vaulted-ledger-offline-spending',version:1,role:'hardware',request,psbt:buildLedgerSpendingRecoveryPsbt(request)}),validateLedgerOfflineRequest({name:'vaulted-ledger-offline-fee',version:1,request:fee,psbt:inspectLedgerRecoveryFee(fee).unsignedPsbt})];
}
export function verify(request,bytes){ const signed=hex.encode(bytes); acceptRecoveryPsbtSignatures(request.psbt,signed,request.name==='vaulted-ledger-offline-fee'?[]:[request.request.descriptor.spendingAuthorities.externalOwnerWalletPub]); const tx=Transaction.fromPSBT(bytes,{allowUnknownInputs:true,allowUnknownOutputs:true});if(request.name==='vaulted-ledger-offline-fee' && Array.from({length:tx.inputsLength-1},(_,i)=>tx.getInput(i+1)).some(i=>!i.tapKeySig))throw Error('Fee signature missing'); }
`,
  },
  outfile: dir + '/fixture.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  packages: 'external',
  define: { 'import.meta.env': '{}' },
})
const fixture = require(dir + '/fixture.cjs')
const server = createServer(async (req, res) => {
  try {
    const match = /^\/(mainnet|mutinynet)\/(offline-sign\.(?:html|js))$/.exec(req.url)
    if (!match) {
      res.writeHead(404)
      res.end()
      return
    }
    res.setHeader('Content-Type', match[2].endsWith('html') ? 'text/html' : 'text/javascript')
    res.end(await readFile(root + '/.vault-browser-tests/program-recovery/' + match[1] + '/' + match[2]))
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
const browser = await chromium.launch({ headless: true }),
  results = []
try {
  for (const network of ['mutinynet', 'mainnet'])
    for (const advanced of [false, true]) {
      const requests = await fixture.requests(advanced, network)
      for (const request of requests) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(origin + '/' + network + '/offline-sign.html')
        await page
          .locator('#request-file')
          .setInputFiles({
            name: 'request.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(request)),
          })
        await expect(page.locator('#review')).toBeVisible()
        await page.locator('#offline').click()
        await expect(page.locator('#secret')).toBeHidden()
        await expect(page.locator('#error')).toContainText('Disconnect')
        await context.setOffline(true)
        await page.locator('#offline').click()
        await expect(page.locator('#secret')).toBeVisible()
        await page
          .locator('#mnemonic')
          .fill('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
        await page.locator('#accept').check()
        await page.locator('#sign').click()
        await expect(page.locator('#download')).toBeVisible({ timeout: 30000 })
        await expect(page.locator('#mnemonic')).toHaveValue('')
        await expect(page.locator('#passphrase')).toHaveValue('')
        await expect(page.locator('#secret')).toBeHidden()
        const event = page.waitForEvent('download')
        await page.locator('#download').click()
        const download = await event
        fixture.verify(request, new Uint8Array(await readFile(await download.path())))
        await page.screenshot({
          path: dir + '/' + network + '-' + advanced + '-' + request.name + '.png',
          fullPage: true,
        })
        if (errors.length) throw Error(errors.join('\n'))
        results.push({
          network,
          advanced,
          kind: request.name,
          onlineBlocked: true,
          seedCleared: true,
          signatureVerified: true,
        })
        await context.close()
      }
    }
  await writeFile(
    dir + '/result.json',
    JSON.stringify(
      { scope: 'Public fixture offline browser signing; no physical Ledger, network or broadcast', results },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(results))
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
