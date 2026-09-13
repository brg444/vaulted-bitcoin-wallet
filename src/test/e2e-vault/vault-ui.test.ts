import { mockVaultBalances, openLight } from './fixtures/light-ui'
import { expectWalletLayout } from './fixtures/layout'
import { mockEnrollmentAccess } from './fixtures/enrollmentAccess'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { decodeVaultBip21 } from '../../lib/vault/bip21'
import { POLICY_VERSION } from '../../lib/vault/constants'
import { SPENDING_ONLY_TEMPLATE } from '../../lib/vault/spendingEnrollment'
import { LEDGER_NATIVE_TEMPLATE } from '../../lib/vault/program/ledgerNativeKeys'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../lib/vault/spendingPolicy'
import { BOARDING_PROGRAM } from '../../lib/vault/vtxo/board'
import type { VaultStatus } from '../../lib/vault/types'

const UI_FIXTURE = '/src/test/e2e-vault/fixtures/vault-ui.ts'
const WORKER_FIXTURE = '/src/test/e2e-vault/fixtures/vtxo-browser.ts'
const KIT_STORE_MODULE = '/src/lib/vault/program/kitStore.ts'
const LEDGER_RECOVERY_MODULE = '/src/lib/vault/ledgerRecovery.ts'
const SAVINGS_RECOVERY_MODULE = '/src/lib/vault/program/onchainRecovery.ts'
const APP_PORT = process.env.VAULT_E2E_PORT || '3003'
const OPERATOR_PORT = process.env.VAULT_E2E_OPERATOR_PORT || '18888'
const APP_ORIGIN = `http://localhost:${APP_PORT}`
const OPERATOR_ORIGIN = `http://127.0.0.1:${OPERATOR_PORT}`
const OPERATOR_CONTROL = `${OPERATOR_ORIGIN}/__vault_e2e_operator`
const AUTHORIZER_CONTROL = `${OPERATOR_ORIGIN}/__vault_e2e_authorizer`
const ESPLORA_CONTROL = `${OPERATOR_ORIGIN}/__vault_e2e_esplora`
const BOARDING_TXID = '11'.repeat(32)
const SAVINGS_TXID = '22'.repeat(32)
const VTXO_TXID = 'aa'.repeat(32)
const COMMITMENT_TXID = 'cc'.repeat(32)

// Navigation tests must not depend on the host camera or permission prompts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] })
  })
})

type EsploraUtxo = {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean; block_height?: number }
}

type EsploraTx = {
  txid: string
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[]
  vout: { scriptpubkey_address?: string; value?: number }[]
  status: { confirmed: boolean; block_height?: number; block_time?: number }
}

type VaultUiState = {
  boardingUtxos: EsploraUtxo[]
  savingsTxs: EsploraTx[]
  savingsUtxos: EsploraUtxo[]
}

type OperatorFixtureState = {
  available?: boolean
  requests?: string[]
  vtxos?: Record<string, unknown>[]
}

