import type { Page } from '@playwright/test'
import { POLICY_VERSION } from '../../../lib/vault/constants'
import { SAVINGS_TEMPLATE } from '../../../lib/vault/program/constants'
import { CURRENT_SPENDING_POLICY_CAPABILITIES } from '../../../lib/vault/spendingPolicy'
import { BOARDING_PROGRAM } from '../../../lib/vault/vtxo/board'

export async function mockEnrollmentAccess(page: Page, initial: 'open' | 'token' = 'token') {
  let mode = initial
  await page.route('**/v1/status', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        network: 'mutinynet',
        clientOrigin: url.origin,
        rpId: url.hostname,
        templateVersion: SAVINGS_TEMPLATE,
        policyVersion: POLICY_VERSION,
        enrollmentMode: mode,
        supportedSetups: ['light'],
        spendingPolicyCapabilities: CURRENT_SPENDING_POLICY_CAPABILITIES,
        vtxoBoardingProgram: BOARDING_PROGRAM,
      }),
    })
  })
  return (next: 'open' | 'token') => {
    mode = next
  }
}
