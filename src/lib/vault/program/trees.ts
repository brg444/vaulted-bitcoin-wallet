import { hex } from '@scure/base'
import { p2tr } from '@scure/btc-signer'
import { vaultAddressNetwork } from '../addressNetwork'
import { hexToBytes } from '../hex'
import { TAPROOT_NUMS_XONLY, checksigScript, csvChecksigScript, xOnlyFromCompressed } from '../savingsTree'
import { FORBIDDEN_PUBLIC_KEY_2G, FORBIDDEN_PUBLIC_KEY_G } from '../setupPlan'
import { SAVINGS_TEMPLATE, type Claimant, type FamilyKey, PROGRAM_CSV } from './constants'
import { contextInternalKey } from './context'
import { buildTransitionScript, clawbackWitnessBytes, collaborativeWitnessBytes, initiateWitnessBytes } from './script'
import { tweakPair } from './tweak'

const UNSPENDABLE_PADDING = new Uint8Array([0x6a])

export type TreeRole = 'quarantine' | 'pending' | 'normal'

export function quarantineGuardians(claimant: Claimant, hasRecovery = true): Claimant[] {
  if (claimant === 'phone') return hasRecovery ? ['hardware', 'recovery'] : ['hardware']
  if (claimant === 'hardware') return hasRecovery ? ['phone', 'recovery'] : ['phone']
  return ['phone', 'hardware']
}

export function pendingGuardians(claimant: Claimant, hasRecovery = true): Claimant[] {
  const roles: Claimant[] = hasRecovery ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']
  return roles.filter((role) => role !== claimant)
}

export function pendingDelay(claimant: Claimant): number {
  if (claimant === 'hardware') return PROGRAM_CSV.hardware
  if (claimant === 'phone') return PROGRAM_CSV.phone
  return PROGRAM_CSV.recovery
}

type ScriptLeaf = { script: Uint8Array }

/** Pairing matches btcd AssembleTaprootScriptTree. */
export function tapTreeFromScripts(scripts: Uint8Array[]): ScriptLeaf | ScriptLeaf[] {
  if (scripts.length === 0) throw new Error('no leaves')
  if (scripts.length === 1) return { script: scripts[0] }
  const leaves: ScriptLeaf[] = scripts.map((script) => ({ script }))
  const branches: unknown[] = []
  for (let i = 0; i < leaves.length; i += 2) {
    if (i === leaves.length - 1) {
      branches[branches.length - 1] = [branches[branches.length - 1], leaves[i]]
      continue
    }
    branches.push([leaves[i], leaves[i + 1]])
  }
  while (branches.length > 1) {
    const left = branches.shift()
    const right = branches.shift()
    branches.push([left, right])
  }
  return branches[0] as ScriptLeaf[]
}

function requireDistinct(keys: Uint8Array[], name: string) {
  const seen = new Set<string>()
  for (const key of keys) {
    const hexKey = hex.encode(key)
    if (seen.has(hexKey)) throw new Error(`${name} keys must be x-only distinct`)
    seen.add(hexKey)
  }
}

const FORBIDDEN_XONLY = new Set([
  TAPROOT_NUMS_XONLY,
  hex.encode(xOnlyFromCompressed(FORBIDDEN_PUBLIC_KEY_G)),
  hex.encode(xOnlyFromCompressed(FORBIDDEN_PUBLIC_KEY_2G)),
])

function assertRoleSet(pubs: string[], name: string) {
  const xonlys = pubs.map(xOnlyFromCompressed)
  requireDistinct(xonlys, name)
  for (const pub of xonlys) {
    if (FORBIDDEN_XONLY.has(hex.encode(pub))) throw new Error('family key is a forbidden point')
  }
}

function controlOf(
  payment: { leaves?: { script: Uint8Array; controlBlock?: Uint8Array }[] },
  script: Uint8Array,
): Uint8Array {
  const leaf = payment.leaves?.find((item) => hex.encode(item.script) === hex.encode(script))
  if (!leaf?.controlBlock) throw new Error('leaf control block required')
  return leaf.controlBlock
}

export function buildQuarantine(input: {
  vaultId: string
  claimant: Claimant
  phonePub: string
  hardwarePub: string
  recoveryPub?: string
  network: string
  templateVersion?: string
}) {
  const pubs: Record<string, Uint8Array> = {
    phone: xOnlyFromCompressed(input.phonePub),
    hardware: xOnlyFromCompressed(input.hardwarePub),
  }
  if (input.recoveryPub) pubs.recovery = xOnlyFromCompressed(input.recoveryPub)
  requireDistinct(Object.values(pubs), 'user')
  const names = quarantineGuardians(input.claimant, Boolean(input.recoveryPub))
  const script = checksigScript(names.map((name) => pubs[name]))
  const internal = contextInternalKey({
    vaultId: input.vaultId,
    claimant: input.claimant,
    templateVersion: input.templateVersion,
  })
  const payment = p2tr(internal, { script }, vaultAddressNetwork(input.network), true)
  if (!payment.address) throw new Error('quarantine address required')
  return {
    role: 'quarantine' as const,
    address: payment.address,
    script: payment.script,
    tapInternalKey: payment.tapInternalKey,
    tapLeafScript: payment.tapLeafScript,
    admin: script,
    guardians: names,
  }
}

