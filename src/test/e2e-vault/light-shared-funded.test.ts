import { test, expect } from './fixtures/passkey'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

test.skip(process.env.VAULT_LIGHT_LIVE !== 'mutinynet', 'Opt-in fresh shared Spending drill')
test('fresh Light enrolls with shared boarding, reloads and recovers its Spending contract', async ({
  page,
  passkey,
}) => {
  test.setTimeout(600000)
  const directory = process.env.VAULT_LIGHT_DRILL_DIRECTORY!
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
  const requests: { path: string; status: number }[] = []
  const consoleMessages: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().includes('Bitcoin payment')) consoleMessages.push(message.text())
  })
  page.on('response', async (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/v1/')) requests.push({ path: url.pathname, status: response.status() })
    if (url.pathname.startsWith('/v1/vtxo/bitcoin/') && response.status() >= 400)
      consoleMessages.push(`${url.pathname}: ${await response.text()}`)
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const resume = process.env.VAULT_SHARED_SPENDING_RESUME === '1'
  const prior = resume ? JSON.parse(await readFile(join(directory, 'browser-private.json'), 'utf8')) : null
  if (resume && prior?.prf?.length !== 32) throw new Error('Missing saved test passkey PRF')
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
      if (credential) {
        const original = credential.getClientExtensionResults.bind(credential)
        if (savedPrf)
          Object.defineProperty(credential, 'getClientExtensionResults', {
            value: () => ({ ...original(), prf: { results: { first: new Uint8Array(savedPrf).buffer } } }),
          })
        const result = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
          prf?: { results?: { first?: ArrayBuffer } }
        }
        if (result.prf?.results?.first)
          (globalThis as typeof globalThis & { drillPrf?: number[] }).drillPrf = Array.from(
            new Uint8Array(result.prf.results.first),
          )
      }
      return credential
    }
  }, prior?.prf || null)
  let prf: number[] | undefined = prior?.prf
  let state: { status: Record<string, unknown>; enrollment: Record<string, unknown> } | undefined
  try {
    if (resume) {
      // A stopped drill may have advanced the server counter after the last disk checkpoint.
      // Only this disposable CDP authenticator gets a fresh monotonic counter reservation.
      prior.credentials = prior.credentials.map((credential: { signCount: number }) => ({
        ...credential,
        signCount: credential.signCount + 1000,
      }))
      await save('browser-private.json', prior)
      await passkey.restore(prior.credentials)
      await page.goto('/')
      await page.evaluate((storage) => {
        for (const [key, value] of Object.entries(storage))
          if (key.startsWith('vaulted:savings-setup:')) localStorage.setItem(key, String(value))
      }, prior.browser.storage)
      await page.getByRole('button', { name: 'Sign in to an existing vault', exact: true }).click()
      await expect(page.getByTestId('vault-balance')).toBeVisible({ timeout: 60000 })
      state = await page.evaluate(async () => {
        const base = '/src/lib/vault/'
        const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        return { enrollment, status }
      })
    } else {
      await page.goto('/')
      await page.getByRole('button', { name: 'Get started', exact: true }).click()
      await page.getByRole('button', { name: /^Light Passkey payments/ }).click()
      await page.getByLabel('Per payment', { exact: true }).fill('20000')
      await page.getByLabel('Rolling 24-hour limit', { exact: true }).fill('50000')
      await page.getByRole('button', { name: 'Review setup', exact: true }).click()
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Save your Recovery Kit' })).toBeVisible({ timeout: 60000 })
      await page.getByRole('button', { name: 'I’ll save a separate copy later' }).click()
      await expect(page.getByTestId('vault-balance')).toHaveText('₿0', { timeout: 45000 })
      state = await page.evaluate(async () => {
        const base = '/src/lib/vault/'
        const store = await import(base + 'enrollmentStore.ts')
        const enrollment = store.findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        return { enrollment, status }
      })
      expect(state!.status.templateVersion).toBe('vaulted-spending-v1')
      expect(state!.status.vtxoBoardingActive).toBe(true)
      expect(state!.status.vtxoBoardingAddress).toMatch(/^tb1p/)
      expect(state!.status.lightDescriptor).toBeUndefined()
      expect(state!.status.passkeyLoginAvailable).toBe(true)
      await save('enrollment-status.json', state!.status)
      await page.getByRole('button', { name: 'Receive', exact: true }).click()
      await expect(page.getByTestId('receive-bitcoin-address')).toBeVisible()
      await page.screenshot({ path: join(directory, 'receive.png'), fullPage: true })
      await page.getByRole('button', { name: 'Go back', exact: true }).click()
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
      await page.getByRole('button', { name: 'Savings', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Add address', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Transfer', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
      await page.getByRole('button', { name: 'Spending', exact: true }).click()
      prf = await page.evaluate(() => (globalThis as typeof globalThis & { drillPrf?: number[] }).drillPrf)
      expect(prf?.length).toBe(32)
      await page.reload()
      await expect(page.getByTestId('vault-balance')).toHaveText('₿0', { timeout: 45000 })
      const worker = await page.evaluate(async () => {
        const base = '/src/lib/vault/'
        const store = await import(base + 'enrollmentStore.ts')
        const status = await (
          await import(base + 'status.ts')
        ).fetchVaultStatus(undefined, store.findStoredEnrollment().vaultId)
        const { ensureVaultWalletWorker } = await import(base + 'vtxo/walletWorker.ts')
        const runtime = await ensureVaultWalletWorker(status)
        return {
          boarding: await runtime.wallet.getBoardingAddress(),
          contracts: await (await runtime.wallet.getContractManager()).getContracts(),
        }
      })
      expect(worker.boarding).toBe(state!.status.vtxoBoardingAddress)
      expect(
        worker.contracts
          .filter((contract: { type: string; state: string }) => contract.state === 'active')
          .map((contract: { type: string }) => contract.type),
      ).toEqual(['vault-policy-v1'])
      await save('worker-after-reload.json', worker)
    }
    if (process.env.VAULT_SHARED_SPENDING_FUND !== '1') return
    if (!resume) {
      await writeFile(join(directory, 'funding-requested'), String(state!.status.vtxoBoardingAddress), {
        flag: 'wx',
        mode: 0o600,
      })
      const response = await page.request.post('https://faucet.mutinynet.arkade.sh/faucet', {
        data: { address: state!.status.vtxoBoardingAddress, amount: 50000 },
        timeout: 60000,
      })
      await save('boarding-faucet.json', { status: response.status(), body: await response.text() })
      expect(response.ok()).toBe(true)
    }
    if (process.env.VAULT_SHARED_SPENDING_RETRY === '1') {
      const cancelled = await page.evaluate(async () => {
        const base = '/src/lib/vault/'
        const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        const funding = await import(base + 'spendingBitcoinFunding.ts')
        const prior = await funding.checkSpendingBitcoin(status)
        return prior ? funding.cancelSpendingBitcoin(status) : { state: 'cancelled' }
      })
      await save('cancelled-payment.json', cancelled)
      expect(['released', 'cancelled']).toContain(cancelled?.state)
    }
    if (process.env.VAULT_SHARED_SPENDING_CONFIRM !== '1')
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const base = '/src/lib/vault/'
              const store = await import(base + 'enrollmentStore.ts')
              const status = await (
                await import(base + 'status.ts')
              ).fetchVaultStatus(undefined, store.findStoredEnrollment().vaultId)
              return await (await import(base + 'vtxo/walletWorker.ts')).fetchVaultWalletVtxoSnapshot(status)
            }),
          { timeout: 360000, intervals: [5000] },
        )
        .toMatchObject({ balance: 50000, boardingBalance: 0 })
    if (process.env.VAULT_SHARED_SPENDING_CONFIRM !== '1')
      await save('funded-balance-qualified.json', {
        address: state!.status.vtxoBoardingAddress,
        spending: state!.status.spendingArkAddress,
        amount: 50000,
      })
    if (process.env.VAULT_SHARED_SPENDING_PAYMENT === '1') {
      const recovery = await page.evaluate(async (paymentOnly) => {
        const base = '/src/lib/vault/'
        const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        if (paymentOnly) {
          const module = '/src/test/e2e-vault/fixtures/shared-spending-live.ts'
          const { p2tr, hex, getNetwork } = await import(module)
          return {
            destination: p2tr(hex.decode(status.phoneBip340Pub).slice(1), undefined, getNetwork('mutinynet')).address,
          }
        }
        const file = await (await import(base + 'recovery/capture.ts')).captureVaultRecoveryFile(status, enrollment)
        const key = await (await import(base + 'savingsSpend.ts')).unlockPhoneBip340(enrollment, status)
        try {
          const module = '/src/test/e2e-vault/fixtures/shared-spending-live.ts'
          const { p2tr, hex, Transaction, EsploraProvider, getNetwork } = await import(module)
          const destination = p2tr(
            hex.decode(status.phoneBip340Pub).slice(1),
            undefined,
            getNetwork('mutinynet'),
          ).address
          const prepared = await (
            await import(base + 'vtxo/spendingRecovery.ts')
          ).prepareVaultSpendingRecovery(
            file.archive,
            destination,
            async ({ psbt, requiredKeys }: { psbt: string; requiredKeys: { role: string }[] }) => {
              if (requiredKeys.length !== 1 || requiredKeys[0].role !== 'phone')
                throw new Error('Unexpected recovery signer')
              const tx = Transaction.fromPSBT(hex.decode(psbt))
              tx.sign(key)
              return hex.encode(tx.toPSBT())
            },
            new EsploraProvider('https://mempool.mutinynet.arkade.sh/api'),
          )
          return { file, prepared, destination }
        } finally {
          key.fill(0)
        }
      }, process.env.VAULT_SHARED_SPENDING_PAYMENT_ONLY === '1')
      await save('funded-recovery-private.json', recovery)
      const result = await page.evaluate(async (destination) => {
        const base = '/src/lib/vault/'
        const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        const funding = await import(base + 'spendingBitcoinFunding.ts')
        const prior = await funding.checkSpendingBitcoin(status)
        if (prior) return prior
        const { scriptHexFromAddress } = await import(base + 'bitcoin.ts')
        return funding.sendSpendingToBitcoin(
          enrollment,
          status,
          [{ script: scriptHexFromAddress(destination, 'mutinynet'), amountSats: 10000 }],
          async (plan: import('../../lib/vault/spendingBitcoinStore').SpendingBitcoinPlan) => {
            if (
              plan.outputs?.length !== 1 ||
              plan.outputs[0].amountSats !== 10000 ||
              plan.feeSats > status.absoluteFeeCap
            )
              throw new Error('Unexpected Bitcoin plan')
            return true
          },
          () => undefined,
        )
      }, recovery.destination)
      await save('bitcoin-payment.json', result)
      expect(['submitted', 'confirmed']).toContain(result.state)
      if (result.state !== 'confirmed') {
        await expect
          .poll(
            async () =>
              page.evaluate(async () => {
                const base = '/src/lib/vault/'
                const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
                const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
                const result = await (await import(base + 'spendingBitcoinFunding.ts')).checkSpendingBitcoin(status)
                return result?.state
              }),
            { timeout: 180000, intervals: [5000] },
          )
          .toBe('confirmed')
      }
      await page.reload()
      await expect(page.getByTestId('vault-balance')).toBeVisible({ timeout: 60000 })
      const after = await page.evaluate(async () => {
        const base = '/src/lib/vault/'
        const enrollment = (await import(base + 'enrollmentStore.ts')).findStoredEnrollment()
        const status = await (await import(base + 'status.ts')).fetchVaultStatus(undefined, enrollment.vaultId)
        return (await import(base + 'recovery/capture.ts')).captureVaultRecoveryFile(status, enrollment)
      })
      await save('post-payment-recovery-private.json', after)
    }
    expect(errors).toEqual([])
  } finally {
    await save('browser-private.json', {
      state: state || prior?.state,
      prf,
      credentials: await passkey.credentials(),
      browser: await page
        .evaluate(() => ({
          storage: { ...localStorage },
          prf: (globalThis as typeof globalThis & { drillPrf?: number[] }).drillPrf,
        }))
        .catch(() => null),
    })
    await save('page-errors.json', errors)
    await save('requests.json', requests)
    await save('console-private.json', consoleMessages)
    await save('last-page.json', {
      text: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    })
  }
})
