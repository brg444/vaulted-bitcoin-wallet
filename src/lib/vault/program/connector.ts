import { hex } from '@scure/base'
import { p2tr, p2wpkh } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import { requireProtectionTierMatchesRecovery, type ProtectionTier } from '../protectionTier'
import { vaultAddressNetwork } from '../addressNetwork'
import { checksigScript, xOnlyFromCompressed } from '../savingsTree'
import { contextInternalKey } from './context'
import { exactPacketOutputPrefix } from './packet'
import { OP, concat, pushData, pushInt, collaborativeWitnessBytes } from './script'
import { buildVaultProgramFamily, tapTreeFromScripts } from './trees'
import { tweakPair } from './tweak'

// Selected for new connector enrollments; existing vaults retain their contract.
export const CONNECTOR_PROGRAM = 'savings-connector-v1'
export const CONNECTOR_TEMPLATE = 'phone-connector-recovery-savings-v1'
export const CONNECTOR_RESERVE_SATS = 1000
export const CONNECTOR_OUTPUT = { recipient: 0, reserve: 1, anchor: 2, packet: 3, change: 4 } as const

export interface ConnectorRules {
  connectorScript: Uint8Array
  witnessBytes: number
  absoluteFeeCapSats: number
  feerateCapSatPerV: number
}

export type ConnectorKind = 'p2tr' | 'p2wpkh'

const X = { inputScript: 0xca, toAlt: 0x6b, fromAlt: 0x6c, if: 0x63, endif: 0x68, boolOr: 0x9b }

export function buildConnectorProgram(r: ConnectorRules): Uint8Array {
  if (
    !(r.connectorScript.length === 22 && r.connectorScript[0] === 0 && r.connectorScript[1] === 20) &&
    (r.connectorScript.length !== 34 ||
      r.connectorScript[0] !== 0x51 ||
      r.connectorScript[1] !== 32 ||
      !secp256k1.utils.isValidPublicKey(new Uint8Array([2, ...r.connectorScript.slice(2)]), true))
  )
    throw new Error('connector native SegWit or Taproot script required')
  if (
    !Number.isSafeInteger(r.witnessBytes) ||
    r.witnessBytes < 1 ||
    r.witnessBytes > 10000 ||
    !Number.isSafeInteger(r.absoluteFeeCapSats) ||
    r.absoluteFeeCapSats < 0 ||
    r.absoluteFeeCapSats > 100000 ||
    !Number.isSafeInteger(r.feerateCapSatPerV) ||
    r.feerateCapSatPerV < 1 ||
    r.feerateCapSatPerV > 100
  )
    throw new Error('invalid connector fee policy')
  let prefix: Uint8Array = new Uint8Array()
  for (let attempt = 0; attempt < 8; attempt++) {
    const chunks: Uint8Array[] = []
    const op = (...values: number[]) => chunks.push(Uint8Array.from(values))
    const num = (n: number) => chunks.push(pushInt(n))
    const data = (b: Uint8Array) => chunks.push(pushData(b))
    const equal = (opcode: number, n: number) => {
      op(opcode)
      num(n)
      op(OP.EQUALVERIFY)
    }
    const script = (opcode: number, index: number, b: Uint8Array) => {
      num(index)
      op(opcode)
      num(b[0] === 0x51 ? 1 : 0)
      op(OP.EQUALVERIFY)
      data(b.slice(2))
      op(OP.EQUALVERIFY)
    }
    const withChange = () => {
      op(OP.INSPECTNUMOUTPUTS)
      num(5)
      op(OP.EQUAL, X.if)
    }
    data(new TextEncoder().encode(CONNECTOR_PROGRAM))
    op(OP.DROP)
    equal(OP.INSPECTVERSION, 2)
    equal(OP.INSPECTLOCKTIME, 0)
    equal(OP.INSPECTNUMINPUTS, 2)
    op(OP.INSPECTNUMOUTPUTS, OP.DUP)
    num(4)
    op(OP.EQUAL, OP.SWAP)
    num(5)
    op(OP.EQUAL, X.boolOr, OP.VERIFY)
    for (const i of [0, 1]) {
      num(i)
      equal(OP.INSPECTINPUTSEQUENCE, 0xfffffffd)
    }
    script(X.inputScript, 1, r.connectorScript)
    script(OP.INSPECTOUTPUTSCRIPTPUBKEY, 1, r.connectorScript)
    script(OP.INSPECTOUTPUTSCRIPTPUBKEY, 2, hex.decode('51024e73'))
    withChange()
    num(0)
    op(X.inputScript, X.toAlt)
    num(4)
    op(OP.INSPECTOUTPUTSCRIPTPUBKEY, X.fromAlt, OP.EQUALVERIFY, OP.EQUALVERIFY)
    num(4)
    op(OP.INSPECTOUTPUTVALUE)
    num(330)
    op(OP.GREATERTHANOREQUAL, OP.VERIFY, X.endif)
    num(1)
    equal(OP.INSPECTINPUTVALUE, 1000)
    num(1)
    equal(OP.INSPECTOUTPUTVALUE, 1000)
    num(2)
    equal(OP.INSPECTOUTPUTVALUE, 240)
    num(3)
    equal(OP.INSPECTOUTPUTVALUE, 0)
    num(0)
    op(OP.INSPECTOUTPUTVALUE)
    num(294)
    op(OP.GREATERTHANOREQUAL, OP.VERIFY)
    num(1)
    op(OP.INSPECTPACKET, OP.VERIFY)
    data(prefix)
    op(OP.SWAP, OP.CAT, OP.SHA256)
    num(3)
    op(OP.INSPECTOUTPUTSCRIPTPUBKEY)
    num(-1)
    op(OP.EQUALVERIFY, OP.EQUALVERIFY)
    num(0)
    op(OP.INSPECTINPUTVALUE)
    for (const i of [0, 2]) {
      num(i)
      op(OP.INSPECTOUTPUTVALUE, OP.SUB)
    }
    withChange()
    num(4)
    op(OP.INSPECTOUTPUTVALUE, OP.SUB, X.endif)
    op(OP.DUP)
    num(0)
    op(OP.GREATERTHANOREQUAL, OP.VERIFY, OP.DUP)
    num(r.absoluteFeeCapSats)
    op(OP.LESSTHANOREQUAL, OP.VERIFY, OP.TXWEIGHT)
    num(r.witnessBytes)
    op(OP.ADD)
    num(3)
    op(OP.ADD)
    num(4)
    op(OP.DIV)
    num(r.feerateCapSatPerV)
    op(OP.MUL, OP.LESSTHANOREQUAL)
    const result = concat(...chunks)
    const next = exactPacketOutputPrefix(result.length, [])
    if (hex.encode(next) === hex.encode(prefix)) return result
    prefix = next
  }
  throw new Error('connector packet envelope did not converge')
}