type OpenVaultOptions = {
  savingsDepositSats?: number
  readySelector?: string
  operatorAvailable?: boolean
  operatorVtxos?: Record<string, unknown>[]
  waitForBalance?: boolean
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function setOperatorState(input: OperatorFixtureState = {}) {
  const response = await fetch(OPERATOR_CONTROL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Operator fixture reset failed: ${response.status}`)
}

async function setOperatorVtxos(vtxos: Record<string, unknown>[] = []) {
  await setOperatorState({ available: true, vtxos })
}

async function setAuthorizerStatus(status: VaultStatus) {
  const response = await fetch(AUTHORIZER_CONTROL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(status),
  })
  if (!response.ok) throw new Error(`Authorizer fixture reset failed: ${response.status}`)
}

async function setEsploraState(status: VaultStatus, state: VaultUiState) {
  const response = await fetch(ESPLORA_CONTROL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boardingAddress: status.vtxoBoardingAddress,
      boardingUtxos: state.boardingUtxos,
      savingsAddress: status.savingsAddress,
      savingsTxs: state.savingsTxs,
      savingsUtxos: state.savingsUtxos,
    }),
  })
  if (!response.ok) throw new Error(`Esplora fixture reset failed: ${response.status}`)
}

async function wireVtxo(page: Page, status: VaultStatus, input: Record<string, unknown>) {
  return page.evaluate(
    async ({ fixturePath, currentStatus, currentInput }) => {
      const fixture = await import(/* @vite-ignore */ fixturePath)
      return fixture.wireVaultVtxo(currentStatus, currentInput)
    },
    { fixturePath: UI_FIXTURE, currentStatus: status, currentInput: input },
  ) as Promise<Record<string, unknown>>
}

async function dispatchUtxoUpdate(page: Page, vaultId: string) {
  await page.evaluate(
    async ({ fixturePath, id }) => {
      const fixture = await import(/* @vite-ignore */ fixturePath)
      fixture.dispatchWalletUtxoUpdate(id)
    },
    { fixturePath: WORKER_FIXTURE, id: vaultId },
  )
}

async function seedReviewedSpend(
  page: Page,
  status: VaultStatus,
  destination: string,
  amountSats: number,
  feeSats: number,
  changeSats: number,
) {
  await page.evaluate(
    async ({ fixturePath, currentStatus, destAddress, amount, fee, change }) => {
      const fixture = await import(/* @vite-ignore */ fixturePath)
      fixture.seedReviewedVtxoSpend(currentStatus, destAddress, amount, fee, change)
    },
    {
      fixturePath: UI_FIXTURE,
      currentStatus: status,
      destAddress: destination,
      amount: amountSats,
      fee: feeSats,
      change: changeSats,
    },
  )
}

async function refreshHome(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('vault-balance')).not.toHaveAttribute('aria-busy', 'true')
}

async function installRoutes(page: Page, getStatus: () => VaultStatus | undefined, state: VaultUiState) {
  await page.route('**/ready', (route) =>
    json(route, {
      ok: true,
      schema: 12,
      network: 'mutinynet',
      enrollTemplate: SPENDING_ONLY_TEMPLATE,
      arkadeOrigin: OPERATOR_ORIGIN,
      arkadeVersion: 'e2e',
    }),
  )
  await page.route('**/v1/status*', async (route) => {
    const url = new URL(route.request().url())
    const status = getStatus()
    if (url.searchParams.has('vault')) {
      return status ? json(route, status) : json(route, { error: 'Vault fixture is not installed yet' }, 503)
    }
    return json(route, {
      network: 'mutinynet',
      clientOrigin: APP_ORIGIN,
      rpId: 'localhost',
      templateVersion: SPENDING_ONLY_TEMPLATE,
      policyVersion: POLICY_VERSION,
      enrollmentMode: 'token',
      supportedSetups: ['light', 'standard', 'advanced'],
      ledgerSavingsCapability: { version: 1, templateVersion: LEDGER_NATIVE_TEMPLATE },
      spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
      vtxoBoardingProgram: BOARDING_PROGRAM,
    })
  })
  await page.route('**/v1/vtxo/operation*', (route) => json(route, { error: 'operation not found' }, 404))
  await page.route('**/esplora/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/esplora/blocks/tip/height') return route.fulfill({ status: 200, body: '1' })
    if (url.pathname === '/esplora/tx' && request.method() === 'POST') {
      return route.fulfill({ status: 200, body: 'dd'.repeat(32) })
    }
    const addressUtxos = url.pathname.match(/^\/esplora\/address\/([^/]+)\/utxo$/)
    if (addressUtxos) {
      const status = getStatus()
      const address = decodeURIComponent(addressUtxos[1])
      if (address === status?.savingsAddress) return json(route, state.savingsUtxos)
      if (address === status?.vtxoBoardingAddress) return json(route, state.boardingUtxos)
      return json(route, [])
    }
    const addressTxs = url.pathname.match(/^\/esplora\/address\/([^/]+)\/txs(?:\/chain\/[^/]+)?$/)
    if (addressTxs) {
      const address = decodeURIComponent(addressTxs[1])
      return json(route, address === getStatus()?.savingsAddress ? state.savingsTxs : [])
    }
    return json(route, { error: `unhandled Esplora fixture path ${url.pathname}` }, 404)
  })
}

async function openVault(page: Page, initial: Partial<VaultUiState> = {}, options: OpenVaultOptions = {}) {
  let status: VaultStatus | undefined
  const state: VaultUiState = {
    boardingUtxos: initial.boardingUtxos || [],
    savingsTxs: initial.savingsTxs || [],
    savingsUtxos: initial.savingsUtxos || [],
  }
  await installRoutes(page, () => status, state)
  await setOperatorState({
    available: options.operatorAvailable !== false,
    vtxos: options.operatorVtxos || [],
  })
  await page.goto('/')
  const installed = await page.evaluate(async (fixturePath) => {
    const fixture = await import(/* @vite-ignore */ fixturePath)
    return { destination: fixture.VAULT_UI_DESTINATION, status: await fixture.installVaultUiSession() }
  }, UI_FIXTURE)
  const currentStatus = installed.status as VaultStatus
  status = currentStatus
  if (options.savingsDepositSats) {
    const deposit = await page.evaluate(
      async ({ fixturePath, status, value }) => {
        const fixture = await import(/* @vite-ignore */ fixturePath)
        return fixture.vaultUiSavingsDeposit(status, value)
      },
      { fixturePath: UI_FIXTURE, status: currentStatus, value: options.savingsDepositSats },
    )
    state.savingsUtxos.push(deposit.utxo)
    await page.route(`**/esplora/tx/${deposit.utxo.txid}/hex`, (route) =>
      route.fulfill({ status: 200, body: deposit.parentHex }),
    )
  }
  await setAuthorizerStatus(currentStatus)
  await setEsploraState(currentStatus, state)
  await page.reload()
  await expect(
    options.readySelector ? page.locator(options.readySelector) : page.getByTestId('account-switcher'),
  ).toBeVisible()
  if (options.waitForBalance !== false) {
    try {
      await expect(page.getByTestId('vault-balance')).not.toHaveText('—', { timeout: 15_000 })
    } catch (error) {
      const operator = await fetch(OPERATOR_CONTROL).then((response) => response.text())
      const runtimeError = await page.evaluate(
        async ({ currentStatus, workerPath }) => {
          const worker = await import(/* @vite-ignore */ workerPath)
          try {
            await worker.ensureVaultWalletWorker(currentStatus)
            return 'none'
          } catch (failure) {
            return failure instanceof Error ? failure.stack || failure.message : String(failure)
          }
        },
        { currentStatus, workerPath: '/src/lib/vault/vtxo/walletWorker.ts' },
      )
      const diagnostics = await page.evaluate(() => localStorage.getItem('logs'))
      throw new Error(
        `Vault Home did not finish loading. Runtime: ${runtimeError}. Diagnostics: ${diagnostics}. Operator fixture: ${operator}`,
        {
          cause: error,
        },
      )
    }
  }
  return { destination: installed.destination as string, state, status: currentStatus }
}

async function recoveryKitJson(page: Page, vaultId: string): Promise<string> {
  return page.evaluate(
    async ({ id, storePath }) => {
      const store = await import(/* @vite-ignore */ storePath)
      const kit = store.loadLocalKit(id)
      if (!kit) throw new Error('Recovery Kit fixture is missing')
      return JSON.stringify(kit)
    },
    { id: vaultId, storePath: KIT_STORE_MODULE },
  )
}

async function recoveryCoin(page: Page, vaultId: string, pending = false) {
  const result = await page.evaluate(
    async ({ id, storePath, fixturePath, fromPending }) => {
      const [store, fixture] = await Promise.all([
        import(/* @vite-ignore */ storePath),
        import(/* @vite-ignore */ fixturePath),
      ])
      const kit = store.loadLocalKit(id)
      if (!kit) throw new Error('Recovery Kit fixture is missing')
      const source = fromPending ? kit.descriptor.pending['savings-hardware'] : kit.descriptor.savings
      const coins = await fixture.vaultUiRecoveryCoins()
      const coin = coins.find((c: { script: string }) => c.script === source.script)
      if (!coin?.parentHex) throw new Error('Ledger recovery parent is missing')
      return { coin, address: source.address, pendingAddress: kit.descriptor.pending['savings-hardware'].address }
    },
    { id: vaultId, storePath: KIT_STORE_MODULE, fixturePath: UI_FIXTURE, fromPending: pending },
  )
  await page.route(`**/esplora/tx/${result.coin.txid}/hex`, (route) =>
    route.fulfill({ status: 200, body: result.coin.parentHex }),
  )
  const coin: EsploraUtxo = { ...result.coin, status: { confirmed: true, block_height: 1 } }
  return { ...result, coin }
}

async function downloadedRecovery(page: Page) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save recovery file', exact: true }).click()
  const path = await (await downloadPromise).path()
  if (!path) throw new Error('Ledger recovery download path is missing')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function clearVaultWorkers(context: BrowserContext) {
  for (const page of context.pages()) {
    await page
      .evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(
          registrations.filter((item) => item.scope.includes('/__vault-wallet/')).map((item) => item.unregister()),
        )
      })
      .catch(() => undefined)
  }
}

test.afterEach(async ({ context }) => {
  await clearVaultWorkers(context)
  await setOperatorVtxos()
})

test('@docs captures the current mobile wallet journey', async ({ page }) => {
  const output = (name: string) => resolve('docs/images/wallet', name)
  const pending: EsploraUtxo = {
    txid: BOARDING_TXID,
    vout: 0,
    value: 48_000,
    status: { confirmed: false },
  }
  const { destination, status } = await openVault(page, { boardingUtxos: [pending] }, { savingsDepositSats: 100_000 })
  await setOperatorVtxos([
    await wireVtxo(page, status, {
      amount: 80_000,
      txid: VTXO_TXID,
      createdAt: Date.UTC(2026, 7, 20, 10, 0, 0),
    }),
  ])
  await refreshHome(page)
  await page.screenshot({ path: output('home-spending-mobile.png'), animations: 'disabled', fullPage: true })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  await expect(page.getByTestId('vault-balance')).toContainText('100,000')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: output('home-savings-mobile.png'), animations: 'disabled', fullPage: true })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-spend').click()
  await page.getByTestId('account-receive').click()
  await page.screenshot({ path: output('receive-mobile.png'), animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()

  await seedReviewedSpend(page, status, destination, 12_000, 500, 67_500)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByTestId('vault-send-amount').fill('12000')
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(destination)
  await page.getByRole('button', { name: 'Resume payment' }).click()
  await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
  await page.screenshot({ path: output('review-payment-mobile.png'), animations: 'disabled', fullPage: true })

  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await page.screenshot({ path: output('security-mobile.png'), animations: 'disabled', fullPage: true })
  await page.getByTestId('security-kit').click()
  await page.screenshot({ path: output('recovery-kit-mobile.png'), animations: 'disabled', fullPage: true })
})

test('renders the Spending BIP21 request and copies each underlying address', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  const { status } = await openVault(page)

  await page.getByTestId('account-receive').click()
  await expect(page.getByRole('heading', { name: 'Receive' })).toBeVisible()
  await expect(page.locator('.vault-receive-qr-large svg')).toBeVisible()
  await expect(page.getByTestId('receive-address')).toHaveCount(0)

  await page.getByTestId('receive-arkade-address').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(status.spendingArkAddress)

  await page.getByTestId('receive-bitcoin-address').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(status.vtxoBoardingAddress)

  await page.getByRole('button', { name: 'Share' }).click()
  const request = await page.evaluate(() => navigator.clipboard.readText())
  expect(decodeVaultBip21(request)).toEqual({
    bitcoinAddress: status.vtxoBoardingAddress,
    arkadeAddress: status.spendingArkAddress,
  })
})

test('ignores another vault worker update and refreshes on the matching update', async ({ page }) => {
  const { status } = await openVault(page)
  await expect(page.getByTestId('vault-balance')).toContainText('0')

  await setOperatorVtxos([await wireVtxo(page, status, { amount: 25_000, txid: VTXO_TXID })])
  await dispatchUtxoUpdate(page, 'another-vault')
  await page.waitForTimeout(350)
  await expect(page.getByTestId('vault-balance')).toContainText('0')

  await dispatchUtxoUpdate(page, status.vaultId)
  await expect(page.getByTestId('vault-balance')).toContainText('25,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()
})

test('switches the Home balance between sats and USD using the live price feed', async ({ page }) => {
  await page.route('https://blockchain.info/ticker', (route) =>
    json(route, {
      USD: { last: 125_000 },
    }),
  )
  const { status } = await openVault(page)
  await setOperatorVtxos([await wireVtxo(page, status, { amount: 128_000, txid: VTXO_TXID })])
  await dispatchUtxoUpdate(page, status.vaultId)

  const balance = page.getByTestId('vault-balance')
  await expect(balance).toContainText('₿128,000')
  await balance.click()
  await expect(balance).toContainText('$160.00')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arkade-vault-balance-unit'))).toBe('usd')

  await balance.click()
  await expect(balance).toContainText('₿128,000')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arkade-vault-balance-unit'))).toBeNull()
})

test('loads Spending while another tab holds the foreground Lightning lock', async ({ context, page }) => {
  const blocker = await context.newPage()
  await blocker.goto('/')
  await blocker.evaluate(async (fixturePath) => {
    const { VAULT_UI_ID } = await import(/* @vite-ignore */ fixturePath)
    const state = globalThis as typeof globalThis & {
      __vaultLightningLockHeld?: boolean
      __releaseVaultLightningLock?: () => void
    }
    void navigator.locks.request(`arkade-vault-lightning:${VAULT_UI_ID}`, { mode: 'exclusive' }, async () => {
      state.__vaultLightningLockHeld = true
      await new Promise<void>((resolve) => {
        state.__releaseVaultLightningLock = resolve
      })
    })
  }, UI_FIXTURE)
  await expect
    .poll(() =>
      blocker.evaluate(() =>
        Boolean((globalThis as typeof globalThis & { __vaultLightningLockHeld?: boolean }).__vaultLightningLockHeld),
      ),
    )
    .toBe(true)

  try {
    await openVault(page)
    await expect(page.getByTestId('vault-balance')).toContainText('0')
  } finally {
    await blocker.evaluate(() =>
      (globalThis as typeof globalThis & { __releaseVaultLightningLock?: () => void }).__releaseVaultLightningLock?.(),
    )
  }
})

test('keeps cached Spending balance and history during an open-session outage, then refreshes', async ({
  context,
  page,
}) => {
  const { status } = await openVault(page)
  const cached = await wireVtxo(page, status, { amount: 25_000, txid: VTXO_TXID })
  await setOperatorVtxos([cached])
  await dispatchUtxoUpdate(page, status.vaultId)
  await expect(page.getByTestId('vault-balance')).toContainText('25,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()

  const nextTxid = 'ab'.repeat(32)
  await setOperatorVtxos([
    { ...cached, isSpent: true, spentBy: nextTxid, arkTxid: nextTxid },
    await wireVtxo(page, status, { amount: 30_000, txid: nextTxid }),
  ])
  await context.setOffline(true)
  await refreshHome(page)
  await expect(page.getByTestId('vault-balance')).toContainText('25,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()

  await context.setOffline(false)
  await dispatchUtxoUpdate(page, status.vaultId)
  await expect(page.getByTestId('vault-balance')).toContainText('30,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()
})

test('fails closed without an Operator cache and recovers in the background', async ({ page }) => {
  const { status } = await openVault(page, {}, { operatorAvailable: false, waitForBalance: false })
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(page.getByText('Loading activity…')).toBeVisible()
  await expect(page.getByTestId('vault-balance')).toHaveText('—')

  await setOperatorVtxos([await wireVtxo(page, status, { amount: 25_000, txid: VTXO_TXID })])
  await refreshHome(page)
  await expect(page.getByTestId('vault-balance')).toContainText('25,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()
})

test('keeps a submitted payment and its change visible after reload and opens its original review', async ({
  page,
}) => {
  const { destination, status } = await openVault(page)
  await seedReviewedSpend(page, status, destination, 1505, 0, 31953)
  await page.evaluate(
    async ({ vaultId, script }) => {
      const modulePath = '/src/lib/vault/vtxo/spendingJournal.ts'
      const spends = await import(/* @vite-ignore */ modulePath)
      const pending = spends.loadPersistedVtxoSpend(vaultId)
      spends.persistVtxoSpend({
        ...pending,
        stage: 'operator-submitted',
        reservedInputs: [{ txid: 'aa'.repeat(32), vout: 0, valueSats: 33458, scriptHex: script }],
      })
    },
    { vaultId: status.vaultId, script: status.spendingArkScript },
  )
  await page.reload()
  await expect(page.getByTestId('vault-balance')).toContainText('31,953')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(page.getByRole('region', { name: 'Pending payment' })).toContainText('1,505')
  await page.getByRole('button', { name: 'Resume payment', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Resume payment' })).toBeVisible()
  await expect(page.getByText('₿1,505', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByRole('region', { name: 'Payment details' })).toContainText(destination)
})

test('renders an exact reviewed VTXO send before approval', async ({ page }) => {
  const { destination, status } = await openVault(page)
  await setOperatorVtxos([await wireVtxo(page, status, { amount: 20_000, txid: VTXO_TXID })])
  await dispatchUtxoUpdate(page, status.vaultId)
  await expect(page.getByTestId('vault-balance')).toContainText('20,000')
  await seedReviewedSpend(page, status, destination, 12_000, 500, 7_500)

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('₿20,000 available within your rolling limit')).toBeVisible()
  await page.getByTestId('vault-send-amount').fill('12000')
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(destination)
  await page.getByRole('button', { name: 'Resume payment' }).click()

  await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
  await expect(page.getByText('₿12,000', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByRole('region', { name: 'Payment details' }).locator('strong').first()).toContainText(
    destination,
  )
  await expect(page.getByText('₿500', { exact: true })).toBeVisible()
  await expect(page.getByText('₿12,500', { exact: true })).toBeVisible()
  await expect(page.getByText('Approve with your passkey. The vault service checks your payment limits.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve payment' })).toBeVisible()
})

test('renders an exact no-change VTXO send with the resolved time before its receive', async ({ page }) => {
  const { status } = await openVault(page)
  const inputTxid = '21'.repeat(32)
  const sendTxid = '31'.repeat(32)
  const receivedAt = Date.UTC(2026, 7, 20, 10, 0, 0)
  const sentAt = Date.UTC(2026, 7, 21, 12, 2, 0)
  const input = await wireVtxo(page, status, {
    amount: 12_500,
    txid: inputTxid,
    createdAt: receivedAt,
    isSpent: true,
    spentBy: sendTxid,
    arkTxid: sendTxid,
  })
  const resolver = {
    ...(await wireVtxo(page, status, { amount: 1, txid: sendTxid, createdAt: sentAt })),
    script: `5120${'99'.repeat(32)}`,
  }
  await setOperatorVtxos([input, resolver])
  await dispatchUtxoUpdate(page, status.vaultId)

  const sent = page.getByTestId(`vault-tx-${sendTxid}`)
  await expect(page.getByTestId('vault-balance')).toContainText('0')
  await expect(sent).toContainText('Sent')
  await expect(sent).toContainText('₿12,500')
  const expectedTime = await page.evaluate(
    (timestamp) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp)),
    sentAt,
  )
  await expect(sent).toContainText(`Sent · ${expectedTime}`)
  const rows = page.locator('[data-testid^="vault-tx-"]')
  await expect(rows.nth(0)).toHaveAttribute('data-testid', `vault-tx-${sendTxid}`)
  await expect(rows.nth(1)).toHaveAttribute('data-testid', `vault-tx-${inputTxid}`)
})

test('nets VTXO change into one rendered send and omits it as a receive', async ({ page }) => {
  const { status } = await openVault(page)
  const inputTxid = '41'.repeat(32)
  const sendTxid = '51'.repeat(32)
  const input = await wireVtxo(page, status, {
    amount: 20_000,
    txid: inputTxid,
    createdAt: Date.UTC(2026, 7, 20, 10, 0, 0),
    isSpent: true,
    spentBy: sendTxid,
    arkTxid: sendTxid,
  })
  const change = await wireVtxo(page, status, {
    amount: 7_500,
    txid: sendTxid,
    vout: 1,
    createdAt: Date.UTC(2026, 7, 21, 12, 2, 0),
  })
  await setOperatorVtxos([input, change])
  await dispatchUtxoUpdate(page, status.vaultId)

  const sent = page.getByTestId(`vault-tx-${sendTxid}`)
  await expect(page.getByTestId('vault-balance')).toContainText('7,500')
  await expect(sent).toHaveCount(1)
  await expect(sent).toContainText('Sent')
  await expect(sent).toContainText('₿12,500')
  await expect(sent).not.toContainText('Received')
  await expect(page.getByTestId(`vault-tx-${inputTxid}`)).toContainText('Received')
})

test('shows a pending boarding deposit, then replaces it with the confirmed VTXO without double counting', async ({
  page,
}) => {
  const pending: EsploraUtxo = {
    txid: BOARDING_TXID,
    vout: 0,
    value: 50_000,
    status: { confirmed: false },
  }
  const { state, status } = await openVault(page, { boardingUtxos: [pending] })

  await expect(page.getByTestId('vault-balance')).toContainText('50,000')
  await expect(page.getByText(/available ·.*pending/)).toContainText('₿50,000 pending')
  await expect(page.getByTestId('spending-total')).toHaveCount(0)
  await expect(page.getByTestId(`vault-tx-${BOARDING_TXID}`)).toContainText('Pending')

  state.boardingUtxos = []
  await setEsploraState(status, state)
  await setOperatorVtxos([
    await wireVtxo(page, status, {
      amount: 49_000,
      txid: VTXO_TXID,
      commitmentTxids: [COMMITMENT_TXID],
    }),
  ])
  await refreshHome(page)

  await expect(page.getByTestId('vault-balance')).toContainText('49,000')
  await expect(page.getByTestId(`vault-tx-${BOARDING_TXID}`)).toHaveCount(0)
  await expect(page.getByTestId(`vault-tx-${COMMITMENT_TXID}`)).toContainText('Received')
})

test('recovers a missed VTXO update after reconnect and updates the rendered Home balance', async ({
  context,
  page,
}) => {
  const { status } = await openVault(page)
  await expect(page.getByTestId('vault-balance')).toContainText('0')

  const incoming = await wireVtxo(page, status, { amount: 25_000, txid: VTXO_TXID })
  await context.setOffline(true)
  await setOperatorVtxos([incoming])
  await expect(page.getByTestId('vault-balance')).toContainText('0')

  await context.setOffline(false)
  await refreshHome(page)
  await expect(page.getByTestId('vault-balance')).toContainText('25,000')
  await expect(page.getByTestId(`vault-tx-${VTXO_TXID}`)).toBeVisible()
})

test('never treats visible boarding value as spendable VTXO balance', async ({ page }) => {
  const pending: EsploraUtxo = {
    txid: BOARDING_TXID,
    vout: 0,
    value: 50_000,
    status: { confirmed: false },
  }
  const { destination, status } = await openVault(page, { boardingUtxos: [pending] })
  await setOperatorVtxos([await wireVtxo(page, status, { amount: 20_000, txid: VTXO_TXID })])
  await refreshHome(page)
  await expect(page.getByTestId('vault-balance')).toContainText('70,000')
  await expect(page.getByText(/available ·.*pending/)).toContainText('₿50,000 pending')
  await expect(page.getByTestId('spending-total')).toHaveCount(0)

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Spending capacity')).toContainText('₿20,000')
  await page.getByTestId('vault-send-amount').fill('30000')
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(destination)
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Review' })).toHaveCount(0)
})

test('validates a pasted Recovery Kit against its committed descriptor', async ({ page }) => {
  const { status } = await openVault(page)
  const validKit = await recoveryKitJson(page, status.vaultId)
  const tampered = JSON.parse(validKit) as Record<string, unknown>
  tampered.descriptorHash = '00'.repeat(32)

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await page.getByTestId('security-kit').click()
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Check a recovery package' }).click()
  await page.getByText('Paste recovery JSON', { exact: true }).click()

  const input = page.getByTestId('recovery-kit-json')
  await input.fill(JSON.stringify(tampered))
  await expect(page.getByText('Ledger Recovery Kit binding changed')).toBeVisible()

  await input.fill(validKit)
  await expect(page.getByText(`This kit is for vault ${status.vaultId.slice(0, 8)}… · 8 addresses`)).toBeVisible()
  await expect(page.getByText('Ledger Recovery Kit binding changed')).toHaveCount(0)
})

test('starts Ledger recovery from a confirmed coin and retains its pending candidate across navigation', async ({
  page,
}) => {
  const { state, status } = await openVault(page)
  const { coin, pendingAddress } = await recoveryCoin(page, status.vaultId)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await page.getByTestId('security-lost').click()
  await expect(page.getByRole('heading', { name: 'Recover Ledger Savings', exact: true })).toBeVisible()

  state.savingsUtxos = [{ ...coin, status: { confirmed: false } }]
  await page.getByRole('button', { name: 'Find confirmed outputs', exact: true }).click()
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose a confirmed Bitcoin output')
  await expect(page.getByRole('combobox', { name: 'Bitcoin output', exact: true }).locator('option')).toHaveCount(0)

  state.savingsUtxos = [coin]
  await page.getByRole('button', { name: 'Find confirmed outputs', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Bitcoin output', exact: true }).locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Approve recovery', exact: true })).toBeVisible()
  const saved = await downloadedRecovery(page)
  const review = await page.evaluate(
    async ({ value, modulePath }) => {
      const recovery = await import(/* @vite-ignore */ modulePath)
      const view = recovery.inspectLedgerRecoveryTransition(value.transition)
      return { destination: view.destinationAddress, amountSats: view.amountSats }
    },
    { value: saved, modulePath: LEDGER_RECOVERY_MODULE },
  )
  expect(review).toEqual({ destination: pendingAddress, amountSats: 99_500 })
  expect(saved.transition).toMatchObject({
    action: { kind: 'initiate', claimant: 'hardware', change: 0 },
    coin: { txid: coin.txid, vout: 0, value: 100_000 },
    feeSats: 500,
  })
  expect(saved.userPsbt).toBeUndefined()

  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'More options', exact: true }).click()
  await page.getByRole('button', { name: /I lost a key/ }).click()
  await page.getByRole('combobox', { name: 'Recovery claimant', exact: true }).selectOption('phone')
  await page.getByRole('button', { name: 'Find confirmed outputs', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Bitcoin output', exact: true }).locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Another recovery candidate for this output is still pending')
  await page.getByRole('combobox', { name: 'Resume recovery', exact: true }).selectOption('record:0')
  expect(await downloadedRecovery(page)).toEqual(saved)
  await expect(page.getByRole('button', { name: 'Save and broadcast recovery', exact: true })).toHaveCount(0)
})

test('surfaces Ledger recovery and preserves delayed claims and claimant-aware cancellation', async ({ page }) => {
  const { status } = await openVault(page)
  const { coin, address } = await recoveryCoin(page, status.vaultId, true)
  await page.route('**/esplora/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === `/esplora/address/${address}/utxo`) return json(route, [coin])
    if (url.pathname === '/esplora/blocks/tip/height') return route.fulfill({ status: 200, body: '20' })
    return route.fallback()
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const alert = page.getByTestId('initiate-alert')
  await expect(alert).toContainText('Savings recovery detected')
  await alert.click()
  await page.getByRole('combobox', { name: 'Recovery path', exact: true }).selectOption('pending-claim')
  await page.getByRole('button', { name: 'Find confirmed outputs', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Bitcoin output', exact: true }).locator('option')).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Bitcoin destination', exact: true }).fill(status.savingsAddress)
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click()
  await expect(page.getByText('This claim requires 6 blocks', { exact: false })).toBeVisible()
  const claim = await downloadedRecovery(page)
  const review = await page.evaluate(
    async ({ value, modulePath }) => {
      const recovery = await import(/* @vite-ignore */ modulePath)
      const view = recovery.validateSavingsRecovery(value)
      return { sequence: view.sequence, amount: Number(view.tx.getOutput(0).amount), signers: view.signers }
    },
    { value: claim, modulePath: SAVINGS_RECOVERY_MODULE },
  )
  expect(review).toEqual({ sequence: 6, amount: 99_500, signers: ['hardware'] })
  expect(claim.destination).toBe(status.savingsAddress)
  expect(claim.feeSats).toBe(500)

  await page.getByRole('button', { name: 'Choose another path', exact: true }).click()
  await page.getByRole('combobox', { name: 'Recovery path', exact: true }).selectOption('pending-cancel')
  await page.getByRole('button', { name: 'Find confirmed outputs', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Bitcoin output', exact: true }).locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click()
  await expect(page.getByText('Required: phone and recovery.', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Signing account', exact: true }).locator('option')).toHaveText([
    'phone',
    'recovery',
  ])
  const cancellation = await downloadedRecovery(page)
  await page.getByRole('textbox', { name: 'Signed partial PSBT', exact: true }).fill(cancellation.psbt)
  await page.getByRole('button', { name: 'Import reviewed signature', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Recovery must retain prior signatures and add the requested key')
  await expect(page.getByRole('button', { name: 'Save and broadcast recovery', exact: true })).toHaveCount(0)
})

async function expectNoBlockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }))
  expect(blocking).toEqual([])
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))
  expect(overflow).toEqual({ document: 0, body: 0 })
}

async function expectReachableAbove(page: Page, targetSelector: string, chromeSelector: string) {
  const target = page.locator(targetSelector)
  await target.scrollIntoViewIfNeeded()
  let targetBox = await target.boundingBox()
  let chromeBox = await page.locator(chromeSelector).boundingBox()
  expect(targetBox).not.toBeNull()
  expect(chromeBox).not.toBeNull()
  const overlap = targetBox!.y + targetBox!.height - chromeBox!.y
  if (overlap > 0) {
    await page.locator('.qg-main').evaluate((content, amount) => content.scrollBy(0, amount + 16), overlap)
    targetBox = await target.boundingBox()
    chromeBox = await page.locator(chromeSelector).boundingBox()
  }
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(chromeBox!.y)
}

test('@polish keeps installed-PWA safe areas inside the wallet canvas', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'Mobile Chrome', 'Mobile shell regression')
  await openVault(page)

  const app = page.getByTestId('vault-app')
  await app.evaluate((element) => {
    element.style.setProperty('--vault-safe-area-top', '47px')
    element.style.setProperty('--vault-safe-area-bottom', '34px')
  })

  const viewport = page.viewportSize()
  const frame = await app.boundingBox()
  const accountBar = await page.locator('.vault-account-bar').boundingBox()
  const navigationTrigger = await page.getByRole('button', { name: 'Open navigation' }).boundingBox()
  const statusBarOverlay = await page.evaluate(() => getComputedStyle(document.body, '::before').display)

  expect(viewport).not.toBeNull()
  expect(frame).not.toBeNull()
  expect(accountBar).not.toBeNull()
  expect(navigationTrigger).not.toBeNull()
  expect(frame!.y).toBe(0)
  expect(frame!.height).toBe(viewport!.height)
  expect(accountBar!.y).toBeGreaterThanOrEqual(47)
  expect(navigationTrigger!.y).toBeGreaterThan((viewport!.height || 0) / 2)
  expect(navigationTrigger!.y + navigationTrigger!.height).toBeLessThanOrEqual(viewport!.height)
  expect(navigationTrigger!.x + navigationTrigger!.width).toBeGreaterThanOrEqual((viewport!.width || 0) - 1)
  expect(navigationTrigger!.width).toBeLessThan(navigationTrigger!.height)
  expect(statusBarOverlay).toBe('none')
  await expectNoHorizontalOverflow(page)
})

test('@polish keeps a focused send address between the safe header and footer when the keyboard opens', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'Mobile Chrome', 'Mobile keyboard regression')
  const { status } = await openVault(page)
  await setOperatorVtxos([await wireVtxo(page, status, { amount: 20_000, txid: VTXO_TXID })])
  await dispatchUtxoUpdate(page, status.vaultId)
  await expect(page.getByTestId('vault-balance')).toContainText('20,000')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const destination = page.getByPlaceholder('Payment address or Lightning invoice')
  await destination.focus()
  await page.setViewportSize({ width: 390, height: 500 })
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))

  await expect
    .poll(async () => {
      const header = await page.locator('.qg-header').boundingBox()
      const field = await page.locator('.qg-dest-field').boundingBox()
      const footer = await page.locator('.qg-footer').boundingBox()
      return {
        headerTop: Math.round(header?.y ?? -1),
        fieldBottom: Math.round((field?.y ?? 0) + (field?.height ?? 0)),
        footerTop: Math.round(footer?.y ?? 0),
      }
    })
    .toMatchObject({ headerTop: 0 })

  const field = await page.locator('.qg-dest-field').boundingBox()
  const footer = await page.locator('.qg-footer').boundingBox()
  expect(field).not.toBeNull()
  expect(footer).not.toBeNull()
  expect(field!.y + field!.height).toBeLessThanOrEqual(footer!.y)
})

test('@polish covers accessible account, send, Security, and Settings states', async ({ page }, testInfo) => {
  const pending: EsploraUtxo = {
    txid: BOARDING_TXID,
    vout: 0,
    value: 48_000,
    status: { confirmed: false },
  }
  const { destination, state, status } = await openVault(
    page,
    { boardingUtxos: [pending] },
    { savingsDepositSats: 100_000 },
  )
  await setOperatorVtxos([
    await wireVtxo(page, status, {
      amount: 80_000,
      txid: VTXO_TXID,
      createdAt: Date.UTC(2026, 7, 20, 10, 0, 0),
    }),
  ])
  await refreshHome(page)

  await expect(page.getByTestId('vault-balance')).toContainText('128,000')
  await expect(page.getByText(/available ·.*pending/)).toContainText('₿48,000 pending')
  await expect(page.getByTestId('spending-total')).toHaveCount(0)
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('home-with-pending.png', { animations: 'disabled', fullPage: true })
  const homeViewport = page.viewportSize()
  for (const width of [320, 430, 768] as const) {
    await page.setViewportSize({ width, height: homeViewport?.height || 844 })
    await expectNoHorizontalOverflow(page)
    const balance = await page.getByTestId('vault-balance').boundingBox()
    const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
    const receive = await page.getByRole('button', { name: 'Receive', exact: true }).boundingBox()
    expect(balance).not.toBeNull()
    expect(send).not.toBeNull()
    expect(receive).not.toBeNull()
    expect(balance!.x + balance!.width).toBeLessThanOrEqual(width)
    expect(send!.x + send!.width).toBeLessThanOrEqual(receive!.x + 1)
  }
  await page.setViewportSize(homeViewport || { width: 390, height: 844 })

  const accountTrigger = page.getByTestId('account-switcher')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expect(page.getByTestId('account-spend')).toBeVisible()
  await expect(page.getByTestId('account-savings')).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('home-account-menu.png', { animations: 'disabled', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()

  await page.getByTestId('account-scan').click()
  await expect(page.getByRole('heading', { name: 'Scan payment' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('payment-scanner.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Send' })).toHaveCount(0)

  await page.getByTestId('account-receive').click()
  await expect(page.getByRole('heading', { name: 'Receive' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('receive-spending.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByTestId('account-spend')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('account-savings').click()
  await expect(accountTrigger).toContainText('Savings')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByTestId('account-savings')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('account-spend').click()
  await expect(accountTrigger).toContainText('Spending')

  await seedReviewedSpend(page, status, destination, 12_000, 500, 67_500)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('send-spending.png', { animations: 'disabled', fullPage: true })
  await page.getByTestId('vault-send-amount').fill('12000')
  await page.getByPlaceholder('Payment address or Lightning invoice').fill(destination)
  await page.getByRole('button', { name: 'Resume payment' }).click()
  await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
  await expect(page.getByText('Mutinynet', { exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('send-review.png', { animations: 'disabled', fullPage: true })
  await expectReachableAbove(page, '.qg-approval-copy', '.qg-footer')

  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0)
  await expect(page.getByTestId('security-readiness')).toContainText(/scheduled|Unavailable|Needs attention/)
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('security.png', { animations: 'disabled', fullPage: true })
  await expect(page.getByTestId('security-lost')).toBeVisible()

  await page.getByTestId('security-kit').click()
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  // Archive capture is asynchronous and independent of this navigation tour.
  // Its failure/retained-copy states are tested in Recover and useRecoveryArchive.
  await expect(page.getByRole('button', { name: 'Save recovery package', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More options', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Wallet details/ })).toBeVisible()
  await page.getByText('Saved copies', { exact: true }).click()
  await expect(page.getByText('Last file check', { exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await page.screenshot({ path: testInfo.outputPath('recovery-copies.png'), fullPage: true })
  await page.getByText('Saved copies', { exact: true }).click()
  await page.getByRole('button', { name: /I lost a key/ }).click()
  await expect(page.getByRole('heading', { name: 'Recover Ledger Savings', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('recovery-lost-key.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-settings').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings.png', { animations: 'disabled', fullPage: true })

  await page.getByTestId('settings-theme').click()
  await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-theme.png', { animations: 'disabled', fullPage: true })
  await page.getByTestId('select-option-1').click()
  await expect(page.locator('html')).toHaveClass(/palette-dark/)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-theme-dark.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-dark.png', { animations: 'disabled', fullPage: true })

  await page.getByTestId('settings-theme').click()
  await page.getByTestId('select-option-2').click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByTestId('settings-haptics').click()
  await expect(page.getByRole('heading', { name: 'Haptics' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-haptics.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByTestId('settings-about').click()
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-about.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: /Diagnostics/ }).click()
  await page.getByTestId('settings-logs').click()
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-logs.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByTestId('settings-signout').click()
  await expect(page.getByRole('heading', { name: 'Sign out', exact: true })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('settings-signout.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Go back' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()

  await page.getByRole('button', { name: /Received ₿80,000/ }).click()
  await expect(page.getByRole('heading', { name: 'Transaction' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expect(page.getByRole('img', { name: 'Received status' })).toHaveClass(/lucide-circle-check/)
  await page.getByText('View transaction', { exact: true }).click()
  await expect(page.getByText(VTXO_TXID, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View on Arkade Space' })).toHaveAttribute(
    'href',
    `https://explorer.mutinynet.arkade.sh/tx/${VTXO_TXID}`,
  )
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('transaction-received.png', { animations: 'disabled', fullPage: true })
  const originalViewport = page.viewportSize()!
  await page.setViewportSize({ width: 320, height: 740 })
  const reference = page.locator('details[aria-label="Transaction reference"]')
  await expect(reference.locator('code')).toBeVisible()
  expect(await reference.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.setViewportSize(originalViewport)
  await page.getByRole('button', { name: 'Go back' }).click()

  await setEsploraState(status, state)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  await expect(page.getByTestId('account-switcher')).toContainText('Savings')
  await refreshHome(page)
  await expect(page.getByTestId('vault-balance')).toContainText('100,000')
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('home-savings.png', { animations: 'disabled', fullPage: true })
  await page.getByTestId('account-receive').click()
  await expect(page.getByRole('heading', { name: 'Receive' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('receive-savings.png', { animations: 'disabled', fullPage: true })
  await page.getByRole('button', { name: 'Go back' }).click()
  await page.getByRole('button', { name: 'Transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer' })).toBeVisible()
  await expectNoBlockingAxeViolations(page)
  await expectWalletLayout(page)
  await expect(page).toHaveScreenshot('send-savings.png', { animations: 'disabled', fullPage: true })

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width >= 900 ? 1000 : 844 })
    await expectNoHorizontalOverflow(page)
  }
  const frame = await page.getByTestId('vault-app').boundingBox()
  expect(frame?.width).toBe(720)
  expect(frame?.x).toBe(360)
  expect(frame?.y).toBe(24)
})

