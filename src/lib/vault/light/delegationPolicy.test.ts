import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { networkPins } from '../networkPins'
import { lightDelegateService, validateLightDelegateInfo } from './delegationPolicy'
import mainnetInfo from './testdata/delegate-mainnet-info.json'
import mutinynetInfo from './testdata/delegate-mutinynet-info.json'

const key = (index: number) => hex.encode(schnorr.getPublicKey(hex.decode(index.toString(16).padStart(64, '0'))))

describe('current-service Light delegation preparation', () => {
  it.each(['mainnet', 'mutinynet'] as const)(
    'uses the existing %s service and independently pinned identity',
    (network) => {
      const info = network === 'mainnet' ? mainnetInfo : mutinynetInfo
      expect(lightDelegateService(network)).toEqual({
        origin: networkPins(network).delegateOrigin,
        pubkey: info.pubkey,
      })
      expect(validateLightDelegateInfo(network, info)).toEqual({
        pubkey: info.pubkey,
        fee: '0',
        delegateAddress: info.delegateAddress,
      })
      const { delegateAddress, ...legacy } = info
      expect(validateLightDelegateInfo(network, legacy).delegateAddress).toBe(delegateAddress)
    },
  )

  it('rejects key, network, fee and address substitution', () => {
    expect(() => validateLightDelegateInfo('mainnet', mutinynetInfo)).toThrow()
    for (const pubkey of ['', mainnetInfo.pubkey.toUpperCase(), '02' + key(9)]) {
      expect(() => validateLightDelegateInfo('mainnet', { ...mainnetInfo, pubkey })).toThrow(/key/)
    }
    for (const fee of ['1', '0.0', '-1', 'NaN', 0, null]) {
      expect(() => validateLightDelegateInfo('mainnet', { ...mainnetInfo, fee })).toThrow(/fee/)
    }
    for (const invalid of [null, [], 1, 'invalid', {}]) {
      expect(() => validateLightDelegateInfo('mainnet', invalid)).toThrow()
    }
    expect(() =>
      validateLightDelegateInfo('mainnet', {
        ...mainnetInfo,
        delegateAddress: mutinynetInfo.delegateAddress,
        delegatorAddress: mutinynetInfo.delegateAddress,
      }),
    ).toThrow(/network/)
    expect(() =>
      validateLightDelegateInfo('mainnet', { ...mainnetInfo, delegateAddress: mutinynetInfo.delegateAddress }),
    ).toThrow(/Conflicting/)
    expect(() =>
      validateLightDelegateInfo('mainnet', { ...mainnetInfo, delegateAddress: '', delegatorAddress: '' }),
    ).toThrow(/Missing/)
  })
})
