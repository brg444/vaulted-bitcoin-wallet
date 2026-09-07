import { describe, expect, it } from 'vitest'
import { recoveryFixture } from './testdata/helpers'
import { vaultRecoveryBinding } from '../vtxo/recoveryArchive'
import { packExitArchive } from './exitArchive'
import { requireSpendingRecoveryCoverage, spendingRecoveryCoverage } from './coverage'

describe('Spending recovery coverage', () => {
  const fixture = () => {
    const f = recoveryFixture()
    return { ...f, binding: vaultRecoveryBinding(f.kit, f.status) }
  }
  it('compares output identities even when a replacement has the same balance', () => {
    const { archive, binding, coin } = fixture()
    const replacement = { ...coin, txid: 'ff'.repeat(32) }
    const result = spendingRecoveryCoverage(archive.spending, binding, [replacement])
    expect(result.state).toBe('incomplete')
    expect(result.coveredSats).toBe(0)
    expect(result.missing).toEqual([`${replacement.txid}:0`])
    expect(result.stale).toEqual([`${coin.txid}:0`])
    expect(() => requireSpendingRecoveryCoverage(archive.spending, binding, [replacement])).toThrow('retained')
  })
  it('does not infer current coverage from an archive timestamp or an unknown wallet state', () => {
    const { archive, binding } = fixture()
    const result = spendingRecoveryCoverage(archive.spending, binding, null)
    expect(result.state).toBe('unknown')
    expect(result.coveredSats).toBeNull()
    expect(result.archivedSats).toBeGreaterThan(0)
  })
  it('deduplicates identical known outputs and rejects conflicting or foreign expectations', () => {
    const { archive, binding, coin } = fixture()
    expect(spendingRecoveryCoverage(archive.spending, binding, [coin, coin])).toMatchObject({
      state: 'current',
      coveredSats: coin.value,
      archivedSats: coin.value,
    })
    expect(() =>
      spendingRecoveryCoverage(archive.spending, binding, [coin, { ...coin, value: coin.value + 1 }]),
    ).toThrow('disagree')
    expect(() => spendingRecoveryCoverage(archive.spending, binding, [{ ...coin, script: '00' }])).toThrow('wallet')
  })
  it('reports mismatched amounts and does not count them as covered', () => {
    const { archive, binding, coin } = fixture()
    expect(spendingRecoveryCoverage(archive.spending, binding, [{ ...coin, value: coin.value + 1 }])).toMatchObject({
      state: 'incomplete',
      coveredSats: 0,
      mismatched: [`${coin.txid}:0`],
    })
  })
  it('distinguishes an absent file, invalid evidence and an explicitly empty snapshot', () => {
    const { archive, binding, coin } = fixture()
    expect(spendingRecoveryCoverage(null, binding, [coin]).state).toBe('missing')
    expect(spendingRecoveryCoverage({ ...archive.spending, transactions: {} }, binding, [coin]).state).toBe('invalid')
    expect(
      spendingRecoveryCoverage(archive.spending, { ...binding, descriptorHash: 'ff'.repeat(32) }, [coin]).state,
    ).toBe('invalid')
    expect(spendingRecoveryCoverage(archive.spending, binding, []).state).toBe('incomplete')
    const empty = { ...archive.spending, coins: packExitArchive([]), branches: {}, transactions: {} }
    expect(spendingRecoveryCoverage(empty, binding, [])).toMatchObject({ state: 'current', coveredSats: 0 })
  })
})