// Motion remains enabled here so touch and transition regressions are exercised together.
test.describe('interaction quality', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } })

  test('@interaction native taps, header gestures and menu browsing', async ({ page, browserName }, testInfo) => {
    const { status } = await openVault(page)
    await setOperatorVtxos([await wireVtxo(page, status, { amount: 80_000, txid: VTXO_TXID })])
    await refreshHome(page)
    await expect(page.getByTestId('vault-balance')).toContainText('80,000')
    const open = page.getByRole('button', { name: 'Open navigation' })
    await open.click()
    await expect(page.getByTestId('account-spend')).toBeFocused()
    await expect(page.getByTestId('account-spend')).toHaveCSS('outline-style', 'none')
    await expect(page.getByTestId('account-spend')).toHaveCSS('box-shadow', 'none')
    await expect(page.locator('.content')).toHaveAttribute('inert', '')
    const shell = await page.getByTestId('vault-app').boundingBox()
    const backdrop = await page.locator('.qg-launcher-backdrop').boundingBox()
    expect(Math.abs(shell!.width - backdrop!.width)).toBeLessThanOrEqual(2)
    await page.screenshot({ path: testInfo.outputPath('navigation.png'), animations: 'disabled' })
    for (let index = 0; index < 5; index++) {
      // Mobile WebKit follows the platform's text-only Tab preference.
      if (browserName === 'webkit') await page.locator('.qg-launcher-stack button').nth(index).focus()
      else await page.keyboard.press('Tab')
      await expect(page.locator('.qg-launcher :focus')).toHaveCSS('outline-style', 'none')
      const focusedItem = page.locator('.qg-launcher-item:focus')
      if (await focusedItem.count()) await expect(focusedItem).toHaveCSS('box-shadow', 'none')
    }
    await page.getByTestId('tab-vault').click()
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible()
    await page.getByTestId('header-back').click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
    await page.getByTestId('vault-send-amount').fill('12000')
    await expect(page.getByTestId('vault-send-amount')).toHaveCSS('outline-style', 'none')
    await expect(page.getByTestId('vault-send-amount')).toHaveCSS('box-shadow', 'none')
    await page.screenshot({ path: testInfo.outputPath('send.png'), animations: 'disabled' })

    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page)
      const swipe = async (x: number, y: number, dx: number, dy: number, cancel = false) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        for (let step = 1; step <= 6; step++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + (dx * step) / 6, y: y + (dy * step) / 6 }],
          })
        }
        await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
      }
      const amount = (await page.getByTestId('vault-send-amount').boundingBox())!
      await swipe(amount.x + 40, amount.y + 15, 0, 125)
      await expect(page.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
      await page.getByTestId('vault-send-amount').blur()
      const heading = (await page.getByTestId('screen-title').boundingBox())!
      await swipe(heading.x + heading.width / 2, heading.y + 5, 0, 120, true)
      await expect(page.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
      await swipe(heading.x + heading.width / 2, heading.y + 5, 0, 120)
      await expect(open).toBeVisible()
      const tab = (await open.boundingBox())!
      await swipe(tab.x + 20, tab.y + 25, -80, 0, true)
      await expect(page.getByRole('navigation')).toHaveCount(0)
      await swipe(tab.x + 20, tab.y + 25, 0, -70)
      await expect(page.getByRole('navigation')).toHaveCount(0)
      await cdp.detach()
    } else {
      await page.getByTestId('header-back').click()
    }
    await open.click()
    await page.getByTestId('tab-settings').click()
    await page.getByTestId('settings-theme').click()
    await page.getByTestId('select-option-1').click()
    await page.getByTestId('header-back').click()
    await page.getByTestId('header-back').click()
    await page.getByTestId('account-receive').click()
    await expect(page.getByRole('heading', { name: 'Receive', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('receive-dark.png'), animations: 'disabled' })
  })
  test('@interaction address field accepts taps across its full surface', async ({ page, isMobile }, testInfo) => {
    const { status } = await openVault(page)
    await setOperatorVtxos([await wireVtxo(page, status, { amount: 80_000, txid: VTXO_TXID })])
    await refreshHome(page)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'To', exact: true })
    const surface = page.locator('.qg-dest-field > div')
    await expect(input).toBeVisible()
    const restingBorder = await surface.evaluate((element) => getComputedStyle(element).borderColor)
    const hits = await surface.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [5, box.height / 2, box.height - 5].map(
        (y) => document.elementFromPoint(box.left + 24, box.top + y)?.tagName,
      )
    })
    expect(hits).toEqual(['INPUT', 'INPUT', 'INPUT'])
    for (const fraction of [0.1, 0.5, 0.9]) {
      await page.getByTestId('screen-title').click()
      const box = (await surface.boundingBox())!
      if (isMobile) await page.touchscreen.tap(box.x + 24, box.y + box.height * fraction)
      else await page.mouse.click(box.x + 24, box.y + box.height * fraction)
      await expect(input).toBeFocused()
    }
    await input.fill('example destination')
    await input.dblclick()
    expect(
      await input.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!),
    ).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Scan destination', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Scan payment', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^(Cancel|Enter manually)$/ }).click()
    await expect(input).toHaveValue('example destination')
    await input.focus()
    await expect(input).toHaveCSS('outline-style', 'none')
    await expect(input).toHaveCSS('box-shadow', 'none')
    await expect(surface).toHaveCSS('box-shadow', 'none')
    await expect(surface).toHaveCSS('border-color', restingBorder)
    await page.screenshot({ path: testInfo.outputPath('address-focus.png'), animations: 'disabled' })
  })
  test('@interaction launcher follows the grab point and remembers placement', async ({
    page,
    browserName,
  }, testInfo) => {
    await openVault(page)
    const tab = page.getByRole('button', { name: 'Open navigation' })
    const start = (await tab.boundingBox())!
    expect(start.width).toBeGreaterThanOrEqual(44)
    const x = start.x + 8
    const y = start.y + 10
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 3, y - 16)
    await page.mouse.move(x - 120, y - 180, { steps: 12 })
    await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(start.y - 180, 0)
    expect((await tab.boundingBox())!.x).toBeCloseTo(start.x, 0)
    await page.mouse.up()
    await expect(tab).not.toHaveClass(/is-coasting/)
    await expect(page.getByRole('navigation')).toHaveCount(0)
    const placed = (await tab.boundingBox())!
    await page.reload()
    await expect(tab).toBeVisible()
    await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(placed.y, 0)

    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page)
      const box = (await tab.boundingBox())!
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + 20, y: box.y + 12 }],
      })
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: box.x + 20 - step * 2, y: box.y + 12 + step * 8 }],
        })
      }
      await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(box.y + 80, 0)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(box.y, 0)
      await expect(page.getByRole('navigation')).toHaveCount(0)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + 20, y: box.y + 12 }],
      })
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: box.x + 20, y: box.y + 12 + step * 8 }],
        })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(tab).not.toHaveClass(/is-coasting/)
      const touchPlaced = (await tab.boundingBox())!.y
      expect(touchPlaced).toBeGreaterThanOrEqual(box.y + 79.5)
      await expect(page.getByRole('navigation')).toHaveCount(0)
      await cdp.detach()
      await page.reload()
      await expect(tab).toBeVisible()
      await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(touchPlaced, 0)
    }

    // Place at the upper edge and verify that the complete menu stays in the wallet frame.
    const current = (await tab.boundingBox())!
    await page.mouse.move(current.x + 12, current.y + 12)
    await page.mouse.down()
    await page.mouse.move(current.x + 12, 0, { steps: 12 })
    await page.mouse.up()
    await tab.click()
    const menu = page.getByRole('navigation')
    const frame = (await page.getByTestId('vault-app').boundingBox())!
    const menuBox = (await menu.boundingBox())!
    expect(menuBox.y).toBeGreaterThanOrEqual(frame.y)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(frame.y + frame.height)
    await page.screenshot({ path: testInfo.outputPath('launcher-upper.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(tab).toBeVisible()
    await page.setViewportSize({ width: 390, height: 520 })
    const resizedFrame = (await page.getByTestId('vault-app').boundingBox())!
    await expect.poll(async () => (await tab.boundingBox())!.y).toBeGreaterThanOrEqual(resizedFrame.y)
    const resizedTab = (await tab.boundingBox())!
    expect(resizedTab.y + resizedTab.height).toBeLessThanOrEqual(resizedFrame.y + resizedFrame.height)
  })
})

