import { describe, expect, it } from 'vitest'
import { ledgerRecoveryFacts } from '../recovery/testdata/helpers'
import { alertCopy, outpointId, pollPendingInitiates } from './watch'

describe.each(['mainnet', 'mutinynet'] as const)('Ledger Savings pending watcher on %s', (network) => {
  it('alerts the first time a pending coin appears and does not repeat', async () => {
    const descriptor = ledgerRecoveryFacts(true, network).kit.descriptor
    const coin = { txid: 'aa'.repeat(32), vout: 0, value: 20_000, status: { confirmed: true, block_height: 10 } }
    const first = await pollPendingInitiates({
      descriptor,
      seen: new Set(),
      fetchUtxos: async (address) => (address === descriptor.pending['savings-hardware'].address ? [coin] : []),
    })
    expect(first.alerts).toHaveLength(1)
    expect(first.alerts[0].familyKey).toBe('savings-hardware')
    expect(alertCopy(first.alerts[0])).toMatch(/started recovery on Savings with hardware/i)
    const second = await pollPendingInitiates({
      descriptor,
      seen: first.seen,
      fetchUtxos: async (address) => (address === descriptor.pending['savings-hardware'].address ? [coin] : []),
    })
    expect(second.alerts).toHaveLength(0)
    expect(outpointId(coin.txid, coin.vout)).toBe(`${coin.txid}:0`)
  })

  it('announces a phone-initiated Savings output once and does not repeat', async () => {
    const descriptor = ledgerRecoveryFacts(true, network).kit.descriptor
    const coin = { txid: 'bb'.repeat(32), vout: 1, value: 18_000, status: { confirmed: true, block_height: 12 } }
    const first = await pollPendingInitiates({
      descriptor,
      seen: new Set(),
      fetchUtxos: async (address) => (address === descriptor.pending['savings-phone'].address ? [coin] : []),
    })
    expect(first.alerts).toHaveLength(1)
    expect(first.alerts[0].familyKey).toBe('savings-phone')
    expect(alertCopy(first.alerts[0])).toMatch(/started recovery on Savings with this device/i)
    const second = await pollPendingInitiates({
      descriptor,
      seen: first.seen,
      fetchUtxos: async (address) => (address === descriptor.pending['savings-phone'].address ? [coin] : []),
    })
    expect(second.alerts).toHaveLength(0)
  })

  it('polls only the Standard phone and hardware families', async () => {
    const descriptor = ledgerRecoveryFacts(false, network).kit.descriptor
    const addresses: string[] = []
    const result = await pollPendingInitiates({
      descriptor,
      seen: new Set(),
      fetchUtxos: async (address) => {
        addresses.push(address)
        return []
      },
    })
    expect(result.alerts).toEqual([])
    expect(addresses).toEqual([
      descriptor.pending['savings-phone'].address,
      descriptor.pending['savings-hardware'].address,
    ])
  })
})
