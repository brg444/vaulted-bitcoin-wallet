import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { claimNativeDelivery } from './nativeDelivery'

describe('native delivery receipts', () => {
  it('announces each payment identity once across tabs', async () => {
    const factory = new IDBFactory()
    const results = await Promise.all([
      claimNativeDelivery(['mainnet:vault-a:payment-1'], factory),
      claimNativeDelivery(['mainnet:vault-a:payment-1'], factory),
    ])
    expect(results.flat()).toEqual(['mainnet:vault-a:payment-1'])
    expect(await claimNativeDelivery(['mainnet:vault-a:payment-1'], factory)).toEqual([])
  })

  it('keeps payment identities independent', async () => {
    const factory = new IDBFactory()
    const keys = ['mainnet:a:one', 'mainnet:a:two', 'mainnet:b:one', 'mutinynet:a:one']
    expect(await claimNativeDelivery([...keys, keys[0]], factory)).toEqual(keys)
  })
})