for (const theme of ['light', 'dark'] as const) {
  test(`@visual-refinement ${theme} layout keeps amounts, fields and surfaces within the wallet`, async ({
    page,
  }, testInfo) => {
    const { status, destination } = await openVault(page)
    await setOperatorVtxos([await wireVtxo(page, status, { amount: 100_000_000, txid: VTXO_TXID })])
    await refreshHome(page)
    await expect(page.getByTestId('vault-balance')).toContainText('100,000,000')
    await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' })
    }
    const contained = async (selector: string) => {
      const boxes = await page.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          const shell = node.closest('[data-testid="vault-app"]')!.getBoundingClientRect()
          return {
            left: rect.left - shell.left,
            right: shell.right - rect.right,
            scroll: node.scrollWidth - node.clientWidth,
          }
        }),
      )
      expect(boxes.length).toBeGreaterThan(0)
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(-1)
        expect(box.right).toBeGreaterThanOrEqual(-1)
        expect(box.scroll).toBeLessThanOrEqual(1)
      }
    }
    await contained('.qg-balance strong, .vault-history-amt')
    await expect(page.locator('.vault-history-amt')).toHaveCSS('white-space', 'nowrap')
    await capture('home-long-balance')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByTestId('vault-send-amount').fill('100000000')
    await page.getByTestId('vault-send-amount').blur()
    await expect(page.locator('.qg-available')).toHaveCSS('border-top-width', '0px')
    await contained('.qg-dest-field, .qg-amount-entry')
    const amount = page.getByTestId('vault-send-amount')
    expect(await amount.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await capture('send-long-amount')
    await page.getByTestId('vault-send-amount').fill('12000')
    await page.getByRole('textbox', { name: 'To', exact: true }).fill(destination)
    await seedReviewedSpend(page, status, destination, 12_000, 500, 99_987_500)
    await page.getByTestId('vault-send-amount').blur()
    const gutter = (page.viewportSize()?.width || 390) < 360 ? '20px' : '24px'
    await expect(page.locator('.qg-main')).toHaveCSS('padding-left', gutter)
    await expect(page.locator('.qg-footer')).toHaveCSS('padding-left', gutter)
    await capture('send')
    await page.getByRole('button', { name: /Resume payment|Review payment/ }).click()
    await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
    await contained('.qg-review-amount strong, .qg-details')
    await capture('review')
    await page.locator('.qg-approval-copy').last().scrollIntoViewIfNeeded()
    const approval = await page.locator('.qg-approval-copy').last().boundingBox()
    const footer = await page.locator('.qg-footer').boundingBox()
    expect(approval!.y + approval!.height).toBeLessThanOrEqual(footer!.y + 1)
    await page.getByRole('button', { name: 'Go back' }).click()
    await page.getByRole('button', { name: 'Go back' }).click()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByTestId('tab-vault').click()
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible()
    await expect(page.getByTestId('security-grid').getByRole('button')).toHaveCount(4)
    await expect(page.getByTestId('security-lost')).toBeVisible()
    await contained('[data-testid="security-overview"]')
    await capture('security')
    await page.getByRole('button', { name: 'Go back' }).click()
    await page.getByTestId('account-receive').click()
    await expect(page.locator('.vault-receive-qr-large svg')).toBeVisible()
    await capture('receive')
  })

  test(`@visual-refinement ${theme} welcome and protection remain readable`, async ({ page }, testInfo) => {
    await mockEnrollmentAccess(page)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()
    await page.evaluate((dark) => document.documentElement.classList.toggle('palette-dark', dark), theme === 'dark')
    await page.screenshot({ path: testInfo.outputPath('welcome.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Get started' }).click()
    for (const protection of ['Standard', 'Advanced']) {
      await page.getByRole('button', { name: new RegExp(`^${protection}`) }).click()
      await expect(page.getByRole('heading', { name: 'Protect Savings with Ledger' })).toBeVisible()
      await expect(page.getByRole('textbox')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Connect Ledger' })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`ledger-${protection.toLowerCase()}.png`),
        animations: 'disabled',
      })
      await page.getByRole('button', { name: 'Go back', exact: true }).click()
    }
  })
}

