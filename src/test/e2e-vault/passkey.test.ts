import { connectorTestSecret } from './fixtures/connector'
import { hex, base64 } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import type { Page } from '@playwright/test'
import { enrollVaultWithPasskey, expect, test } from './fixtures/passkey'

const SESSION_LOCK_STORE = 'arkade-vault-v2:session-lock'

async function lock(page: Page) {
  await page.evaluate((key) => localStorage.setItem(key, '1'), SESSION_LOCK_STORE)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible()
}

async function clearBrowserWalletState(page: Page) {
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(database.name!)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
    }
    for (const name of await caches.keys()) await caches.delete(name)
  })
}

async function freshSignIn(page: Page) {
  await page.goto('/')
  const button = page.getByRole('button', { name: /Sign in to an existing vault/ })
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
}

test('enrolls, locks, and unlocks with a CTAP2.1 resident PRF passkey', async ({
  page,
  authorizer,
  passkey,
  secretAudit,
}) => {
  await enrollVaultWithPasskey(page, authorizer)
  const credentials = await passkey.credentials()
  expect(credentials).toHaveLength(1)
  expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' })

  await lock(page)
  await page.getByRole('button', { name: 'Unlock with passkey' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
  await secretAudit.assertNoSecretsPersisted(page)
})

test('enrolls the reviewed default policy as this vault immutable policy', async ({ page, authorizer, passkey }) => {
  void passkey
  await enrollVaultWithPasskey(page, authorizer)
  expect(authorizer.selectedSpendingPolicy()).toMatchObject({
    txRecipientCapSats: 50_000,
    periodAllowanceSats: 100_000,
    absoluteFeeCapSats: 5_000,
    feerateCapSatPerV: 10,
  })
  const storedPolicy = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.startsWith('arkade-vault-program-pin-v1:'))
    if (!key) return null
    const pin = JSON.parse(localStorage.getItem(key) || '{}') as { spendingPolicyCanonical?: string }
    return pin.spendingPolicyCanonical ? JSON.parse(pin.spendingPolicyCanonical) : null
  })
  expect(storedPolicy).toMatchObject({ txRecipientCapSats: 50_000, periodAllowanceSats: 100_000 })
})