export function buildPending(input: {
  vaultId: string
  claimant: Claimant
  phonePub: string
  hardwarePub: string
  recoveryPub?: string
  vaultTweak: string
  arkadeTweak: string
  network: string
  templateVersion?: string
  serverFreeClawback?: boolean
}) {
  const pubs: Record<string, Uint8Array> = {
    phone: xOnlyFromCompressed(input.phonePub),
    hardware: xOnlyFromCompressed(input.hardwarePub),
  }
  if (input.recoveryPub) pubs.recovery = xOnlyFromCompressed(input.recoveryPub)
  const vault = xOnlyFromCompressed(input.vaultTweak)
  const arkade = xOnlyFromCompressed(input.arkadeTweak)
  requireDistinct([...Object.values(pubs), vault, arkade], 'pending')
  const claim = csvChecksigScript(pendingDelay(input.claimant), pubs[input.claimant])
  const clawbacks = pendingGuardians(input.claimant, Boolean(input.recoveryPub)).map((guardian) =>
    checksigScript([pubs[guardian], vault, arkade]),
  )
  const scripts = [claim, ...clawbacks]
  if (input.serverFreeClawback) {
    const guardians = pendingGuardians(input.claimant, Boolean(input.recoveryPub)).map((name) => pubs[name])
    scripts.push(checksigScript(guardians))
  }
  scripts.push(UNSPENDABLE_PADDING)
  const internal = contextInternalKey({
    vaultId: input.vaultId,
    claimant: input.claimant,
    templateVersion: input.templateVersion,
  })
  const payment = p2tr(internal, tapTreeFromScripts(scripts), vaultAddressNetwork(input.network), true)
  if (!payment.address) throw new Error('pending address required')
  return {
    role: 'pending' as const,
    address: payment.address,
    script: payment.script,
    tapInternalKey: payment.tapInternalKey,
    tapLeafScript: payment.tapLeafScript,
    leaves: payment.leaves,
    claim,
    clawbacks,
    guardianExit: input.serverFreeClawback
      ? checksigScript(pendingGuardians(input.claimant, Boolean(input.recoveryPub)).map((name) => pubs[name]))
      : undefined,
    delay: pendingDelay(input.claimant),
  }
}

export type InitiateTweaks = {
  phone: { vault: string; arkade: string }
  hardware: { vault: string; arkade: string }
  recovery?: { vault: string; arkade: string }
}