test('@interaction launcher momentum glides, can be caught, and remembers its resting position', async ({
  page,
  browserName,
}) => {
  await page.clock.install()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openVault(page)
  // Control gesture and coast time so native pointer dispatch cannot miss the glide.
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const tab = page.getByRole('button', { name: 'Open navigation' })
  const start = (await tab.boundingBox())!
  const x = start.x + 20
  const y = start.y + 20
  // Native touch input in Chromium; WebKit uses its native mouse pointer stream.
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  const gestureTime = Date.now() / 1000
  if (cdp)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: gestureTime, touchPoints: [{ x, y }] })
  else {
    await page.mouse.move(x, y)
    await page.mouse.down()
  }
  for (let step = 1; step <= 5; step++) {
    await page.clock.runFor(20)
    if (cdp)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        timestamp: gestureTime + step * 0.02,
        touchPoints: [{ x, y: y - step * 24 }],
      })
    else await page.mouse.move(x, y - step * 24)
  }
  await page.clock.runFor(20)
  const released = (await tab.boundingBox())!.y
  if (cdp)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: gestureTime + 0.12, touchPoints: [] })
  else await page.mouse.up()
  await expect(tab).toHaveClass(/is-coasting/)
  await page.clock.runFor(32)
  await expect.poll(async () => (await tab.boundingBox())!.y).toBeLessThan(released - 12)
  await expect(page.getByRole('navigation')).toHaveCount(0)

  // Catch with a real pointer without turning the catch into a menu activation.
  const moving = (await tab.boundingBox())!
  await page.mouse.move(moving.x + 20, moving.y + 20)
  await page.mouse.down()
  await expect(tab).not.toHaveClass(/is-coasting/)
  const caught = (await tab.boundingBox())!.y
  await page.mouse.up()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await page.clock.runFor(100)
  expect((await tab.boundingBox())!.y).toBeCloseTo(caught, 0)
  await page.clock.resume()
  await cdp?.detach()
  await page.reload()
  await expect(tab).toBeVisible()
  await expect.poll(async () => (await tab.boundingBox())!.y).toBeCloseTo(caught, 0)
  await tab.click()
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('@interaction Home camera returns to its originating account on cancel and close', async ({ page }) => {
  await openVault(page)
  for (const account of ['savings', 'spend'] as const) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByTestId(`account-${account}`).click()
    const accountName = account === 'savings' ? 'Savings' : 'Spending'
    await expect(page.getByTestId('account-switcher')).toHaveText(accountName)
    for (const action of ['Cancel', 'Go back']) {
      await page.getByTestId('account-scan').click()
      await expect(
        page.getByRole('heading', {
          name: account === 'savings' ? 'Scan Bitcoin address' : 'Scan payment',
          exact: true,
        }),
      ).toBeVisible()
      const cancel = page.getByRole('button', { name: action, exact: true })
      if (await cancel.isVisible()) await cancel.click()
      else await page.getByRole('button', { name: 'Go back', exact: true }).click()
      await expect(page.getByTestId('account-switcher')).toHaveText(accountName)
      await expect(page.locator('.qg-camera')).toHaveCount(0)
    }
  }
})

