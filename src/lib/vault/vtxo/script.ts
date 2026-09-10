import { CSVMultisigTapscript, MultisigTapscript, VtxoScript, type TapLeafScript } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { SUPPORTED_NETWORKS, type VaultNetwork } from '../constants'
import { networkPins } from '../networkPins'

export const VAULT_POLICY_V1_TYPE = 'vault-policy-v1'

/** Mutinynet product-chosen guardian CSV. 4608 = 9*512 BIP68 seconds. Not arkd's 2048s minimum. */
export const VAULT_POLICY_V1_EXIT_DELAY = 4608n
export const VAULT_POLICY_V1_EXIT_DELAY_UNIT = 'seconds' as const
export const VAULT_POLICY_V1_ARKD_MIN_EXIT_DELAY = 2048n
export const VAULT_POLICY_V1_BIP68_SECONDS_MOD = 512n

/** Compressed Mutinynet Fulmine delegator. The tapleaf stores the x-only form. */
export const VAULT_POLICY_V1_PINNED_DELEGATE = '032903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6a'
export const VAULT_POLICY_V1_DELEGATE_ORIGIN = 'https://delegator.mutinynet.arkade.sh'
export const VAULT_POLICY_V1_DELEGATE_CAPABILITY = 'multi-presigned-signature'

export interface VaultPolicyV1Params {
  userPub: Uint8Array
  vtxoVaultCosignerPub: Uint8Array
  arkdServerPub: Uint8Array
  delegatePub: Uint8Array
  exitDelay: bigint
  exitDelayUnit: typeof VAULT_POLICY_V1_EXIT_DELAY_UNIT
  exitDevicePub: Uint8Array
  exitMode?: 'hardware' | 'device'
  exitHardwarePub?: Uint8Array
  exitRecoveryPub?: Uint8Array
  network?: VaultNetwork
}

