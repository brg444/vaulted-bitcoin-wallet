import { copyArkadeReceiveAddress } from './fixtures/receive'
import { expect, test } from './fixtures/passkey'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { getNetwork } from '@arkade-os/sdk'

test.skip(process.env.VAULT_LIGHT_LIVE !== 'mutinynet', 'Opt-in funded Mutinynet drill only')
test('Light sends Bitcoin through shared Spending with recoverable change', async ({ page, passkey }) => {
  const directory = join(process.env.VAULT_LIGHT_DRILL_DIRECTORY!, 'bitcoin')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
  await writeFile(join(directory, 'started'), new Date().toISOString(), { mode: 0o600, flag: 'wx' })
  const errors: string[] = []
  const responses: { path: string; status: number; body: unknown }[] = []
  const backups: { revision: number; payload: string }[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname !== 'localhost') return route.continue()
    const response = await page.request.fetch(`http://127.0.0.1:18899${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postData() || undefined,
    })
    if (url.pathname === '/v1/light/backup/write' && response.ok()) backups.push(await response.json())
    if (url.pathname.includes('/vtxo/bitcoin') || !response.ok()) {
      responses.push({ path: url.pathname, status: response.status(), body: await response.json().catch(() => null) })
      await save('responses.json', responses)
    }
    await route.fulfill({ response })
  })
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Get started', exact: true }).click()
    await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
    await page.getByLabel('Per-payment limit, in sats').fill('20000')
    await page.getByLabel('Rolling 24-hour limit, in sats').fill('50000')
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click()
    await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 45000 })
    const destinationKey = schnorr.utils.randomSecretKey()
    const output = p2tr(schnorr.getPublicKey(destinationKey), undefined, getNetwork('mutinynet'))
    const destination = output.address!
    await save('destination.json', { destination, script: hex.encode(output.script), key: hex.encode(destinationKey) })
    destinationKey.fill(0)
    await page.getByRole('button', { name: 'Receive', exact: true }).click()
    const address = await copyArkadeReceiveAddress(page)
    expect(address).toMatch(/^tark1/)
    await save('funding-request.json', { address, amount: 50000 })
    const funded = await page.request.post('https://faucet.mutinynet.arkade.sh/faucet', {
      data: { address, amount: 50000 },
    })
    expect(funded.ok()).toBe(true)
    await page.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(page.getByTestId('vault-balance').filter({ hasText: '₿50,000' })).toBeVisible({ timeout: 60000 })
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('textbox', { name: 'To', exact: true }).fill(destination)
    await page.locator('#qg-send-amount').fill('10000')
    await page.getByRole('button', { name: 'Review payment', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm Bitcoin payment', exact: true })).toBeVisible({
      timeout: 60000,
    })
    await save('review.json', { text: await page.locator('body').innerText() })
    await page.getByRole('button', { name: 'Confirm Bitcoin payment', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Bitcoin payment submitted', exact: true })).toBeVisible({
      timeout: 150000,
    })
    await save('submitted.json', { text: await page.locator('body').innerText() })
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`https://mutinynet.com/api/address/${destination}/txs`)
          if (!response.ok()) return false
          const txs = await response.json()
          await save('destination-transactions.json', txs)
          return txs.some((tx: { vout: { scriptpubkey: string; value: number }[] }) =>
            tx.vout.some((v) => v.scriptpubkey === hex.encode(output.script) && v.value === 10000),
          )
        },
        { timeout: 90000, intervals: [3000, 5000] },
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect
      .poll(
        async () => {
          if (!backups.length) return false
          const payload = backups.at(-1)!.payload
          const evidence = await page.evaluate(async (payload) => {
            const base = '/src/lib/vault/light/'
            const { openLocalLightBackup } = await import(base + 'backupCodec.ts')
            const { validateLightRecoveryArchive } = await import(base + 'recoveryArchive.ts')
            const { file } = await openLocalLightBackup(JSON.parse(payload))
            const { coins } = validateLightRecoveryArchive(file.archive, file.descriptor)
            return {
              amount: coins.reduce((n: number, v: { value: number }) => n + v.value, 0),
              coins,
              transactions: Object.keys(file.archive.transactions).length,
            }
          }, payload)
          await save('change-backup.json', JSON.parse(payload))
          await save('change-evidence.json', evidence)
          return evidence.amount > 330 && evidence.amount <= 40000 && evidence.transactions > 0
        },
        { timeout: 90000, intervals: [3000, 5000] },
      )
      .toBe(true)
    const payload = await readFile(join(directory, 'change-backup.json'), 'utf8')
    await page.route('**/__light-bitcoin-offline', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline change recovery</title>' }),
    )
    await page.goto('/__light-bitcoin-offline')
    const forbiddenRequests: string[] = []
    for (const pattern of ['**/v1/**', 'https://mutinynet.arkade.sh/**']) {
      await page.route(pattern, (route) => {
        forbiddenRequests.push(new URL(route.request().url()).pathname)
        return route.abort()
      })
    }
    const prepared = await page.evaluate(
      async ({ payload, destination }) => {
        const base = '/src/lib/vault/light/'
        const { openLocalLightBackup } = await import(base + 'backupCodec.ts')
        const { unlockLightWithPasskey } = await import(base + 'passkey.ts')
        const { prepareLightRecoveryWithOwner } = await import(base + 'recovery.ts')
        const { file } = await openLocalLightBackup(JSON.parse(payload))
        const owner = await unlockLightWithPasskey(file)
        try {
          return await prepareLightRecoveryWithOwner(file, owner, destination, file.archive, true)
        } finally {
          owner.fill(0)
        }
      },
      { payload, destination },
    )
    expect(prepared.exitPackage.vtxos.reduce((n: number, v: { value: number }) => n + v.value, 0)).toBe(40000)
    expect(prepared.exitPackage.vtxos.every((v: { skipped?: boolean }) => !v.skipped)).toBe(true)
    expect(forbiddenRequests).toEqual([])
    await writeFile(join(directory, 'offline-change-recovery.json'), JSON.stringify(prepared, null, 2), { mode: 0o600 })

    expect(errors).toEqual([])
  } finally {
    await save('browser-state.json', {
      state: await page.context().storageState(),
      credentials: await passkey.credentials(),
      text: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
      errors,
    })
  }
})
