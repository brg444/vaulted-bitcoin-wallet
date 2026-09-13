import { describe, expect, it } from 'vitest'
import type { VaultStatus } from '../types'
import { ledgerRecoveryFacts, sharedSpendingRecoveryFixture } from '../recovery/testdata/helpers'
import { LEDGER_NATIVE_TEMPLATE } from './ledgerNativeKeys'
import { kitMatchesLiveVault, selectLiveKit, watcherEnabledForTemplate } from './liveKit'

describe('live retained kit policy', () => {
  it('enables Savings observation only for Ledger', () => {
    expect(watcherEnabledForTemplate(LEDGER_NATIVE_TEMPLATE)).toBe(true)
    for (const template of [
      'phone-hww-recovery-savings-v1',
      'phone-connector-recovery-savings-v1',
      'phone-connector-recovery-savings-v2',
      'vaulted-light-v1',
      '',
    ])
      expect(watcherEnabledForTemplate(template)).toBe(false)
  })
  it.each(['mainnet', 'mutinynet'] as const)('binds selection to complete Ledger identity on %s', (network) => {
    const { kit, status } = ledgerRecoveryFacts(true, network)
    expect(kitMatchesLiveVault(kit, status)).toBe(true)
    expect(selectLiveKit({ status, stored: kit })).toBe(kit)
    for (const patch of [
      { vaultId: 'another-vault' },
      { savingsAddress: 'tb1pstale' },
      { savingsScript: '5120' + '00'.repeat(32) },
      { protectionTier: 'standard' as const },
      { ledgerSavings: undefined },
      { enrolled: false },
    ])
      expect(kitMatchesLiveVault(kit, { ...status, ...patch } as unknown as VaultStatus)).toBe(false)
    expect(selectLiveKit({ status: { ...status, enrolled: false }, stored: kit })).toBeNull()
  })
  it('matches shared Spending without starting a Savings watcher', () => {
    const { kit, status } = sharedSpendingRecoveryFixture()
    expect(kitMatchesLiveVault(kit, status)).toBe(true)
    expect(selectLiveKit({ status, stored: kit })).toBeNull()
    expect(kitMatchesLiveVault(kit, ledgerRecoveryFacts().status)).toBe(false)
  })
})