test('creates and resumes a Savings connector handoff through the passkey-backed UI', async ({
  context,
  page,
  authorizer,
  passkey,
  secretAudit,
}) => {
  void passkey
  authorizer.fundSavings(51_500)
  await enrollVaultWithPasskey(page, authorizer)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  await expect(page.getByTestId('vault-balance')).toContainText('51,500')
  await page.getByRole('button', { name: 'Spending', exact: true }).click()
  await page.getByTestId('vault-send-amount').fill('50000')
  await page.getByRole('button', { name: 'Review move' }).click()

  await expect(page.getByRole('heading', { name: 'Review payment' })).toBeVisible()
  await expect(page.getByText('From Savings')).toBeVisible()
  await expect(page.getByText('Spending', { exact: true })).toBeVisible()
  await expect(page.getByText('Network fee and 240-sat anchor')).toBeVisible()
  await page.getByRole('button', { name: 'Sign on this device' }).click()

  await expect(page.getByRole('heading', { name: 'Signer next' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy PSBT' }).click()
  const phoneSigned = await page.evaluate(() => navigator.clipboard.readText())
  const hardwareSecret = connectorTestSecret()
  let hardwareSigned: string
  let expectedRaw: string
  try {
    const tx = Transaction.fromPSBT(base64.decode(phoneSigned), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      allowUnknown: true,
    })
    expect(tx.getInput(0).finalScriptWitness).toHaveLength(5)
    tx.signIdx(hardwareSecret, 1)
    hardwareSigned = hex.encode(tx.toPSBT())
    tx.finalizeIdx(1)
    expectedRaw = hex.encode(tx.extract())
  } finally {
    hardwareSecret.fill(0)
  }
  await secretAudit.assertNoSecretsPersisted(page)

  await page.reload()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByTestId('account-savings').click()
  const pending = page.getByRole('button', { name: /Waiting for signer/i })
  await expect(pending).toBeVisible()
  await pending.click()
  await expect(page.getByRole('heading', { name: 'Signer next' })).toBeVisible()

  await page.getByRole('button', { name: 'I’ve signed it' }).click()
  await page.getByTestId('savings-signed-psbt-file').setInputFiles({
    name: 'hardware-signed.psbt',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(hardwareSigned, 'hex'),
  })
  await expect(page.getByText('hardware-signed.psbt is ready to check.')).toBeVisible()
  // A success response for another transaction must not discard the durable handoff.
  let rejectedBroadcast = ''
  await page.route(
    '**/esplora/tx',
    async (route) => {
      rejectedBroadcast = route.request().postData() || ''
      await route.fulfill({ status: 200, body: 'dd'.repeat(32) })
    },
    { times: 1 },
  )
  await page.getByRole('button', { name: 'Check and send transaction' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect(rejectedBroadcast).toBe(expectedRaw)
  expect(
    await page.evaluate(
      (vaultId) => localStorage.getItem(`arkade-vault-connector-v1-pending-v1:${vaultId}`),
      authorizer.vaultId,
    ),
  ).not.toBeNull()
  expect(authorizer.broadcastedTransaction()).toBe('')

  await page.getByRole('button', { name: 'Check and send transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Savings transfer submitted' })).toBeVisible()
  await expect.poll(() => authorizer.broadcastedTransaction()).toBe(expectedRaw)
  await expect
    .poll(() =>
      page.evaluate(
        (vaultId) => localStorage.getItem(`arkade-vault-connector-v1-pending-v1:${vaultId}`),
        authorizer.vaultId,
      ),
    )
    .not.toBeNull()
})

test('a cancelled Face ID prompt retries through the same button', async ({ page, authorizer, passkey }) => {
  await enrollVaultWithPasskey(page, authorizer)
  await lock(page)
  await passkey.abortNextRequest()

  await page.getByRole('button', { name: 'Unlock with passkey' }).click()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
})

test('fresh browser state refuses a mismatched credential binding and then recovers with the resident passkey', async ({
  page,
  authorizer,
  passkey,
}) => {
  expect(await passkey.credentials()).toHaveLength(0)
  await enrollVaultWithPasskey(page, authorizer)
  await clearBrowserWalletState(page)
  await page.reload()
  authorizer.rejectNextRecoveryAsWrongCredential()

  const signIn = page.getByRole('button', { name: /Sign in to an existing vault/ })
  await expect(signIn).toBeVisible()
  await signIn.click()
  await expect(page.getByText(/Wrong passkey/)).toBeVisible()
  await expect(page.getByTestId('account-switcher')).not.toBeVisible()

  await freshSignIn(page)
})

test('reload before PRF derivation leaves the vault locked and permits a clean retry', async ({
  page,
  authorizer,
  passkey,
}) => {
  await enrollVaultWithPasskey(page, authorizer)
  await lock(page)
  await passkey.setPresence(false)
  await page.getByRole('button', { name: 'Unlock with passkey' }).click()

  await page.reload()
  await passkey.setPresence(true)
  await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible()
  await page.getByRole('button', { name: 'Unlock with passkey' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
})

test('reload after PRF derivation but before recovery response installs no session and can recover again', async ({
  page,
  authorizer,
  passkey,
  secretAudit,
}) => {
  await enrollVaultWithPasskey(page, authorizer)
  await clearBrowserWalletState(page)
  await page.reload()
  authorizer.clearRecoverGate()

  await page.getByRole('button', { name: /Sign in to an existing vault/ }).click()
  await authorizer.waitForRecover()
  await page.reload()
  authorizer.releaseRecover()

  await expect(page.getByTestId('account-switcher')).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Sign in to an existing vault/ })).toBeVisible()
  await freshSignIn(page)
  await secretAudit.assertNoSecretsPersisted(page)

  const audit = await secretAudit.snapshot(page)
  expect(JSON.stringify(audit.serviceWorkerMessages)).not.toMatch(/phone.?secret|phone.?scalar|private.?key|prf/i)
  expect(await passkey.credentials()).toHaveLength(1)
})

test('open enrollment creates a vault without an invite and retains passkey sign-in', async ({
  page,
  authorizer,
  passkey,
}) => {
  authorizer.setInviteOnly(false)
  await enrollVaultWithPasskey(page, authorizer, false)
  expect(await passkey.credentials()).toHaveLength(1)
  expect(await page.evaluate(() => sessionStorage.getItem('vaulted.open-enrollment-session'))).toBeNull()
  await lock(page)
  await page.getByRole('button', { name: 'Unlock with passkey' }).click()
  await expect(page.getByTestId('account-switcher')).toBeVisible()
})
