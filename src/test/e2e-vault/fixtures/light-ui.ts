import { expect, type Page } from '@playwright/test'
import { sharedSpendingEnrollment, sharedSpendingStatus } from '../../../lib/vault/vtxo/testdata/sharedSpending'
import { pinFromEnrolledStatus, addressPinStoreKey } from '../../../lib/vault/pin'
import { ENROLL_STORE, SELECTED_VAULT_STORE } from '../../../lib/vault/enrollmentStore'

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
  const enrollment = sharedSpendingEnrollment()
  const status = sharedSpendingStatus()
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
  await override(page, 'lib/vault/status.ts', {
    fetchVaultStatusUnpinned: `async () => (${JSON.stringify(status)})`,
    fetchVaultStatus: `async () => (${JSON.stringify(status)})`,
  })
  await override(page, 'vault/useRecoveryArchive.ts', {
    useRecoveryArchive: `() => ({backupRecoveryArchive:async()=>{},downloadRecoveryArchive:async()=>'',recoveryArchiveStatus:'',recoveryArchiveError:''})`,
  })
  const savingsHistory = watch
    ? Array.from({ length: 12 }, (_, index) => ({
        ...history[0],
        account: 'savings',
        txid: index.toString(16).padStart(64, '0'),
      }))
    : []
  const savingsBalance = watch ? 1234567890 : 0
  await override(page, 'vault/useVaultBalances.ts', {
    useVaultBalances: `() => ({
    balanceError:'',boardingError:'',balancesLoaded:true,snapshotFresh:true,
    history:${JSON.stringify([...history, ...savingsHistory])},
    positions:{spending:{availableSats:${snapshot?.balance ?? 12000},pendingSats:${snapshot?.pendingBalance ?? 2000},totalSats:${(snapshot?.balance ?? 12000) + (snapshot?.pendingBalance ?? 2000)}},savings:{availableSats:${savingsBalance},pendingSats:0,totalSats:${savingsBalance}}},
    refreshBalance:async()=>{},refreshingBalance:false,loadOlderActivity:async()=>({added:0,exhausted:true}),olderActivity:{status:'idle',error:''},olderHistory:[]
  })`,
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
  await override(page, 'lib/vault/lightning.ts', {
    loadVaultLightningFundingQuote: `async () => undefined`,
    withVaultLightningRepository: `async (_id, run) => run({})`,
  })
  await override(page, 'lib/fiat.ts', { getPriceFeed: `async () => ({usd:100000})` })
  if (watch)
    await override(page, 'lib/vault/watchSavings.ts', {
      loadWatchedSavings: `() => ({address:'${status.vtxoBoardingAddress}',network:'mutinynet',label:'Watch-only Savings'})`,
    })
  void local // Every fresh Light wallet now follows the same enrolled-device path.
  await page.addInitScript(
    ({ enrollment, pin, enrollmentStore, selectedStore, pinStore }) => {
      localStorage.setItem(selectedStore, enrollment.vaultId)
      localStorage.setItem(enrollmentStore + ':' + enrollment.vaultId, JSON.stringify(enrollment))
      localStorage.setItem(pinStore, JSON.stringify(pin))
    },
    {
      enrollment,
      pin: pinFromEnrolledStatus(status),
      enrollmentStore: ENROLL_STORE,
      selectedStore: SELECTED_VAULT_STORE,
      pinStore: addressPinStoreKey(status.vaultId),
    },
  )
  await page.goto('/')
  await expect(page.getByTestId('vault-balance')).toHaveText(
    `₿${((snapshot?.balance ?? 12000) + (snapshot?.pendingBalance ?? 2000)).toLocaleString('en-US')}`,
  )
}
