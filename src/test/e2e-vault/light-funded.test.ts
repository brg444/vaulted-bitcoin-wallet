import { expect, test } from './fixtures/passkey'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { getNetwork } from '@arkade-os/sdk'

test.skip(process.env.VAULT_LIGHT_LIVE !== 'mutinynet', 'Opt-in funded Mutinynet drill only')
test('Light enrolls, receives and pays with real Mutinynet providers', async ({ page, passkey }) => {
  const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY!
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await writeFile(join(directory, 'funded-enrollment-started'), new Date().toISOString(), { mode: 0o600, flag: 'wx' })
  const save = async (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
  const backups: { revision: number; payload: string }[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname !== 'localhost') return route.continue()
    if (url.pathname === '/v1/light/renew/register')
      await save('register-request.json', JSON.parse(request.postData()!))
    const response = await page.request.fetch(`http://127.0.0.1:18899${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postData() || undefined,
    })
    if (url.pathname === '/v1/light/backup/write' && response.ok()) backups.push(await response.json())
    await route.fulfill({ response })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
  await page.getByLabel('Per-payment limit, in sats').fill('20000')
  await page.getByLabel('Rolling 24-hour limit, in sats').fill('50000')
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click()
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 45000 })
  // Generate a compatibility fixture for the two legacy recovery-code drills.
  // This is an opt-in Mutinynet test only; the product never exports this code.
  const { saved, secret } = await page.evaluate(async () => {
    const base = '/src/lib/vault/light/'
    const { unlockLightWithPasskey } = await import(base + 'passkey.ts')
    const { wrapLightOwnerKey } = await import(base + 'keyBackup.ts')
    const record = JSON.parse(localStorage.getItem('vaulted-light:enrollment-v1')!)
    if (record.descriptor.network !== 'mutinynet') throw new Error('Test-only Mutinynet backup')
    const owner = await unlockLightWithPasskey(record)
    const material = crypto.getRandomValues(new Uint8Array(32))
    try {
      const recoveryBackup = await wrapLightOwnerKey(owner, material, 'recovery-secret', record.descriptor)
      return {
        saved: { ...record, recoveryBackup, name: 'vaulted-light-recovery', version: 1 },
        secret: Array.from(material, (b) => b.toString(16).padStart(2, '0')).join(''),
      }
    } finally {
      owner.fill(0)
      material.fill(0)
    }
  })
  const destinationKey = schnorr.utils.randomSecretKey()
  const destination = p2tr(schnorr.getPublicKey(destinationKey), undefined, getNetwork('mutinynet')).address!
  await save('browser-owner-backup.json', {
    saved,
    secret,
    credentials: await passkey.credentials(),
    destination,
    destinationKey: hex.encode(destinationKey),
  })
  destinationKey.fill(0)
  const checkAutomaticBackup = async (amount: number, phase: string, previous: string[] = []) => {
    let evidence: { amount: number; outpoints: string[]; transactionCount: number } | undefined
    await expect
      .poll(
        async () => {
          const latest = backups.at(-1)
          if (!latest) return false
          evidence = await page.evaluate(async (payload) => {
            const base = '/src/lib/vault/light/'
            const { openLocalLightBackup } = await import(base + 'backupCodec.ts')
            const { validateLightRecoveryArchive } = await import(base + 'recoveryArchive.ts')
            const { file } = await openLocalLightBackup(JSON.parse(payload))
            const { coins } = validateLightRecoveryArchive(file.archive, file.descriptor)
            return {
              amount: coins.reduce((n: number, v: { value: number }) => n + v.value, 0),
              outpoints: coins.map((v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`).sort(),
              transactionCount: Object.keys(file.archive.transactions).length,
            }
          }, latest.payload)
          return (
            evidence?.amount === amount &&
            evidence.transactionCount > 0 &&
            evidence.outpoints.every((id) => !previous.includes(id))
          )
        },
        { timeout: 90000, intervals: [1000, 3000, 5000] },
      )
      .toBe(true)
    await save(`browser-${phase}-cloud-backup.json`, JSON.parse(backups.at(-1)!.payload))
    await save(`browser-${phase}-paths.json`, { ...evidence, revision: backups.at(-1)!.revision })
    return evidence!.outpoints
  }

  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿0' })).toBeVisible({ timeout: 45000 })
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  const address = (await page.locator('.light-address').innerText()).trim()
  await save('browser-funding-request.json', { address, amount: 50000 })
  const funded = await page.request.post('https://faucet.mutinynet.arkade.sh/faucet', {
    data: { address, amount: 50000 },
  })
  expect(funded.ok()).toBe(true)
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿50,000' })).toBeVisible({ timeout: 60000 })
  const receivedPaths = await checkAutomaticBackup(50000, 'received')
  await page.reload()
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
  await expect(page.getByTestId('vault-balance').filter({ hasText: '₿50,000' })).toBeVisible({ timeout: 60000 })
  const recipient = await (await page.request.get('https://faucet.mutinynet.arkade.sh/address')).json()
  expect(recipient.offchain).toMatch(/^tark1/)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByLabel('Arkade address', { exact: true }).fill(recipient.offchain)
  await page.getByLabel('Amount, in sats').fill('10000')
  await page.getByRole('button', { name: 'Review payment', exact: true }).click()
  await page.getByRole('button', { name: 'Approve 10,000 sats', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Payment sent', level: 1, exact: true })).toBeVisible({
    timeout: 60000,
  })
  await save('browser-payment-evidence.json', { text: await page.locator('.light-app').innerText(), errors })
  expect(errors).toEqual([])
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const changePaths = await checkAutomaticBackup(40000, 'change', receivedPaths)
  if (process.env.VAULT_LIGHT_TEST_RENEWAL === '1') {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Security', exact: true }).click()
    await page.getByRole('button', { name: /^Automatic renewal/ }).click()
    await page.getByRole('button', { name: 'Renew Spending', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Keep your Spending active', exact: true })).toBeVisible({
      timeout: 45000,
    })
    await save('browser-renewal-review.json', { text: await page.locator('.light-app').innerText() })
    await page.getByRole('button', { name: 'Confirm renewal', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(/Renewal submitted|Spending renewed/, { timeout: 150000 })
    await save('browser-renewal-evidence.json', { text: await page.locator('.light-app').innerText(), errors })
    expect(errors).toEqual([])
    await page.reload()
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
    await expect(page.getByTestId('vault-balance').filter({ hasText: '₿40,000' })).toBeVisible({ timeout: 60000 })
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Security', exact: true }).click()
    await checkAutomaticBackup(40000, 'renewed', changePaths)
    await page.screenshot({ path: join(directory, 'renewed-light-security.png'), fullPage: true })
  }

  // Leave the normal wallet before measuring recovery requests, so its balance
  // and backup timers cannot contaminate the independent recovery check.
  if (!(await page.getByRole('button', { name: 'Lock wallet', exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Security', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Lock wallet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible()
  await page.route('**/__light-offline-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline recovery qualification</title>' }),
  )
  await page.goto('/__light-offline-test')

  // Prepare the latest automatically saved paths after disabling both services.
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
    { payload: backups.at(-1)!.payload, destination },
  )
  expect(prepared.exitPackage.vtxos.reduce((n: number, v: { value: number }) => n + v.value, 0)).toBe(40000)
  expect(prepared.exitPackage.vtxos.every((v: { skipped?: boolean }) => !v.skipped)).toBe(true)
  expect(forbiddenRequests).toEqual([])
  await save('browser-automatic-offline-recovery.json', prepared)
  await save('browser-automatic-offline-evidence.json', {
    outputs: prepared.exitPackage.vtxos,
    forbiddenRequests,
    errors,
  })
})

test('Light prepares recovery of funded change without a passkey', async ({ page }) => {
  const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY!
  const { saved, secret, destination } = JSON.parse(
    await readFile(join(directory, 'browser-owner-backup.json'), 'utf8'),
  )
  expect(destination).toMatch(/^tb1p/)
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await page.getByRole('button', { name: 'Use a local backup' }).click()
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) })
  await page.getByRole('button', { name: 'Recover directly to Bitcoin', exact: true }).click()
  await page.getByLabel('Bitcoin address to recover to').fill(destination)
  await page.getByLabel('Recovery code', { exact: true }).fill(secret)
  const downloaded = page.waitForEvent('download', { timeout: 90000 })
  await page.getByRole('button', { name: 'Prepare emergency exit', exact: true }).click()
  const file = await downloaded
  const exit = JSON.parse(await readFile((await file.path())!, 'utf8'))
  await writeFile(join(directory, 'browser-change-recovery.json'), JSON.stringify(exit, null, 2), { mode: 0o600 })
  expect(exit.exitPackage.vtxos.reduce((sum: number, coin: { value: number }) => sum + coin.value, 0)).toBe(40000)
  expect(exit.exitPackage.vtxos.every((coin: { skipped?: boolean }) => !coin.skipped)).toBe(true)
  await expect(page.getByRole('button', { name: 'Start Bitcoin recovery', exact: true })).toBeVisible()
  const status = await (
    await page.request.get(`http://127.0.0.1:18899/v1/status?vault=${saved.descriptor.vaultId}`)
  ).json()
  expect(status.periodSpent).toBe(10000)
  expect(status.periodRemaining).toBe(40000)
  await writeFile(
    join(directory, 'browser-payment-evidence.json'),
    JSON.stringify(
      {
        vaultId: saved.descriptor.vaultId,
        periodSpent: status.periodSpent,
        periodRemaining: status.periodRemaining,
        outputs: exit.exitPackage.vtxos,
        recoveredSats: exit.exitPackage.totals.recoveredSats,
        preparedWithoutPasskey: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  // Reload before the outage drill so recovery depends on persisted data.
  await page.reload()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await page.getByRole('button', { name: 'Use a local backup' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  })
  await page.getByRole('button', { name: 'Recover directly to Bitcoin', exact: true }).click()
  await page.getByLabel('Bitcoin address to recover to').fill(destination)
  await page.getByLabel('Recovery code', { exact: true }).fill(secret)
  await page.getByLabel('Use saved recovery data without contacting the Operator').check()
  const operatorRequests: string[] = []
  await page.route('https://mutinynet.arkade.sh/**', (route) => {
    operatorRequests.push(new URL(route.request().url()).pathname)
    return route.abort()
  })
  const offlineDownload = page.waitForEvent('download', { timeout: 90000 })
  await page.getByRole('button', { name: 'Prepare emergency exit', exact: true }).click()
  const offline = JSON.parse(await readFile((await (await offlineDownload).path())!, 'utf8'))
  expect(offline.exitPackage.vtxos.map((coin: { outpoint: string }) => coin.outpoint)).toEqual(
    exit.exitPackage.vtxos.map((coin: { outpoint: string }) => coin.outpoint),
  )
  expect(operatorRequests).toEqual([])
  await writeFile(join(directory, 'browser-offline-change-recovery.json'), JSON.stringify(offline, null, 2), {
    mode: 0o600,
  })
})

test('Light explains and pauses an existing Bitcoin recovery delay', async ({ page }) => {
  test.skip(
    process.env.VAULT_LIGHT_TEST_WAITING_EXIT !== '1',
    'Requires an existing confirmed prerequisite and pending CSV delay',
  )
  const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY!
  const { secret } = JSON.parse(await readFile(join(directory, 'browser-owner-backup.json'), 'utf8'))
  const saved = JSON.parse(await readFile(join(directory, 'browser-offline-change-recovery.json'), 'utf8'))
  const broadcasts: string[] = []
  await page.route('**/esplora/**', (route) => {
    if (route.request().method() === 'POST') {
      broadcasts.push(new URL(route.request().url()).pathname)
      return route.abort()
    }
    return route.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await page.getByRole('button', { name: 'Use a local backup' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'saved-exit.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  })
  await page.getByRole('button', { name: 'Recover directly to Bitcoin', exact: true }).click()
  await page.getByLabel('Recovery code', { exact: true }).fill(secret)
  await page.getByRole('button', { name: 'Continue to fee funding', exact: true }).click()
  await page.getByRole('button', { name: 'Start Bitcoin recovery', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('the owner-only delay ends around', { timeout: 45000 })
  await expect(page.getByRole('log')).not.toContainText('waiting_csv')
  await expect(page.getByRole('log')).toContainText('already confirmed on Bitcoin')
  await expect(page.getByRole('log').getByRole('link').first()).toHaveAttribute(
    'href',
    /^https:\/\/mempool\.mutinynet\.arkade\.sh\/tx\/[0-9a-f]{64}$/,
  )
  await page.getByRole('button', { name: 'Stop and resume later', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Recovery paused')
  await expect(page.getByLabel('Recovery code', { exact: true })).toHaveValue('')
  expect(broadcasts).toEqual([])
  await page.screenshot({ path: join(directory, 'recovery-wait-paused.png'), fullPage: true })
})

test.afterEach(async ({ page, passkey }, info) => {
  if (process.env.VAULT_LIGHT_TEST_RENEWAL !== '1') return
  const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY!
  await mkdir(directory, { recursive: true, mode: 0o700 })

  await writeFile(
    join(directory, info.title.includes('enrolls') ? 'browser-state.json' : 'browser-recovery-state.json'),
    JSON.stringify({
      state: await page.context().storageState(),
      credentials: await passkey.credentials(),
      text: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    }),
    { mode: 0o600 },
  )
})
