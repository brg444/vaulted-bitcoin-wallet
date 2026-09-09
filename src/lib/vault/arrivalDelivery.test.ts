import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { claimArrivalDelivery } from './arrivalDelivery'

describe('arrival announcement delivery', () => {
  it('allows one of two simultaneous tab connections to announce a payment', async () => {
    const factory = new IDBFactory()
    const results = await Promise.all([
      claimArrivalDelivery(['mainnet:vault-a:payment-1'], factory),
      claimArrivalDelivery(['mainnet:vault-a:payment-1'], factory),
    ])
    expect(results.flat()).toEqual(['mainnet:vault-a:payment-1'])
    expect(await claimArrivalDelivery(['mainnet:vault-a:payment-1'], factory)).toEqual([])
  })
  it('keeps equal-sized payments, network and vault identities independent', async () => {
    const factory = new IDBFactory()
    const keys = ['mainnet:a:one', 'mainnet:a:two', 'mainnet:b:one', 'mutinynet:a:one']
    expect(await claimArrivalDelivery([...keys, keys[0]], factory)).toEqual(keys)
  })
})
