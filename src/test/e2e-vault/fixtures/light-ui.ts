import { expect, type Page } from '@playwright/test'
import { lightTestEnrollment, lightTestStatus } from '../../../lib/vault/light/testdata/helpers'

// UI-only fixtures: render the real Light screens with deterministic data. No signing,
// enrollment, broadcast, or recovery is exercised by this suite.
async function override(page: Page, path: string, exports: Record<string, string>) {
  await page.route(`**/src/${path}*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has('light-ui-original')) return route.continue()
    await route.fulfill({
      contentType: 'application/javascript',
      body: `export * from '/src/${path}?light-ui-original';\n${Object.entries(exports)
        .map(([name, value]) => `export const ${name} = ${value};`)
        .join('\n')}`,
    })
  })
}
export async function openLight(
  page: Page,
  watch = false,
  local = false,
  snapshot?: { balance: number; pendingBalance: number; history: Record<string, unknown>[] },
  pendingPayment?: { amountSats: number; destAddress: string; feeSats: number },
) {
  const record = await lightTestEnrollment()
  const status = lightTestStatus(record.descriptor)
  const pending = pendingPayment && {
    ...pendingPayment,
    vaultId: status.vaultId,
    operationId: '11'.repeat(16),
    bundleDigest: '22'.repeat(32),
    arkTxid: '33'.repeat(32),
    stage: 'authorized',
  }
  const history = snapshot?.history ?? [
    {
      account: 'spend',
      txid: 'ab'.repeat(32),
      amount: 12000,
      type: 'received',
      confirmed: true,
      blockTime: 1788739200,
    },
    { account: 'spend', txid: 'cd'.repeat(32), amount: 2000, type: 'sent', confirmed: false },
  ]
  await override(page, 'lib/vault/light/enrollment.ts', { loadLightEnrollment: `() => (${JSON.stringify(record)})` })
  await override(page, 'lib/vault/status.ts', { fetchVaultStatusUnpinned: `async () => (${JSON.stringify(status)})` })
  await override(page, 'lib/vault/light/cloudBackup.ts', {
    openLightCloudBackup: `async () => ({record:${JSON.stringify(record)}})`,
  })
  await override(page, 'lib/vault/recovery/capture.ts', {
    syncCompleteLightBackup: `async () => ({createdAt:'2026-09-07T00:00:00Z'})`,
  })
  await override(page, 'lib/vault/light/recoveryArchive.ts', {
    captureLightRecoveryArchive: `async () => ({coins:[],capturedAt:'2026-09-07T00:00:00Z'})`,
    loadLightRecoveryArchive: `async () => ({coins:[],capturedAt:'2026-09-07T00:00:00Z'})`,
  })
  await override(page, 'lib/vault/light/backupScheduler.ts', {
    lightBackupScheduler: `() => ({request(){},dispose(){}})`,
  })
  await override(page, 'lib/vault/vtxo/walletWorker.ts', {
    fetchVaultWalletVtxoSnapshot: `async () => ({balance:${snapshot?.balance ?? 12000},pendingBalance:${snapshot?.pendingBalance ?? 2000},recoveryVtxos:[],history:${JSON.stringify(history)}})`,
    subscribeVaultWalletEvents: `() => () => {}`,
    ensureVaultWalletWorker: `async () => ({})`,
    shutdownVaultWalletWorker: `async () => {}`,
  })
  await override(page, 'lib/vault/vtxo/spend.ts', {
    reconcilePersistedVtxoSpend: `async () => {}`,
    previewVaultVtxoSend: `async (_status,address,amount) => ({destAddress:address,amountSats:amount,feeSats:20})`,
    reserveVaultVtxo: `async (_record,_status,address,amount) => ({destAddress:address,amountSats:amount,feeSats:20})`,
    sendVaultVtxo: `async () => ({txid:'${'ef'.repeat(32)}',feeSats:20})`,
    createVtxoSpendUnlocker: `() => ({unlock:async () => ({phoneSecret:new Uint8Array(32).fill(1),scalar:new Uint8Array(32).fill(1),assertion:{}}),dispose(){}})`,
    ...(pendingPayment
      ? {
          loadPersistedVtxoSpend: `() => (${JSON.stringify(pending)})`,
          listPersistedVtxoSpends: `() => [${JSON.stringify(pending)}]`,
          loadPersistedVtxoSpendById: `() => (${JSON.stringify(pending)})`,
          quoteFromPersistedVtxoSpend: `(payment) => payment`,
        }
      : {}),
  })
  await override(page, 'lib/vault/light/guardianDelegation.ts', { authorizeGuardianRenewals: `async () => null` })
  await override(page, 'lib/vault/lightning.ts', {
    loadVaultLightningFundingQuote: `async () => undefined`,
    withVaultLightningRepository: `async (_id, run) => run({})`,
  })
  await override(page, 'lib/fiat.ts', { getPriceFeed: `async () => ({usd:100000})` })
  if (watch) {
    await override(page, 'lib/vault/light/watchSavings.ts', {
      loadWatchedSavings: `() => ({address:'tb1q-watch-only-ui-fixture',network:'mutinynet',label:'Savings'})`,
      fetchWatchedSavings: `async () => ({balance:1234567890,history:${JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ ...history[0], account: 'savings', txid: index.toString(16).padStart(64, '0') })))}})`,
    })
  }
  if (local) {
    await override(page, 'lib/vault/light/passkey.ts', {
      unlockLightWithPasskey: `async () => new Uint8Array(32).fill(1)`,
    })
    await override(page, 'lib/vault/light/guardianDelegation.ts', { authorizeGuardianRenewals: `async () => null` })
  }
  await page.addInitScript(() => localStorage.setItem('vaulted:active-setup', 'light'))
  await page.goto('/')
  if (local) {
    await page.getByText('Use a local passkey', { exact: true }).click()
    await page.getByRole('button', { name: 'Unlock on this device', exact: true }).click()
  } else await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
  await expect(page.getByTestId('vault-balance')).toHaveText(
    `₿${((snapshot?.balance ?? 12000) + (snapshot?.pendingBalance ?? 2000)).toLocaleString('en-US')}`,
  )
}
