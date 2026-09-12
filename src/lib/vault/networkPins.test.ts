import { describe, expect, it } from 'vitest'
import { networkPins, vaultOperatorOrigin, requireSdkNetworkName, sdkNetworkName } from './networkPins'

describe('networkPins', () => {
  it('keeps Mutinynet delays and Operator identity unchanged', () => {
    const pins = networkPins('mutinynet')
    expect(pins.policyExitDelay).toBe(4608)
    expect(pins.boardExitDelay).toBe(604_672)
    expect(pins.operatorOrigin).toBe('https://mutinynet.arkade.sh')
    expect(pins.esploraApiUrl).toBe('https://mempool.mutinynet.arkade.sh/api')
    expect(pins.checkpointForfeitPub).toBe('02dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0b')
    expect(pins.checkpointTapscript).toBe(
      '03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac',
    )
    expect(pins.checkpointDelaySeconds).toBe(4096)
    expect(pins.arkHrp).toBe('tark')
    expect(pins.absoluteFeeCeilingSats).toBe(5_000)
    expect(pins.feerateCeilingSatPerV).toBe(10)
  })

  it('freezes mainnet to the public Operator contract', () => {
    const pins = networkPins('mainnet')
    expect(pins.policyExitDelay).toBe(605_184)
    expect(pins.boardExitDelay).toBe(7_776_256)
    expect(pins.operatorGetInfoNetwork).toBe('bitcoin')
    expect(pins.operatorOrigin).toBe('https://arkade.computer')
    expect(pins.esploraApiUrl).toBe('https://mempool.arkade.sh/api')
    expect(pins.checkpointForfeitPub).toBe('03b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977')
    expect(pins.checkpointTapscript).toBe(
      '039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac',
    )
    expect(pins.checkpointDelaySeconds).toBe(605_184)
    expect(pins.delegateOrigin).toBe('https://delegate.arkade.money')
    expect(pins.arkHrp).toBe('ark')
    expect(pins.absoluteFeeCeilingSats).toBe(20_000)
    expect(pins.feerateCeilingSatPerV).toBe(25)
  })

  it('rejects unknown networks', () => {
    expect(() => networkPins('regtest')).toThrow(/unsupported Vault network/)
  })

  it('maps Guardian mainnet onto the bitcoin SDK network name', () => {
    expect(sdkNetworkName('mainnet')).toBe('bitcoin')
    expect(sdkNetworkName('bitcoin')).toBe('bitcoin')
    expect(sdkNetworkName('mutinynet')).toBe('mutinynet')
    expect(requireSdkNetworkName('mainnet')).toBe('bitcoin')
    expect(sdkNetworkName('regtest')).toBeUndefined()
    expect(() => requireSdkNetworkName('regtest')).toThrow(/unsupported Vault network/)
  })
})

it('uses the release-pinned Operator for explicit networks and the SDK mainnet alias', () => {
  expect(vaultOperatorOrigin()).toBe('https://mutinynet.arkade.sh')
  expect(vaultOperatorOrigin('mutinynet')).toBe('https://mutinynet.arkade.sh')
  expect(vaultOperatorOrigin('mainnet')).toBe('https://arkade.computer')
  expect(vaultOperatorOrigin('bitcoin')).toBe('https://arkade.computer')
  expect(() => vaultOperatorOrigin('regtest')).toThrow(/unsupported Vault network/)
})