export function buildConnectorFamily(
  input: Parameters<typeof buildVaultProgramFamily>[0] & { connectorType: ConnectorKind },
) {
  if (input.templateVersion && input.templateVersion !== CONNECTOR_TEMPLATE)
    throw new Error('connector template mismatch')
  if (input.network !== 'mainnet' && input.network !== 'mutinynet') throw new Error('unsupported connector network')
  const selected = { ...input, templateVersion: CONNECTOR_TEMPLATE, serverFreeClawback: true }
  const base = buildVaultProgramFamily(selected)
  if (input.connectorType !== 'p2tr' && input.connectorType !== 'p2wpkh') throw new Error('unsupported connector type')
  const connector =
    input.connectorType === 'p2tr'
      ? p2tr(xOnlyFromCompressed(input.hardwarePub), undefined, vaultAddressNetwork(input.network))
      : p2wpkh(hex.decode(input.hardwarePub), vaultAddressNetwork(input.network))
  // Lower bound, not an ECDSA size estimate: a longer signature cannot weaken
  // the fee-rate ceiling. Taproot ALL adds one byte to DEFAULT's witness.
  const connectorWitnessBytes = input.connectorType === 'p2tr' ? 66 : 45
  const internal = contextInternalKey({ vaultId: input.vaultId, claimant: '', templateVersion: CONNECTOR_TEMPLATE })
  const makeNormal = (normal: Uint8Array) => {
    const tree = p2tr(
      internal,
      tapTreeFromScripts([normal, ...base.savings.initiate]),
      vaultAddressNetwork(input.network),
      true,
    )
    const leaves = tree.leaves as { script: Uint8Array; controlBlock?: Uint8Array }[] | undefined
    const control = leaves?.find((leaf) => hex.encode(leaf.script) === hex.encode(normal))?.controlBlock
    if (!control) throw new Error('connector normal proof missing')
    return { ...tree, normal, control }
  }
  const preliminary = makeNormal(
    checksigScript([input.phonePub, input.vaultCosignerBase, input.arkadeCosignerBase].map(xOnlyFromCompressed)),
  )
  const rules: ConnectorRules = {
    connectorScript: connector.script,
    witnessBytes: collaborativeWitnessBytes(preliminary.normal, preliminary.control) + connectorWitnessBytes,
    absoluteFeeCapSats: input.absoluteFeeCapSats,
    feerateCapSatPerV: input.feerateCapSatPerV,
  }
  const program = buildConnectorProgram(rules)
  const pair = tweakPair(input.vaultCosignerBase, input.arkadeCosignerBase, program)
  const roles = [
    input.phonePub,
    input.hardwarePub,
    input.vaultCosignerBase,
    input.arkadeCosignerBase,
    ...(input.recoveryPub ? [input.recoveryPub] : []),
    pair.vault,
    pair.arkade,
    ...Object.values(base.initiateTweaks).flatMap((p) => [p!.vault, p!.arkade]),
    ...Object.values(base.pendingTweaks).flatMap((p) => [p.vault, p.arkade]),
  ].map((p) => hex.encode(xOnlyFromCompressed(p)))
  if (new Set(roles).size !== roles.length) throw new Error('connector family roles must be distinct')
  const savings = makeNormal(checksigScript([input.phonePub, pair.vault, pair.arkade].map(xOnlyFromCompressed)))
  if (collaborativeWitnessBytes(savings.normal, savings.control) + connectorWitnessBytes !== rules.witnessBytes)
    throw new Error('connector witness shape changed')
  return {
    ...base,
    savings: { ...base.savings, ...savings, admin: savings.normal },
    connector,
    rules,
    program,
    normalTweaks: pair,
  }
}

