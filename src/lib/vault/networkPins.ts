import { requireSupportedVaultNetwork, type VaultNetwork } from './constants'

export interface VaultNetworkPins {
  network: VaultNetwork
  operatorGetInfoNetwork: 'mutinynet' | 'bitcoin'
  operatorOrigin: string
  operatorSignerPub: string
  checkpointForfeitPub: string
  checkpointTapscript: string
  checkpointDelaySeconds: number
  emulatorOrigin: string
  emulatorSignerPub: string
  policyExitDelay: number
  boardExitDelay: number
  arkdMinExitDelay: number
  delegatePub: string
  delegateOrigin: string
  sdkNetwork: 'mutinynet' | 'bitcoin'
  arkHrp: 'tark' | 'ark'
  /** SDK `ESPLORA_URL` for boarding UTXO watch and onchain coins. */
  esploraApiUrl: string
  absoluteFeeCeilingSats: number
  feerateCeilingSatPerV: number
}

const PINS: Record<VaultNetwork, VaultNetworkPins> = {
  mutinynet: {
    network: 'mutinynet',
    operatorGetInfoNetwork: 'mutinynet',
    operatorOrigin: 'https://mutinynet.arkade.sh',
    operatorSignerPub: '03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a',
    checkpointForfeitPub: '02dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0b',
    checkpointTapscript: '03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac',
    checkpointDelaySeconds: 4096,
    emulatorOrigin: 'https://emulator.mutinynet.arkade.sh',
    emulatorSignerPub: '03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a',
    policyExitDelay: 4608,
    boardExitDelay: 604_672,
    arkdMinExitDelay: 2048,
    delegatePub: '032903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6a',
    delegateOrigin: 'https://delegator.mutinynet.arkade.sh',
    sdkNetwork: 'mutinynet',
    arkHrp: 'tark',
    esploraApiUrl: 'https://mempool.mutinynet.arkade.sh/api',
    absoluteFeeCeilingSats: 5_000,
    feerateCeilingSatPerV: 10,
  },
  mainnet: {
    network: 'mainnet',
    operatorGetInfoNetwork: 'bitcoin',
    operatorOrigin: 'https://arkade.computer',
    operatorSignerPub: '038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c',
    checkpointForfeitPub: '03b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977',
    checkpointTapscript: '039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac',
    checkpointDelaySeconds: 605_184,
    emulatorOrigin: 'https://emulator.arkade.computer',
    emulatorSignerPub: '0239c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e',
    policyExitDelay: 605_184,
    boardExitDelay: 7_776_256,
    arkdMinExitDelay: 605_184,
    delegatePub: '026d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6',
    delegateOrigin: 'https://delegate.arkade.money',
    sdkNetwork: 'bitcoin',
    arkHrp: 'ark',
    esploraApiUrl: 'https://mempool.arkade.sh/api',
    absoluteFeeCeilingSats: 20_000,
    feerateCeilingSatPerV: 25,
  },
}

export function networkPins(network: unknown): VaultNetworkPins {
  return PINS[requireSupportedVaultNetwork(network)]
}

/** Guardian `mainnet` is arkd `bitcoin`. Mutinynet keeps the same name. */
export function sdkNetworkName(network: unknown): 'bitcoin' | 'mutinynet' | undefined {
  if (network === 'bitcoin' || network === 'mainnet') return 'bitcoin'
  if (network === 'mutinynet') return 'mutinynet'
  return undefined
}

export function requireSdkNetworkName(network: unknown): 'bitcoin' | 'mutinynet' {
  const name = sdkNetworkName(network)
  if (!name) throw new Error(`unsupported Vault network ${String(network || '')}`)
  return name
}
