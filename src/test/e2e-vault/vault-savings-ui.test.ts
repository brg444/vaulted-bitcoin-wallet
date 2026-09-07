import { expect, test, type Page, type Route } from '@playwright/test'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import type { VaultStatus } from '../../lib/vault/types'

const AMOUNT = 50_000
const FEE = 1_500
const UI_FIXTURE = '/src/test/e2e-vault/fixtures/vault-ui.ts'
const ENROLLMENT_MODULE = '/src/lib/vault/enrollmentStore.ts'
const HANDOFF_MODULE = '/src/lib/vault/savingsHandoff.ts'
const SAVINGS_MODULE = '/src/lib/vault/savingsSpend.ts'
const PROGRAM_FIXTURE_MODULE = '/src/lib/vault/program/fixtures.ts'
const APP_PORT = process.env.VAULT_E2E_PORT || '3003'
const OPERATOR_PORT = process.env.VAULT_E2E_OPERATOR_PORT || '18888'
const APP_ORIGIN = `http://localhost:${APP_PORT}`
const OPERATOR_ORIGIN = `http://127.0.0.1:${OPERATOR_PORT}`
const AUTHORIZER_CONTROL = `${OPERATOR_ORIGIN}/__vault_e2e_authorizer`
const ESPLORA_CONTROL = `${OPERATOR_ORIGIN}/__vault_e2e_esplora`

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openVault(page: Page): Promise<{ broadcastHex: () => string; status: VaultStatus }> {
  let status: VaultStatus | undefined
  let broadcastHex = ''
  await page.route('**/v1/status*', (route) =>
    json(
      route,
      new URL(route.request().url()).searchParams.has('vault')
        ? status
        : {
            network: 'mutinynet',
            clientOrigin: APP_ORIGIN,
            rpId: 'localhost',
            templateVersion: 'phone-hww-recovery-savings-v1',
            policyVersion: 'vault-spending-policy-v1',
            enrollmentMode: 'token',
          },
    ),
  )
  await page.route('**/esplora/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/esplora/blocks/tip/height') return route.fulfill({ status: 200, body: '1' })
    if (url.pathname === '/esplora/tx' && route.request().method() === 'POST') {
      broadcastHex = route.request().postData() || ''
      const txid = Transaction.fromRaw(hex.decode(broadcastHex)).id
      return route.fulfill({ status: 200, body: txid })
    }
    return json(route, [])
  })
  await page.goto('/')
  status = (await page.evaluate(async (fixturePath) => {
    const fixture = await import(/* @vite-ignore */ fixturePath)
    return fixture.installVaultUiSession()
  }, UI_FIXTURE)) as VaultStatus
  const fixtureResponse = await fetch(AUTHORIZER_CONTROL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(status),
  })
  if (!fixtureResponse.ok) throw new Error(`Authorizer fixture reset failed: ${fixtureResponse.status}`)
  const esploraResponse = await fetch(ESPLORA_CONTROL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boardingAddress: status.vtxoBoardingAddress,
      boardingUtxos: [],
      savingsAddress: status.savingsAddress,
      savingsTxs: [],
      savingsUtxos: [],
    }),
  })
  if (!esploraResponse.ok) throw new Error(`Esplora fixture reset failed: ${esploraResponse.status}`)
  await page.reload()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
  return { broadcastHex: () => broadcastHex, status }
}

async function selectSavings(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  await expect(page.getByTestId('account-switcher')).toContainText('Savings')
}