export interface ConnectorOrigin {
  publicKey: Uint8Array
  fingerprint: number
  path: number[]
}

export function connectorEnrollmentDigest(
  input: Parameters<typeof buildConnectorFamily>[0] & {
    protectionTier: ProtectionTier
    spendingPolicy: SpendingPolicy
  },
  origin: ConnectorOrigin,
): string {
  if (input.network !== 'mainnet' && input.network !== 'mutinynet') throw new Error('unsupported connector network')
  requireProtectionTierMatchesRecovery(input.protectionTier, input.recoveryPub)
  const policy = validateSpendingPolicy(input.spendingPolicy, input.network)
  if (policy.absoluteFeeCapSats !== input.absoluteFeeCapSats || policy.feerateCapSatPerV !== input.feerateCapSatPerV)
    throw new Error('connector fee policy mismatch')
  const f = buildConnectorFamily(input)
  if (hex.encode(origin.publicKey) !== hex.encode(hex.decode(input.hardwarePub)))
    throw new Error('hardware origin mismatch')
  const path = origin.path
  const coin = input.network === 'mainnet' ? 0x80000000 : 0x80000001
  const standardPurpose = path[0] === 0x80000054 || path[0] === 0x80000056
  const standardPath =
    path.length === 5 &&
    path[0] === (input.connectorType === 'p2wpkh' ? 0x80000054 : 0x80000056) &&
    path[1] === coin &&
    path[2] >= 0x80000000 &&
    path[3] <= 1 &&
    path[4] < 0x80000000
  if (
    !Number.isInteger(origin.fingerprint) ||
    origin.fingerprint < 0 ||
    origin.fingerprint > 0xffffffff ||
    path.length < 1 ||
    path.length > 255 ||
    path.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff) ||
    (standardPurpose && !standardPath)
  )
    throw new Error('hardware origin network or path mismatch')
  const canonical = (s: string) => hex.encode(hex.decode(s))
  const fields = [
    'arkade-vault/connector-enrollment-v1',
    CONNECTOR_TEMPLATE,
    input.vaultId,
    input.network,
    input.protectionTier,
    canonical(input.phonePub),
    canonical(input.hardwarePub),
    input.recoveryPub ? canonical(input.recoveryPub) : '',
    canonical(input.phoneDirectP256),
    canonical(input.vaultCosignerBase),
    canonical(input.arkadeCosignerBase),
    spendingPolicyDigest(policy, input.network),
    hex.encode(f.program),
    hex.encode(f.savings.script),
    hex.encode(f.connector.script),
    origin.fingerprint.toString(16).padStart(8, '0'),
    path.join('/'),
  ]
  for (const role of input.recoveryPub
    ? (['phone', 'hardware', 'recovery'] as const)
    : (['phone', 'hardware'] as const)) {
    const key = `savings-${role}` as const
    fields.push(
      role,
      hex.encode(f.pending[key].script),
      hex.encode(f.quarantine[key].script),
      hex.encode(f.initiateAuth[key]),
      hex.encode(f.clawbackAuth[key]),
    )
  }
  const chunks = fields.flatMap((field) => {
    const data = new TextEncoder().encode(field)
    const size = new Uint8Array(4)
    new DataView(size.buffer).setUint32(0, data.length, false)
    return [size, data]
  })
  return hex.encode(sha256(concat(...chunks)))
}
