import { afterEach, describe, expect, it } from 'vitest'
import { loadBalanceSnapshot, saveBalanceSnapshot } from './balanceStore'

afterEach(() => localStorage.clear())

describe('balanceStore', () => {
  it('round-trips a snapshot and ignores corrupt rows', () => {
    saveBalanceSnapshot('vault-a', 'mutinynet', {
      boardingBalance: 1_000,
      history: [],
      savingsSats: 2_000,
      savingsSpendableSats: 2_000,
      vtxoSpendingSats: 3_000,
    })
    expect(loadBalanceSnapshot('vault-a', 'mutinynet')?.vtxoSpendingSats).toBe(3_000)
    expect(loadBalanceSnapshot('', 'mutinynet')).toBeNull()
    localStorage.setItem('arkade-vault-v2:balance-snapshot:mutinynet:vault-a', '{')
    expect(loadBalanceSnapshot('vault-a', 'mutinynet')).toBeNull()
  })
})

it('does not reuse an unscoped cache or another network cache', () => {
  const snapshot = { boardingBalance: 0, history: [], savingsSats: 0, savingsSpendableSats: 0, vtxoSpendingSats: 7000 }
  localStorage.setItem('arkade-vault-v2:balance-snapshot:vault-a', JSON.stringify(snapshot))
  expect(loadBalanceSnapshot('vault-a', 'mutinynet')).toBeNull()
  saveBalanceSnapshot('vault-a', 'mutinynet', snapshot)
  expect(loadBalanceSnapshot('vault-a', 'mainnet')).toBeNull()
  expect(loadBalanceSnapshot('vault-a', 'mutinynet')?.vtxoSpendingSats).toBe(7000)
})
