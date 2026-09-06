import { CSVMultisigTapscript, MultisigTapscript, VtxoScript, type TapLeafScript } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { requireSupportedVaultNetwork, type VaultNetwork } from '../constants'
import { networkPins } from '../networkPins'
import { defaultSpendingPolicy, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'

// Light uses its own descriptor and policy domain; generic SDK selection remains disabled.
export const LIGHT_PROFILE = 'vaulted-light-v1' as const
export const LIGHT_PROGRAM = 'vault-light-policy-v1' as const
export const LIGHT_POLICY_SCHEMA = 'vault-light-spending-policy-v1' as const
export const LIGHT_DESCRIPTOR_SCHEMA = 'vaulted-light/descriptor-v1' as const
export type LightPolicy = Omit<SpendingPolicy, 'program' | 'schema'> & {
  program: typeof LIGHT_PROGRAM
  schema: typeof LIGHT_POLICY_SCHEMA
}

export function defaultLightPolicy(network: VaultNetwork): LightPolicy {
  return { ...defaultSpendingPolicy(network), program: LIGHT_PROGRAM, schema: LIGHT_POLICY_SCHEMA }
}

export function validateLightPolicy(value: unknown, network: VaultNetwork): LightPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Light policy required')
  const policy = value as Record<string, unknown>
  if (policy.program !== LIGHT_PROGRAM || policy.schema !== LIGHT_POLICY_SCHEMA) {
    throw new Error('unsupported Light policy')
  }
  const base = defaultSpendingPolicy(network)
  const validated = validateSpendingPolicy({ ...policy, program: base.program, schema: base.schema }, network)
  return { ...validated, program: LIGHT_PROGRAM, schema: LIGHT_POLICY_SCHEMA }
}

export function lightPolicyDigest(value: LightPolicy, network: VaultNetwork): string {
  return hex.encode(sha256(new TextEncoder().encode(JSON.stringify(validateLightPolicy(value, network)))))
}

export interface LightScriptParams {
  network: VaultNetwork
  ownerPub: string
  cosignerPub: string
  operatorPub: string
  exitDelaySeconds: number
}

export function requireLightPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Light key must be x-only hex')
  schnorr.utils.lift_x(BigInt(`0x${value}`))
  return value
}

export function validateLightScriptParams(params: LightScriptParams): LightScriptParams {
  requireSupportedVaultNetwork(params.network)
  const pins = networkPins(params.network)
  const ownerPub = requireLightPublicKey(params.ownerPub)
  const cosignerPub = requireLightPublicKey(params.cosignerPub)
  const operatorPub = requireLightPublicKey(params.operatorPub)
  if (new Set([ownerPub, cosignerPub, operatorPub]).size !== 3) throw new Error('Light signing keys must be distinct')
  if (operatorPub !== pins.operatorSignerPub.slice(2)) throw new Error('Light Operator does not match network pin')
  if (params.exitDelaySeconds !== pins.policyExitDelay) throw new Error('Light exit delay does not match network pin')
  return { network: params.network, ownerPub, cosignerPub, operatorPub, exitDelaySeconds: params.exitDelaySeconds }
}

/** Two application approvals plus the stock Operator; owner-only delayed exit. */
export class LightScript extends VtxoScript {
  readonly params: LightScriptParams
  readonly spendScript: string
  readonly exitScript: string

  constructor(params: LightScriptParams) {
    const valid = validateLightScriptParams(params)
    const spend = MultisigTapscript.encode({
      pubkeys: [valid.ownerPub, valid.cosignerPub, valid.operatorPub].map((key) => hex.decode(key)),
    })
    const exit = CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: BigInt(valid.exitDelaySeconds) },
      pubkeys: [hex.decode(valid.ownerPub)],
    })
    super([spend.script, exit.script])
    this.params = Object.freeze(valid)
    this.spendScript = hex.encode(spend.script)
    this.exitScript = hex.encode(exit.script)
  }

  forfeit(): TapLeafScript {
    return this.findLeaf(this.spendScript)
  }

  exit(): TapLeafScript {
    return this.findLeaf(this.exitScript)
  }
}

export interface LightDescriptor {
  schema: typeof LIGHT_DESCRIPTOR_SCHEMA
  profile: typeof LIGHT_PROFILE
  program: typeof LIGHT_PROGRAM
  vaultId: string
  network: VaultNetwork
  ownerPub: string
  cosignerPub: string
  operatorPub: string
  exitDelaySeconds: number
  spendingPolicy: LightPolicy
  spendingPolicyDigest: string
  scriptPubKey: string
}

export function buildLightDescriptor(
  input: LightScriptParams & { vaultId: string; spendingPolicy: LightPolicy },
): LightDescriptor {
  if (!/^[0-9a-f]{64}$/.test(input.vaultId)) throw new Error('Light vault ID must be 32-byte hex')
  const params = validateLightScriptParams(input)
  const policy = validateLightPolicy(input.spendingPolicy, params.network)
  const script = new LightScript(params)
  return {
    schema: LIGHT_DESCRIPTOR_SCHEMA,
    profile: LIGHT_PROFILE,
    program: LIGHT_PROGRAM,
    vaultId: input.vaultId,
    ...params,
    spendingPolicy: policy,
    spendingPolicyDigest: lightPolicyDigest(policy, params.network),
    scriptPubKey: hex.encode(script.pkScript),
  }
}

export function validateLightDescriptor(value: unknown): LightDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Light descriptor required')
  const supplied = value as LightDescriptor
  const rebuilt = buildLightDescriptor(supplied)
  const keys = Object.keys(rebuilt) as (keyof LightDescriptor)[]
  if (
    Object.keys(supplied).length !== keys.length ||
    keys.some((key) =>
      key === 'spendingPolicy'
        ? lightPolicyDigest(supplied.spendingPolicy, supplied.network) !== rebuilt.spendingPolicyDigest
        : supplied[key] !== rebuilt[key],
    )
  ) {
    throw new Error('Light descriptor does not match its program')
  }
  return rebuilt
}

export function lightDescriptorDigest(value: LightDescriptor): string {
  return hex.encode(sha256(new TextEncoder().encode(JSON.stringify(validateLightDescriptor(value)))))
}
