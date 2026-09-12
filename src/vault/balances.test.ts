import { describe, expect, it } from 'vitest'
import { vaultAccountPositions } from '../lib/vault/balances'

describe('vaultAccountPositions', () => {
  it('keeps confirmed Spending available', () => {
    expect(
      vaultAccountPositions({
        boardingSats: 0,
        savingsAvailableSats: 0,
        savingsTotalSats: 0,
        spendingAvailableSats: 80_000,
      }).spending,
    ).toEqual({ availableSats: 80_000, pendingSats: 0, totalSats: 80_000 })
  })

  it('separates detected boarding funds from available Spending', () => {
    expect(
      vaultAccountPositions({
        boardingSats: 48_000,
        savingsAvailableSats: 0,
        savingsTotalSats: 0,
        spendingAvailableSats: 80_000,
      }).spending,
    ).toEqual({ availableSats: 80_000, pendingSats: 48_000, totalSats: 128_000 })
  })

  it('keeps pending boarding unavailable when Spending has no VTXOs', () => {
    expect(
      vaultAccountPositions({
        boardingSats: 48_000,
        savingsAvailableSats: 0,
        savingsTotalSats: 0,
        spendingAvailableSats: 0,
      }).spending,
    ).toEqual({ availableSats: 0, pendingSats: 48_000, totalSats: 48_000 })
  })

  it('separates unconfirmed wallet change from available Savings', () => {
    expect(
      vaultAccountPositions({
        boardingSats: 0,
        savingsAvailableSats: 79_520,
        savingsTotalSats: 497_620,
        spendingAvailableSats: 0,
      }).savings,
    ).toEqual({ availableSats: 79_520, pendingSats: 418_100, totalSats: 497_620 })
  })
})
