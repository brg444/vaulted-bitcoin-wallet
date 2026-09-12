import type { AccountBalanceRead, AccountBalanceReads } from '../vault/balances'

export function accountBalanceReads(overrides: Partial<AccountBalanceRead> = {}): AccountBalanceReads {
  const read = { loaded: true, refreshing: false, fresh: false, error: '', ...overrides }
  return { spend: { ...read }, savings: { ...read } }
}