async function createPendingTransfer(
  page: Page,
  status: VaultStatus,
): Promise<{ hardwareSigned: string; phoneSigned: string }> {
  return page.evaluate(
    async ({ amount, enrollmentPath, fee, fixturePath, handoffPath, savingsPath, vaultStatus }) => {
      const enrollmentStore = await import(/* @vite-ignore */ enrollmentPath)
      const handoff = await import(/* @vite-ignore */ handoffPath)
      const savings = await import(/* @vite-ignore */ savingsPath)
      const fixtures = await import(/* @vite-ignore */ fixturePath)
      const enrollment = enrollmentStore.loadEnrollment(localStorage, vaultStatus.vaultId)
      if (!enrollment) throw new Error('test enrollment is missing')
      const unsigned = savings.buildSavingsPsbt({
        status: vaultStatus,
        phonePub: enrollment.phoneBip340Pub,
        destAddress: vaultStatus.vtxoBoardingAddress,
        amountSats: amount,
        feeSats: fee,
        coins: [{ txid: '77'.repeat(32), vout: 0, value: amount + fee, confirmedHeight: 1 }],
        leaf: 'admin',
      })
      const phoneSecret = fixtures.scalarSecret(3)
      const hardwareSecret = fixtures.scalarSecret(4)
      try {
        const phoneSigned = savings.signSavingsPsbt(unsigned, phoneSecret)
        handoff.savePendingSavingsHandoff(
          localStorage,
          handoff.createPendingSavingsHandoff({
            vaultId: vaultStatus.vaultId,
            psbtHex: phoneSigned,
            destAddress: vaultStatus.vtxoBoardingAddress,
            amountSats: amount,
            feeSats: fee,
            network: vaultStatus.network,
          }),
        )
        return {
          phoneSigned,
          hardwareSigned: savings.signSavingsPsbt(phoneSigned, hardwareSecret),
        }
      } finally {
        phoneSecret.fill(0)
        hardwareSecret.fill(0)
      }
    },
    {
      amount: AMOUNT,
      enrollmentPath: ENROLLMENT_MODULE,
      fee: FEE,
      fixturePath: PROGRAM_FIXTURE_MODULE,
      handoffPath: HANDOFF_MODULE,
      savingsPath: SAVINGS_MODULE,
      vaultStatus: status,
    },
  )
}

test('@polish persists a phone-signed Savings PSBT and completes a real hardware-signed handoff', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
  const { broadcastHex, status } = await openVault(page)
  const { hardwareSigned, phoneSigned } = await createPendingTransfer(page, status)

  await page.reload()
  await selectSavings(page)
  const pending = page.getByRole('button', { name: /Waiting for hardware ₿51,500/i })
  await expect(pending).toBeVisible()

  await page.reload()
  await selectSavings(page)
  await page.getByRole('button', { name: /Waiting for hardware ₿51,500/i }).click()
  await expect(page.getByRole('heading', { name: 'Hardware next' })).toBeVisible()
  await expect(page).toHaveScreenshot('savings-hardware-handoff.png', { animations: 'disabled', fullPage: true })

  await page.getByText('Other signing methods', { exact: true }).click()
  await page.getByRole('button', { name: 'Copy PSBT' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toBe(Buffer.from(phoneSigned, 'hex').toString('base64'))

  await page.getByRole('button', { name: 'I’ve signed it' }).click()
  await page.getByTestId('savings-signed-psbt-file').setInputFiles({
    name: 'hardware-signed.psbt',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(hardwareSigned, 'hex'),
  })
  await expect(page.getByText('hardware-signed.psbt is ready to check.')).toBeVisible()

  await page.getByRole('button', { name: 'Check and send transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Savings transfer submitted' })).toBeVisible()
  await expect(page.getByText('Bitcoin confirmation is next')).toBeVisible()
  await expect(page.getByText('PSBT copied')).toBeHidden()
  await page.getByText('View transaction', { exact: true }).click()
  const reference = page.locator('details[aria-label="Transaction reference"]')
  const txid = await reference.locator('code').innerText()
  expect(txid).toMatch(/^[0-9a-f]{64}$/)
  await expect(reference.getByRole('link', { name: 'View on Bitcoin explorer' })).toHaveAttribute(
    'href',
    `https://mempool.mutinynet.arkade.sh/tx/${txid}`,
  )
  await expect(page).toHaveScreenshot('savings-transfer-success.png', { animations: 'disabled', fullPage: true })
  await reference.getByRole('button', { name: 'Copy transaction ID' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(txid)
  await expect.poll(broadcastHex).toMatch(/^[0-9a-f]+$/)
  await expect
    .poll(() => page.evaluate((id) => localStorage.getItem(`arkade-vault-savings-handoff-v1:${id}`), status.vaultId))
    .toBeNull()
})
