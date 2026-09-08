import { test, expect, reachPasskeySetup } from './fixtures/passkey'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'

test.skip(process.env.VAULT_SAVINGS_SETUP_LIVE !== 'mutinynet', 'Opt-in funded Mutinynet drill only')
test('funds the signer from Spending and retains replacement recovery paths', async ({ page, passkey }) => {
  const directory = process.env.VAULT_SAVINGS_SETUP_DIRECTORY!
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const resume = process.env.VAULT_SAVINGS_SETUP_RESUME === '1'
  if (!resume) await writeFile(join(directory, 'started'), new Date().toISOString(), { mode: 0o600, flag: 'wx' })
  const writes = new Map<string, Promise<void>>()
  const save = (name: string, value: unknown) => {
    const raw = JSON.stringify(value, null, 2)
    const written = (writes.get(name) || Promise.resolve()).then(() =>
      writeFile(join(directory, name), raw, { mode: 0o600 }),
    )
    writes.set(name, written)
    return written
  }
  // CDP exports the P-256 credential but omits its PRF state. Retain the
  // test-only PRF alongside the virtual credential to resume this funded drill.
  const prior = resume ? JSON.parse(await readFile(join(directory, 'private-wallet.json'), 'utf8')) : null
  const priorComplete = resume
    ? await readFile(join(directory, 'complete.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null)
    : null
  if (resume && !prior.prf) throw new Error('Saved virtual authenticator has no PRF state; do not request more funds')
  await page.addInitScript((savedPrf: number[] | null) => {
    const get = navigator.credentials.get.bind(navigator.credentials)
    navigator.credentials.get = async (options) => {
      if (savedPrf && options?.publicKey) {
        const extensions = { ...options.publicKey.extensions } as AuthenticationExtensionsClientInputs & {
          prf?: unknown
        }
        delete extensions.prf
        options = { ...options, publicKey: { ...options.publicKey, extensions } }
      }
      const credential = (await get(options)) as PublicKeyCredential | null
      if (!credential) return credential
      const original = credential.getClientExtensionResults.bind(credential)
      const extensions = original() as AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } }
      }
      const first = extensions.prf?.results?.first
      if (first) (globalThis as any).__fundedDrillPrf = Array.from(new Uint8Array(first))
      if (savedPrf)
        Object.defineProperty(credential, 'getClientExtensionResults', {
          value: () => ({ ...original(), prf: { results: { first: new Uint8Array(savedPrf).buffer } } }),
        })
      return credential
    }
  }, prior?.prf || null)
  const outcomes: unknown[] = []
  const requests: unknown[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith('/src/') && !u.pathname.startsWith('/node_modules/')) {
      requests.push({ kind: 'request', host: u.host, path: u.pathname, method: r.method() })
    }
  })
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith('/src/') && !u.pathname.startsWith('/node_modules/')) {
      requests.push({ kind: 'response', host: u.host, path: u.pathname, status: r.status() })
    }
  })
  page.on('requestfailed', (r) => {
    const u = new URL(r.url())
    requests.push({ kind: 'failed', host: u.host, path: u.pathname, error: r.failure()?.errorText })
  })
  await page.route('**/ready', async (route) => {
    const response = await page.request.get('http://127.0.0.1:53291/ready')
    await route.fulfill({ response })
  })
  await page.route('**/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.hostname !== 'localhost') return route.continue()
    const response = await page.request.fetch(`http://127.0.0.1:53291${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postData() || undefined,
    })
    if (
      !response.ok() ||
      url.pathname.startsWith('/v1/vtxo/savings-setup/') ||
      url.pathname.startsWith('/v1/vtxo/bitcoin/')
    ) {
      outcomes.push({ path: url.pathname, status: response.status(), body: await response.text() })
      await save('setup-outcomes.json', outcomes)
    }
    await route.fulfill({ response })
  })
  if (resume) {
    const saved = prior
    if (saved.status.network !== 'mutinynet') throw new Error('Restore requires Mutinynet')
    await passkey.restore(saved.credentials)
    await page.goto('/')
    await page.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage))
        if (key.startsWith('vaulted:savings-setup:')) localStorage.setItem(key, String(value))
    }, saved.localStorage)
    await page.getByRole('button', { name: 'Sign in to an existing vault', exact: true }).click()
  } else {
    // A shared fixture key can already have approval outputs from an earlier
    // funded drill. Give each new run its own disposable signing wallet.
    const signer = HDKey.fromMasterSeed(randomBytes(32), { public: 0x043587cf, private: 0x04358394 })
    const account = signer.derive("m/84'/1'/0'")
    const signerDescriptor = `wpkh([${signer.fingerprint.toString(16).padStart(8, '0')}/84'/1'/0']${account.publicExtendedKey}/0/*)`
    const hardwareSecret = hex.encode(account.derive('m/0/0').privateKey!)
    await reachPasskeySetup(page, false, signerDescriptor)
    await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Download Recovery Kit' })).toBeVisible({ timeout: 120000 })
    await page.getByRole('button', { name: 'I’ll save a separate copy later' }).click()
    await expect(page.getByTestId('account-switcher')).toBeVisible()
    const state = await page.evaluate(async () => {
      const base = '/src/lib/vault/'
      const store = await import(base + 'enrollmentStore.ts')
      const id = store.loadSelectedVaultId()
      const status = await (await fetch(`/v1/status?vault=${id}`)).json()
      if (status.network !== 'mutinynet') throw new Error('Funded drill requires Mutinynet')
      const { unlockPhoneBip340 } = await import(base + 'savingsSpend.ts')
      const secret = await unlockPhoneBip340(store.loadEnrollment(localStorage, id), status)
      try {
        return {
          status,
          phoneSecret: Array.from(secret, (b: number) => b.toString(16).padStart(2, '0')).join(''),
          localStorage: { ...localStorage },
          prf: (globalThis as any).__fundedDrillPrf,
        }
      } finally {
        secret.fill(0)
      }
    })
    await save('private-wallet.json', { ...state, hardwareSecret, credentials: await passkey.credentials() })
    await writeFile(join(directory, 'funding-requested'), state.status.spendingArkAddress, { flag: 'wx', mode: 0o600 })
    const funded = await page.request.post('https://faucet.mutinynet.arkade.sh/faucet', {
      data: { address: state.status.spendingArkAddress, amount: 10000 },
    })
    await save('faucet-result.json', { status: funded.status(), body: await funded.text() })
    expect(funded.ok()).toBe(true)
  }
  try {
    await expect(page.getByTestId('account-switcher')).toBeVisible({ timeout: 60000 })
    if (resume)
      await page.evaluate(
        async (saved) => {
          const path = '/src/test/e2e-vault/fixtures/savings-setup-resume.ts'
          const { retainPrototypeCancellation } = await import(path)
          await retainPrototypeCancellation(saved.status, saved.phoneSecret)
        },
        { status: prior.status, phoneSecret: prior.phoneSecret },
      )
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByTestId('account-savings').click()
    await page.getByTestId('account-receive').click()
    await expect(page.getByTestId('receive-address')).toBeVisible()
    await page.getByRole('button', { name: 'Set up Savings signer' }).click()
    await expect
      .poll(
        async () => {
          if (await page.getByRole('heading', { name: 'Your signer is ready' }).isVisible()) return true
          if (await page.getByRole('button', { name: 'Fund from Spending', exact: true }).isVisible()) return true
          const check = page.getByRole('button', { name: 'Check status', exact: true })
          if ((await check.isVisible()) && (await check.isEnabled())) await check.click()
          return false
        },
        { timeout: 300000, intervals: [5000] },
      )
      .toBe(true)
    if (!resume) await expect(page.getByRole('button', { name: 'Fund from Spending', exact: true })).toBeVisible()
    if (await page.getByRole('button', { name: 'Fund from Spending', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Fund from Spending', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible({ timeout: 45000 })
      await page.getByRole('button', { name: 'Confirm Bitcoin payment' }).click()
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 300000 })
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await page.getByTestId('account-savings').click()
      await page.getByTestId('account-receive').click()
      await page.getByRole('button', { name: 'Set up Savings signer' }).click()
    }
    await expect
      .poll(
        async () => {
          const error = page.getByRole('alert')
          if (await error.isVisible()) throw new Error(await error.innerText())
          if (await page.getByRole('heading', { name: 'Your signer is ready' }).isVisible()) return true
          const check = page.getByRole('button', { name: 'Check status', exact: true })
          if ((await check.isVisible()) && (await check.isEnabled())) await check.click()
          return page.getByRole('heading', { name: 'Your signer is ready' }).isVisible()
        },
        { timeout: 120000, intervals: [5000] },
      )
      .toBe(true)
    const confirmed = [...outcomes, ...(priorComplete?.outcomes || [])]
      .map((r: any) => {
        try {
          return JSON.parse(r.body)
        } catch {
          return null
        }
      })
      .find((r) => r?.state === 'confirmed')
    expect(confirmed?.receiverTxid).toMatch(/^[a-f0-9]{64}$/)
    const recovery = await page.evaluate(
      async (receipt) => {
        const base = '/src/lib/vault/'
        const store = await import(base + 'enrollmentStore.ts')
        const id = store.loadSelectedVaultId()
        const status = await (await fetch(`/v1/status?vault=${id}`)).json()
        const enrollment = store.loadEnrollment(localStorage, id)
        const { captureVaultRecoveryFile } = await import(base + 'recovery/capture.ts')
        const file = await captureVaultRecoveryFile(status, enrollment)
        const { kitFromFacts } = await import(base + 'program/kitBackup.ts')
        const { vaultRecoveryBinding } = await import(base + 'vtxo/recoveryArchive.ts')
        const { validateExitArchive } = await import(base + 'recovery/exitArchive.ts')
        const { recoveryFileStore } = await import(base + 'recovery/fileStore.ts')
        const durable = await recoveryFileStore(file.header.binding.descriptorHash)
        const binding = vaultRecoveryBinding(kitFromFacts({ status, enrollment }), status)
        const coins = validateExitArchive(durable.archive.spending, binding).coins
        const replacement = coins.find((c: any) => c.txid === receipt.receiverTxid && c.vout === receipt.receiverVout)
        if (!replacement) throw new Error('Durable backup omits replacement Spending exit')
        if (localStorage.getItem('vaulted:savings-setup:' + id))
          throw new Error('Confirmed setup journal was not reconciled')
        return {
          file: durable,
          replacement: { txid: replacement.txid, vout: replacement.vout, value: replacement.value },
        }
      },
      { ...confirmed, receiverVout: confirmed.receiverVout ?? 0 },
    )
    await save('complete-recovery-private.json', recovery.file)
    const bitcoin = await page.request.get(`https://mutinynet.com/api/tx/${confirmed.commitmentTxid}`)
    expect(bitcoin.ok()).toBe(true)
    await save('commitment.json', await bitcoin.json())
    const raw = await page.request.get(`https://mutinynet.com/api/tx/${confirmed.commitmentTxid}/hex`)
    expect(raw.ok()).toBe(true)
    await writeFile(join(directory, 'commitment.hex'), await raw.text(), { mode: 0o600 })
    await page.reload()
    await expect(page.getByTestId('account-switcher')).toBeVisible({ timeout: 60000 })
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByTestId('account-savings').click()
    await page.getByTestId('account-receive').click()
    await expect(page.getByTestId('receive-address')).toBeVisible({ timeout: 60000 })
    await page.getByRole('button', { name: 'Set up Savings signer' }).click()
    await expect(page.getByRole('heading', { name: 'Your signer is ready' })).toBeVisible({ timeout: 60000 })
    await expect(page.getByRole('button', { name: 'Fund from Spending', exact: true })).toHaveCount(0)
    await save('complete.json', {
      outcomes,
      replacement: recovery.replacement,
      text: await page.locator('body').innerText(),
    })
  } finally {
    await save('requests.json', requests)
    await save('diagnostics.json', await page.evaluate(() => JSON.parse(localStorage.getItem('logs') || '[]')))
    const saved = JSON.parse(await readFile(join(directory, 'private-wallet.json'), 'utf8'))
    await save('private-wallet.json', {
      ...saved,
      credentials: await passkey.credentials(),
      localStorage: await page.evaluate(() => ({ ...localStorage })),
    })
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})
