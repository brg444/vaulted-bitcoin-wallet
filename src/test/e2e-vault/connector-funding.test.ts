import { hex } from '@scure/base'
import { Transaction, p2wpkh } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { enrollVaultWithPasskey, expect, test } from './fixtures/passkey'
import { PROGRAM_FIXTURE } from '../../lib/vault/program/fixtures'
import { scriptHexFromAddress } from '../../lib/vault/bitcoin'

test('funds Savings and its reserve in one signed deposit and resumes after reload', async ({
  page,
  authorizer,
  passkey,
}) => {
  void passkey
  await enrollVaultWithPasskey(page, authorizer)
  const status = await page.evaluate(async (vaultId) => {
    return (await fetch(`/v1/status?vault=${vaultId}`)).json()
  }, PROGRAM_FIXTURE.vaultId)
  const key = new Uint8Array(32).fill(37)
  const payment = p2wpkh(secp256k1.getPublicKey(key))
  const parent = new Transaction()
  parent.addInput({ txid: '11'.repeat(32), index: 0 })
  parent.addOutput({ amount: 100000n, script: payment.script })
  const draft = new Transaction()
  draft.addInput({
    txid: parent.id,
    index: 0,
    witnessUtxo: { amount: 100000n, script: payment.script },
    sighashType: 1,
  })
  draft.addOutput({ amount: 99800n, script: hex.decode(scriptHexFromAddress(status.savingsAddress, 'mutinynet')) })
  let broadcast = ''
  await page.route('**/esplora/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/esplora/tx/${parent.id}/hex`) return route.fulfill({ body: hex.encode(parent.toBytes(true, true)) })
    if (path === '/esplora/fee-estimates') return route.fulfill({ json: { '3': 2 } })
    if (path.endsWith('/utxo')) return route.fulfill({ json: [] })
    if (path === '/esplora/tx' && route.request().method() === 'POST') {
      broadcast = route.request().postData() || ''
      return route.fulfill({ body: Transaction.fromRaw(hex.decode(broadcast)).id })
    }
    return route.fallback()
  })
  const openDeposit = async () => {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByTestId('account-savings').click()
    await page.getByTestId('account-receive').click()
  }
  await openDeposit()
  await page
    .getByLabel('Unsigned deposit file')
    .setInputFiles({ name: 'deposit.psbt', mimeType: 'application/octet-stream', buffer: Buffer.from(draft.toPSBT()) })
  await expect(page.getByText('1,000 sats included')).toBeVisible()
  const original = await page.evaluate(
    (vaultId) => localStorage.getItem(`vaulted:connector-funding:mutinynet:${vaultId}`),
    status.vaultId,
  )
  expect(original).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
  await openDeposit()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save deposit PSBT' }).click()
  const download = await downloadPromise
  const stream = (await download.createReadStream())!
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.from(chunk))
  const approved = Transaction.fromPSBT(Buffer.concat(parts))
  expect(approved.outputsLength).toBe(2)
  expect(approved.getOutput(1).amount).toBe(1000n)
  approved.sign(key)
  await page.getByLabel('Signed deposit file').setInputFiles({
    name: 'signed.psbt',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(approved.toPSBT()),
  })
  await expect(page.getByRole('button', { name: 'Submit deposit' })).toBeVisible()
  expect(broadcast).toBe('')
  await page.getByRole('button', { name: 'Submit deposit' }).click()
  await expect(page.getByText(/Deposit submitted/)).toBeVisible()
  expect(Transaction.fromRaw(hex.decode(broadcast)).id).toBe(approved.id)
})
