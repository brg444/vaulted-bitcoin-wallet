import { contractHandlers, type ContractHandler } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { isSupportedVaultNetwork } from '../constants'
import { VAULT_POLICY_V1_TYPE, VaultPolicyV1Script, type VaultPolicyV1Params } from './script'

function publicKey(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`${name} is required`)
  let decoded: Uint8Array
  try {
    decoded = hex.decode(value)
  } catch {
    throw new Error(`${name} must be hex`)
  }
  if (decoded.length !== 32) throw new Error(`${name} must be a 32-byte x-only pubkey`)
  return decoded
}

export const VaultPolicyV1ContractHandler: ContractHandler<VaultPolicyV1Params, VaultPolicyV1Script> = {
  type: VAULT_POLICY_V1_TYPE,

  createScript(params) {
    return new VaultPolicyV1Script(this.deserializeParams(params))
  },

  serializeParams(params) {
    return {
      userPub: hex.encode(params.userPub),
      vtxoVaultCosignerPub: hex.encode(params.vtxoVaultCosignerPub),
      arkdServerPub: hex.encode(params.arkdServerPub),
      delegatePub: hex.encode(params.delegatePub),
      exitDelay: params.exitDelay.toString(),
      exitDelayUnit: params.exitDelayUnit,
      exitDevicePub: hex.encode(params.exitDevicePub),
      ...(params.exitMode ? { exitMode: params.exitMode } : {}),
      ...(params.exitHardwarePub ? { exitHardwarePub: hex.encode(params.exitHardwarePub) } : {}),
      ...(params.network ? { network: params.network } : {}),
      ...(params.exitRecoveryPub ? { exitRecoveryPub: hex.encode(params.exitRecoveryPub) } : {}),
    }
  },

  deserializeParams(params) {
    let exitDelay: bigint
    try {
      exitDelay = BigInt(params.exitDelay)
    } catch {
      throw new Error('exitDelay must be an integer')
    }
    const network = isSupportedVaultNetwork(params.network) ? params.network : undefined
    return {
      userPub: publicKey(params.userPub, 'userPub'),
      vtxoVaultCosignerPub: publicKey(params.vtxoVaultCosignerPub, 'vtxoVaultCosignerPub'),
      arkdServerPub: publicKey(params.arkdServerPub, 'arkdServerPub'),
      delegatePub: publicKey(params.delegatePub, 'delegatePub'),
      exitDelay,
      exitDelayUnit: params.exitDelayUnit as VaultPolicyV1Params['exitDelayUnit'],
      exitDevicePub: publicKey(params.exitDevicePub, 'exitDevicePub'),
      ...(params.exitMode ? { exitMode: params.exitMode as VaultPolicyV1Params['exitMode'] } : {}),
      ...(params.exitHardwarePub ? { exitHardwarePub: publicKey(params.exitHardwarePub, 'exitHardwarePub') } : {}),
      ...(network ? { network } : {}),
      ...(params.exitRecoveryPub ? { exitRecoveryPub: publicKey(params.exitRecoveryPub, 'exitRecoveryPub') } : {}),
    }
  },

  // Vault funds are selected only by the explicit VaultCosigner-authorized
  // path. Generic SDK send, renewal and sweep must never select them.
  selectPath: () => null,
  getAllSpendingPaths: () => [],
  getSpendablePaths: () => [],
  isGenericallySpendable: () => false,
}

/** Register in both page and worker bundles. Safe under repeated module setup/HMR. */
export function registerVaultPolicyV1ContractHandler() {
  if (!contractHandlers.has(VAULT_POLICY_V1_TYPE)) {
    contractHandlers.register(VaultPolicyV1ContractHandler)
  }
}

export function vaultPolicyV1Contract(script: VaultPolicyV1Script, address: string) {
  return {
    type: VAULT_POLICY_V1_TYPE,
    label: 'Spending',
    params: VaultPolicyV1ContractHandler.serializeParams(script.params),
    script: hex.encode(script.pkScript),
    address,
    state: 'active' as const,
  }
}