// Both production modes receive identical presentation data. This catches wrapper/CSS
// drift as well as missing controls; independent screenshots cannot establish parity.
for (const state of ['empty', 'funded', 'pending', 'long'] as const) {
  test(`@polish Spending home has identical Standard and Light layout: ${state}`, async ({
    page,
    context,
  }, testInfo) => {
    const balance = state === 'empty' ? 0 : 27459
    const pendingBalance = state === 'pending' ? 2000 : 0
    const history =
      state === 'empty'
        ? []
        : Array.from({ length: state === 'long' ? 12 : 2 }, (_, i) => ({
            account: 'spend',
            txid: i.toString(16).padStart(64, '0'),
            amount: i % 2 ? 32475 : 5000,
            type: i % 2 ? 'received' : 'sent',
            confirmed: true,
            blockTime: 1788739200 - (state === 'long' && i >= 10 ? 86400 : 0),
          }))
    await mockVaultBalances(page, { balance, pendingBalance, history })
    await openVault(page)
    const light = await context.newPage()
    await light.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] })
    })
    await openLight(light, false, false, { balance, pendingBalance, history })
    for (const width of testInfo.project.name.includes('Desktop') ? [1440] : [320, 375]) {
      for (const theme of ['light', 'dark']) {
        for (const target of [page, light]) {
          await target.setViewportSize({ width, height: width === 1440 ? 1000 : 667 })
          await target.evaluate((theme) => {
            document.documentElement.classList.toggle('palette-dark', theme === 'dark')
            document.documentElement.classList.toggle('palette-light', theme === 'light')
          }, theme)
          await expectWalletLayout(target)
          const rows = await target.locator('.vault-history-row').evaluateAll((elements) =>
            elements.map((element) => {
              const { top, bottom, height } = element.getBoundingClientRect()
              return { top, bottom, height }
            }),
          )
          for (let i = 1; i < rows.length; i++) {
            expect(rows[i].height, 'Ordinary two-line transactions have equal height').toBeCloseTo(rows[0].height, 1)
            expect(rows[i].top - rows[i - 1].bottom, 'No extra space at a hidden date boundary').toBeCloseTo(0, 1)
          }
          await expect(target.getByTestId('account-scan')).toBeVisible()
          await expect(target.locator('.qg-actions')).toBeInViewport({ ratio: 1 })
          await expect(target.getByTestId('account-receive')).toBeVisible()
          expect(await target.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(!balance)
        }
        const layout = (target: Page) =>
          target.locator('.qg-home').evaluate((home) => {
            const app = document.querySelector('[data-testid="vault-app"]')!.getBoundingClientRect()
            return [
              home,
              ...home.querySelectorAll(
                'header, .qg-account, .qg-utilities, .qg-utilities button, .qg-balance, .qg-available, .qg-actions, .qg-actions button, .vault-history, .vault-history-row, .vault-history-amt',
              ),
            ].map((el) => {
              const r = el.getBoundingClientRect(),
                s = getComputedStyle(el)
              return {
                className: el.className,
                x: r.x - app.x,
                y: r.y - app.y,
                width: r.width,
                height: r.height,
                font: s.font,
                color: s.color,
                background: s.backgroundColor,
                padding: s.padding,
                margin: s.margin,
                gap: s.gap,
              }
            })
          })
        expect(await layout(light)).toEqual(await layout(page))
        for (const target of [page, light]) {
          await expect(target.getByTestId('vault-app')).toHaveScreenshot(`home-parity-${state}-${width}-${theme}.png`, {
            animations: 'disabled',
          })
          const actions = await target.locator('.qg-actions').boundingBox()
          // Activity uses the full content width beneath the movable glass tab.
          for (const row of await target.locator('.vault-history-row').all()) {
            const box = await row.boundingBox()
            expect(box!.x + box!.width).toBeCloseTo(actions!.x + actions!.width, 0)
          }
        }
        // Capture the visible wallet frame, so long history does not resize the
        // viewport and move the floating navigation during screenshot capture.
        await expect
          .poll(
            async () => {
              // Nested GPU layers can antialias the outer rounded corners differently
              // on Linux. Normal baselines above cover that frame; compare the content
              // exactly without changing layout or masking any controls.
              const capture = {
                animations: 'disabled' as const,
                style: '[data-testid="vault-app"] { border-radius: 0 !important; }',
              }
              const standardPixels = await page.getByTestId('vault-app').screenshot(capture)
              const lightPixels = await light.getByTestId('vault-app').screenshot(capture)
              const equal = lightPixels.equals(standardPixels)
              if (!equal) {
                await writeFile(testInfo.outputPath('standard-parity.png'), standardPixels)
                await writeFile(testInfo.outputPath('light-parity.png'), lightPixels)
              }
              return equal
            },
            { message: 'Standard and Light Home pixels must match' },
          )
          .toBe(true)
      }
    }
    await light.getByTestId('account-scan').click()
    await expect(light.getByRole('button', { name: 'Enter manually' })).toBeVisible()
    await light.close()
  })
}