function requireXOnly(value: Uint8Array | undefined, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${name} must be a 32-byte x-only pubkey`)
  }
  return value
}

export function pinnedDelegateXOnly(): Uint8Array {
  return hex.decode(VAULT_POLICY_V1_PINNED_DELEGATE.slice(2))
}

/** SDK persist/reload drops optional fields. Infer only from a unique frozen delay. */
function policyPins(params: Pick<VaultPolicyV1Params, 'network' | 'exitDelay'>) {
  if (params.network) return networkPins(params.network)
  const matches = SUPPORTED_NETWORKS.filter(
    (network) => BigInt(networkPins(network).policyExitDelay) === params.exitDelay,
  )
  if (matches.length === 1) return networkPins(matches[0])
  throw new Error(
    `vault-policy-v1 exit delay is frozen at ${networkPins('mutinynet').policyExitDelay} or ${networkPins('mainnet').policyExitDelay} seconds`,
  )
}

export function assertVaultPolicyV1Params(params: VaultPolicyV1Params): VaultPolicyV1Params {
  const userPub = requireXOnly(params.userPub, 'userPub')
  const vtxoVaultCosignerPub = requireXOnly(params.vtxoVaultCosignerPub, 'vtxoVaultCosignerPub')
  const arkdServerPub = requireXOnly(params.arkdServerPub, 'arkdServerPub')
  const delegatePub = requireXOnly(params.delegatePub, 'delegatePub')
  const exitDevicePub = requireXOnly(params.exitDevicePub, 'exitDevicePub')
  if (params.exitMode !== undefined && params.exitMode !== 'hardware' && params.exitMode !== 'device') {
    throw new Error('unsupported Spending recovery mode')
  }
  const exitHardwarePub =
    params.exitMode === 'device' ? undefined : requireXOnly(params.exitHardwarePub, 'exitHardwarePub')
  if (
    params.exitMode === 'device' &&
    (params.exitHardwarePub || params.exitRecoveryPub || !exitDevicePub.every((b, i) => b === userPub[i]))
  ) {
    throw new Error('device recovery requires only the enrolled Spending owner')
  }
  const exitRecoveryPub = params.exitRecoveryPub ? requireXOnly(params.exitRecoveryPub, 'exitRecoveryPub') : undefined

  if (params.exitDelayUnit !== VAULT_POLICY_V1_EXIT_DELAY_UNIT) {
    throw new Error('vault-policy-v1 exit delay unit must be seconds')
  }
  if (params.exitDelay % VAULT_POLICY_V1_BIP68_SECONDS_MOD !== 0n) {
    throw new Error('vault-policy-v1 exit delay must be a BIP68 seconds multiple of 512')
  }
  const pins = policyPins(params)
  if (params.exitDelay < BigInt(pins.arkdMinExitDelay)) {
    throw new Error('vault-policy-v1 exit delay is below the arkd minimum')
  }
  if (params.exitDelay !== BigInt(pins.policyExitDelay)) {
    throw new Error(`vault-policy-v1 exit delay is frozen at ${pins.policyExitDelay} seconds`)
  }
  const pinned = hex.decode(pins.delegatePub.slice(2))
  if (delegatePub.length !== pinned.length || !delegatePub.every((b, i) => b === pinned[i])) {
    throw new Error('delegatePub must be the pinned public delegate')
  }

  return {
    userPub,
    vtxoVaultCosignerPub,
    arkdServerPub,
    delegatePub,
    network: pins.network,
    exitDelay: BigInt(pins.policyExitDelay),
    exitDelayUnit: VAULT_POLICY_V1_EXIT_DELAY_UNIT,
    exitDevicePub,
    ...(params.exitMode ? { exitMode: params.exitMode } : {}),
    ...(exitHardwarePub ? { exitHardwarePub } : {}),
    ...(exitRecoveryPub ? { exitRecoveryPub } : {}),
  }
}

/**
 * vault-policy-v1 tap tree: 3-key collaborative spend/intent
 * [user, VTXO VaultCosigner, Arkade Operator], exactly one guardian CSV
 * exit, 4-key delegate-forfeit [user, VTXO VaultCosigner, pinned public
 * delegate, Arkade Operator]. The required VaultCosigner independently
 * enforces the Vault Program. The emulator is not a tree signer.
 */
export class VaultPolicyV1Script extends VtxoScript {
  readonly params: VaultPolicyV1Params
  readonly forfeitScript: string
  readonly exitScript: string
  readonly delegateScript: string

  constructor(params: VaultPolicyV1Params) {
    const typed = assertVaultPolicyV1Params(params)
    const forfeit = MultisigTapscript.encode({
      pubkeys: [typed.userPub, typed.vtxoVaultCosignerPub, typed.arkdServerPub],
    })
    const exit = CSVMultisigTapscript.encode({
      timelock: { type: typed.exitDelayUnit, value: typed.exitDelay },
      pubkeys:
        typed.exitMode === 'device'
          ? [typed.exitDevicePub]
          : typed.exitRecoveryPub
            ? [typed.exitHardwarePub!, typed.exitRecoveryPub]
            : [typed.exitDevicePub, typed.exitHardwarePub!],
    })
    const delegate = MultisigTapscript.encode({
      pubkeys: [typed.userPub, typed.vtxoVaultCosignerPub, typed.delegatePub, typed.arkdServerPub],
    })
    super([forfeit.script, exit.script, delegate.script])
    this.params = typed
    this.forfeitScript = hex.encode(forfeit.script)
    this.exitScript = hex.encode(exit.script)
    this.delegateScript = hex.encode(delegate.script)
  }

  /** Collaborative spend/intent leaf. SDK-native name matches DefaultVtxo.forfeit(). */
  forfeit(): TapLeafScript {
    return this.findLeaf(this.forfeitScript)
  }

  exit(): TapLeafScript {
    return this.findLeaf(this.exitScript)
  }

  delegate(): TapLeafScript {
    return this.findLeaf(this.delegateScript)
  }
}
