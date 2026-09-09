// Public fixture only. Checks the official client in a real browser, including Buffer compatibility.
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const vector = JSON.parse(readFileSync(root + 'src/lib/vault/program/ledger-key-vectors.json'))[0]
const contract = {
  context: vector.input,
  spendingPolicy: JSON.parse(
    readFileSync(new URL('../../src/lib/vault/program/ledger-family-vectors.json', import.meta.url)),
  )[0].spendingPolicy,
}
const vite = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  define: { __VAULT_E2E_OPERATOR_ORIGIN__: '""' },
})
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  const page = await browser.newPage()
  await page.goto(
    `http://127.0.0.1:${vite.httpServer.address().port}/tools/native-savings-signers/ledger-client-browser.html`,
  )
  const result = await page.evaluate(async (contract) => {
    const { registerLedgerSavings, validateLedgerSavingsRegistration } = await import('/src/lib/vault/ledgerClient.ts')
    const { buildLedgerNativeFamily } = await import('/src/lib/vault/program/ledgerNativeFamily.ts')
    const family = buildLedgerNativeFamily(contract.context, contract.spendingPolicy)
    const calls = []
    const app = {
      getMasterFingerprint: async () => contract.context.hardware.fingerprint,
      getExtendedPubkey: async () => contract.context.hardware.xpub,
      registerWallet: async (policy) => [policy.getId(), Buffer.alloc(32, 1)],
      getWalletAddress: async (_p, _h, change, index, display) => {
        calls.push([change, index, display])
        return change ? family.change.address : family.receive.address
      },
    }
    const registration = await registerLedgerSavings(app, contract)
    await validateLedgerSavingsRegistration(contract, JSON.parse(JSON.stringify(registration)))
    return { walletId: registration.walletId, keys: registration.walletPolicy.keysInfo.length, calls }
  }, contract)
  if (result.keys !== 7 || JSON.stringify(result.calls) !== '[[0,0,true],[1,0,false]]')
    throw new Error('browser registration mismatch')
  mkdirSync(root + 'tools/native-savings-signers/evidence', { recursive: true })
  writeFileSync(
    root + 'tools/native-savings-signers/evidence/ledger-client-browser.json',
    JSON.stringify(
      {
        ...result,
        scope: 'Chromium official-client policy serialization and adapter with simulated transport; no physical device',
        fixtureTier: 'standard',
      },
      null,
      2,
    ) + '\n',
  )
  console.log(result)
} finally {
  await browser.close()
  await vite.close()
}