for (const mode of ['standard', 'light'] as const) {
  test(`@polish visual Security overview stays contained: ${mode}`, async ({ page }, testInfo) => {
    if (mode === 'standard') await openVault(page)
    else await openLight(page)
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByTestId('tab-vault').click()
    const overview = page.getByTestId('security-overview')
    await expect(overview).toBeVisible()
    const tiles = page.getByTestId('security-grid').getByRole('button')
    await expect(tiles).toHaveCount(4)
    for (const width of testInfo.project.name.includes('Desktop') ? [1440] : [375, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 667 })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle('palette-dark', theme === 'dark')
          document.documentElement.classList.toggle('palette-light', theme === 'light')
        }, theme)
        await page
          .getByTestId('vault-app')
          .screenshot({ path: testInfo.outputPath(`security-${mode}-${width}-${theme}.png`), animations: 'disabled' })
        await expectWalletLayout(page, true)
        for (const tile of await tiles.all()) await expect(tile).toBeInViewport({ ratio: 1 })
        const boxes = await tiles.evaluateAll((elements) =>
          elements.map((el) => {
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }),
        )
        expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0)
        expect(boxes[2].y).toBeCloseTo(boxes[3].y, 0)
        expect(boxes[0].x).toBeCloseTo(boxes[2].x, 0)
        expect(boxes[2].y).toBeGreaterThan(boxes[0].y)
        for (const box of boxes) {
          expect(box.width).toBeCloseTo(boxes[0].width, 0)
          expect(box.height).toBeCloseTo(boxes[0].height, 0)
          expect(box.height).toBeGreaterThanOrEqual(44)
        }
        await expectNoBlockingAxeViolations(page)
        await expect(page.getByTestId('vault-app')).toHaveScreenshot(
          `security-overview-${mode}-${width}-${theme}.png`,
          { animations: 'disabled' },
        )
      }
    }
    for (const [label, heading] of [
      ['Keys and access', 'Keys and access'],
      ['Spending limits', 'Spending limits'],
      ['Renewal', 'Automatic renewal'],
    ]) {
      await tiles.filter({ hasText: label }).click()
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Go back', exact: true }).click()
      await expect(overview).toBeVisible()
    }
    await page.setViewportSize({ width: 320, height: 667 })
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px'
    })
    await expectWalletLayout(page)
    for (const tile of await tiles.all()) {
      await expect(tile).toBeVisible()
      expect(
        await tile.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1),
      ).toBe(true)
    }
  })
}