export function buildNormal(input: {
  vaultId: string
  phonePub: string
  hardwarePub: string
  recoveryPub?: string
  initiate: InitiateTweaks
  network: string
  templateVersion?: string
}) {
  const phone = xOnlyFromCompressed(input.phonePub)
  const hardware = xOnlyFromCompressed(input.hardwarePub)
  const recovery = input.recoveryPub ? xOnlyFromCompressed(input.recoveryPub) : undefined
  const claimants = (recovery ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']) as Claimant[]
  const tweaks: Uint8Array[] = []
  for (const claimant of claimants) {
    const pair = input.initiate[claimant]
    if (!pair) throw new Error(`missing ${claimant} initiate tweaks`)
    tweaks.push(xOnlyFromCompressed(pair.vault), xOnlyFromCompressed(pair.arkade))
  }
  requireDistinct([phone, hardware, ...(recovery ? [recovery] : []), ...tweaks], 'normal')

  const admin = checksigScript([phone, hardware])
  const role = { phone, hardware, recovery }
  const initiate = claimants.map((claimant) => {
    const pair = input.initiate[claimant]!
    const pub = role[claimant]
    if (!pub) throw new Error(`missing ${claimant}`)
    return checksigScript([pub, xOnlyFromCompressed(pair.vault), xOnlyFromCompressed(pair.arkade)])
  })
  const scripts = [admin, ...initiate]

  const internal = contextInternalKey({
    vaultId: input.vaultId,
    claimant: '',
    templateVersion: input.templateVersion,
  })
  const payment = p2tr(internal, tapTreeFromScripts(scripts), vaultAddressNetwork(input.network), true)
  if (!payment.address) throw new Error('normal address required')
  return {
    role: 'normal' as const,
    address: payment.address,
    script: payment.script,
    tapInternalKey: payment.tapInternalKey,
    tapLeafScript: payment.tapLeafScript,
    leaves: payment.leaves,
    admin,
    initiate,
  }
}

export function buildVaultProgramFamily(input: {
  vaultId: string
  phonePub: string
  hardwarePub: string
  recoveryPub?: string
  phoneDirectP256: string
  vaultCosignerBase: string
  arkadeCosignerBase: string
  network: string
  templateVersion?: string
  absoluteFeeCapSats: number
  feerateCapSatPerV: number
  serverFreeClawback?: boolean
}) {
  const phoneDirect = hexToBytes(input.phoneDirectP256)
  const bases = [input.phonePub, input.hardwarePub, input.vaultCosignerBase, input.arkadeCosignerBase]
  if (input.recoveryPub) bases.splice(2, 0, input.recoveryPub)
  assertRoleSet(bases, 'family bases')
  const claimants = (input.recoveryPub ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']) as Claimant[]
  const hasRecovery = Boolean(input.recoveryPub)
  const quarantine = {} as Record<FamilyKey, ReturnType<typeof buildQuarantine>>
  const pending = {} as Record<FamilyKey, ReturnType<typeof buildPending>>
  const initiateAuth = {} as Record<FamilyKey, Uint8Array>
  const clawbackAuth = {} as Record<FamilyKey, Uint8Array>
  const pendingTweaks = {} as Record<FamilyKey, ReturnType<typeof tweakPair>>
  const templateVersion = input.templateVersion
  const serverFreeClawback = input.serverFreeClawback ?? templateVersion === SAVINGS_TEMPLATE
  const expectedClawbackWitness = clawbackWitnessBytes(serverFreeClawback, hasRecovery)
  for (const claimant of claimants) {
    const key = `savings-${claimant}` as FamilyKey
    quarantine[key] = buildQuarantine({ ...input, claimant, templateVersion })
    clawbackAuth[key] = buildTransitionScript({
      destScriptHex: hex.encode(quarantine[key].script),
      witnessBytes: expectedClawbackWitness,
      feeCap: input.absoluteFeeCapSats,
      feerateCap: input.feerateCapSatPerV,
    })
    pendingTweaks[key] = tweakPair(input.vaultCosignerBase, input.arkadeCosignerBase, clawbackAuth[key])
    pending[key] = buildPending({
      ...input,
      templateVersion,
      serverFreeClawback,
      claimant,
      vaultTweak: pendingTweaks[key].vault,
      arkadeTweak: pendingTweaks[key].arkade,
    })
    initiateAuth[key] = buildTransitionScript({
      destScriptHex: hex.encode(pending[key].script),
      bindPhoneDirect: claimant === 'phone' ? phoneDirect : undefined,
      witnessBytes: initiateWitnessBytes(claimant, hasRecovery),
      feeCap: input.absoluteFeeCapSats,
      feerateCap: input.feerateCapSatPerV,
    })
  }
  const savingsInitiate: InitiateTweaks = {
    phone: tweakPair(input.vaultCosignerBase, input.arkadeCosignerBase, initiateAuth['savings-phone']),
    hardware: tweakPair(input.vaultCosignerBase, input.arkadeCosignerBase, initiateAuth['savings-hardware']),
    ...(hasRecovery
      ? { recovery: tweakPair(input.vaultCosignerBase, input.arkadeCosignerBase, initiateAuth['savings-recovery']) }
      : {}),
  }
  const savings = buildNormal({
    ...input,
    initiate: savingsInitiate,
  })
  savings.initiate.forEach((script, i) => {
    const claimant = claimants[i]
    const got = collaborativeWitnessBytes(script, controlOf(savings, script))
    const want = initiateWitnessBytes(claimant, hasRecovery)
    if (got !== want) throw new Error(`savings ${claimant} initiate witness ${got} != ${want}`)
  })
  assertRoleSet(
    [
      input.phonePub,
      input.hardwarePub,
      ...(input.recoveryPub ? [input.recoveryPub] : []),
      input.vaultCosignerBase,
      input.arkadeCosignerBase,
      ...claimants.flatMap((claimant) => [savingsInitiate[claimant]!.vault, savingsInitiate[claimant]!.arkade]),
      ...Object.values(pendingTweaks).flatMap((pair) => [pair.vault, pair.arkade]),
    ],
    'family',
  )
  return {
    savings,
    quarantine,
    pending,
    initiateAuth,
    clawbackAuth,
    initiateTweaks: savingsInitiate,
    pendingTweaks,
  }
}

export type VaultProgramFamily = ReturnType<typeof buildVaultProgramFamily>