test('@polish recovery help keeps guidance readable in both themes', async ({ page }) => {
  await openVault(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await page.getByRole('button', { name: 'Access and recovery help', exact: true }).click()
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: theme === 'light' ? 320 : 390, height: 844 })
    await page.evaluate((value) => {
      document.documentElement.classList.toggle('palette-dark', value === 'dark')
    }, theme)
    for (const scenario of [
      'I can’t use my passkey',
      'I can’t use my hardware wallet',
      'Both keys are unavailable',
      'The service is unavailable',
    ]) {
      await page.getByRole('radio', { name: scenario, exact: true }).click()
      for (const summary of await page.locator('.qg-guidance > summary').all()) await summary.click()
      await expectWalletLayout(page)
      const clearances = await page
        .locator('.qg-guidance-body')
        .evaluateAll((bodies) =>
          bodies.map(
            (body) => body.getBoundingClientRect().bottom - body.lastElementChild!.getBoundingClientRect().bottom,
          ),
        )
      for (const clearance of clearances) expect(clearance).toBeGreaterThanOrEqual(15)
      await expect(page.getByRole('button', { name: 'Review recovery preparation', exact: true })).toHaveCount(0)
      await page
        .getByRole('dialog', { name: 'Wallet help' })
        .getByRole('button', { name: 'Go back', exact: true })
        .click()
    }
  }
})

test('@polish Ledger recovery paths keep controls reachable with enlarged text', async ({ page }, testInfo) => {
  await openVault(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('tab-vault').click()
  await page.getByTestId('security-lost').click()

  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: theme === 'light' ? 320 : 390, height: 844 })
    await page.evaluate((value) => {
      document.documentElement.classList.toggle('palette-dark', value === 'dark')
    }, theme)
    for (const path of ['initiate', 'clawback', 'pending-claim', 'pending-cancel', 'quarantine', 'savings-admin']) {
      await page.getByRole('combobox', { name: 'Recovery path', exact: true }).selectOption(path)
      for (const fontSize of ['16px', '32px']) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size
        }, fontSize)
        await expectWalletLayout(page)
        for (const control of await page
          .locator('.ledger-recovery-form input, .ledger-recovery-form select, .ledger-recovery-form button')
          .all()) {
          await control.scrollIntoViewIfNeeded()
          await expect(control).toBeInViewport({ ratio: 1 })
          const bounds = await control.boundingBox()
          expect(bounds!.height).toBeGreaterThanOrEqual(44)
        }
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = ''
      })
      await expectNoBlockingAxeViolations(page)
    }
    await page.locator('.qg-main').evaluate((main) => {
      main.scrollTop = 0
    })
    await page.screenshot({ path: testInfo.outputPath(`ledger-recovery-${theme}.png`), fullPage: true })
  }
})

test('@polish Bitcoin payment review and pending status show exact outputs', async ({ page }, testInfo) => {
  await page.route('**/src/screens/Vault/Home.tsx*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: "export { default } from '/src/test/e2e-vault/fixtures/bitcoin-payment-ui.tsx'",
    }),
  )
  test.setTimeout(180000)
  page.setDefaultNavigationTimeout(90000)
  await openVault(page, {}, { readySelector: '.qg-review-amount', waitForBalance: false })
  await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm Bitcoin payment' })).toBeVisible()
  await expect(page.locator('.qg-review-amount')).toContainText('1,500')
  await expect(page.getByRole('button', { name: 'Edit amount' })).toHaveCount(0)
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-review.png'), fullPage: true })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bitcoin-payment-view', { detail: 2 })))
  await expect(page.locator('.qg-review-amount')).toContainText('1,000')
  await expect(page.getByText('2 separate Bitcoin outputs: 500 sats + 500 sats.')).toBeVisible()
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('signer-review.png'), fullPage: true })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bitcoin-payment-view', { detail: 3 })))
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible()
  await expect(page.getByText('Bitcoin payment from Spending')).toHaveCount(0)
  await expect(page.getByText(/available ·.*pending/)).toHaveCount(0)
  const payment = page.getByRole('button', { name: /Bitcoin payment ₿1,400.*Sent · Awaiting confirmation/ })
  await expect(payment).toBeVisible()
  await expect(page.getByTestId('vault-balance')).toContainText('25,859')
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-history.png'), fullPage: true })
  await payment.click()
  await expect(page.getByRole('heading', { name: 'Bitcoin payment' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Bitcoin payment outputs' })).toBeVisible()
  await expect(page.getByText('Output 1 · ₿500')).toBeVisible()
  await expect(page.getByText('Output 2 · ₿500')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check payment status' })).toBeVisible()
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-details.png'), fullPage: true })
})

test('@polish Bitcoin eligibility notice keeps diagnostics collapsed and preserves pending history when dismissed', async ({
  page,
}, testInfo) => {
  await page.route('**/src/screens/Vault/Home.tsx*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: "export { default } from '/src/test/e2e-vault/fixtures/bitcoin-payment-ui.tsx'",
    }),
  )
  test.setTimeout(180000)
  page.setDefaultNavigationTimeout(90000)
  await openVault(page, {}, { readySelector: '.qg-review-amount', waitForBalance: false })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bitcoin-payment-view', { detail: 5 })))
  await expect(page.locator('.qg-payment-notice[role=status]')).toContainText('Expected availability')
  await expect(page.locator('.qg-payment-notice')).toContainText('Nothing was sent or queued')
  await expect(page.getByRole('button', { name: /Bitcoin payment ₿1,400.*Sent · Awaiting confirmation/ })).toHaveCount(
    0,
  )
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(page.locator('.qg-payment-notice pre')).not.toBeVisible()
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-eligibility.png'), fullPage: true })
  await page.getByText('Technical details', { exact: true }).click()
  await expect(page.locator('.qg-payment-notice pre')).toContainText('INVALID_PSBT_INPUT')
  await page.setViewportSize({ width: 320, height: 800 })
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-details-narrow.png'), fullPage: true })
  await page.evaluate(() => document.documentElement.classList.add('palette-dark'))
  await expectWalletLayout(page)
  await page.screenshot({ path: testInfo.outputPath('bitcoin-details-dark.png'), fullPage: true })
  await page.getByRole('button', { name: 'Dismiss message' }).click()
  await expect(page.locator('.qg-payment-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Bitcoin payment ₿1,400.*Sent · Awaiting confirmation/ })).toHaveCount(
    0,
  )
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bitcoin-payment-view', { detail: 7 })))
  await expect(page.getByRole('button', { name: /Bitcoin payment ₿1,400.*Sent · Awaiting confirmation/ })).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss message' }).click()
  await expect(page.getByRole('button', { name: /Bitcoin payment ₿1,400.*Sent · Awaiting confirmation/ })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bitcoin-payment-view', { detail: 9 })))
  await expect(page.locator('.qg-footer .qg-payment-notice')).toBeVisible()
  await expect(page.locator('.qg-payment-notice p')).toHaveCSS('text-align', 'left')
  await expect(page.locator('.qg-payment-notice p')).toHaveCSS('font-size', '16px')
  await expectWalletLayout(page)
})

test('Spending remains usable when a Savings parent cannot be verified', async ({ page }) => {
  await openVault(page, {
    savingsUtxos: [{ txid: SAVINGS_TXID, vout: 0, value: 100_000, status: { confirmed: true, block_height: 1 } }],
  })
  await expect(page.getByTestId('vault-balance')).toHaveText('₿0')
  await expect(page.getByText('Could not refresh Savings. Try again.')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  await expect(page.getByTestId('vault-balance')).toHaveText('—')
  await expect(page.getByRole('alert')).toHaveText('Could not refresh Savings. Try again.')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-spend').click()
  await expect(page.getByTestId('vault-balance')).toHaveText('₿0')
})
