import { requireSavingsRecoveryKit, inspectRecoveryKit, parseRecoveryKit, type RecoveryKit } from './kit'
import { loadSessionView } from './chain'
import { CLAIMANTS, type Claimant } from './constants'
import { deriveSession } from './session'
import { familyFromDescriptor } from './descriptor'
import { selectRoute } from './route'
import {
  buildClaimPsbt,
  buildClawbackPsbt,
  buildInitiatePsbt,
  bumpTransitionFee,
  inspectClaimPsbt,
  inspectTransitionPsbt,
} from './spend'

export type KitCliCommand =
  | { name: 'inspect'; kit: RecoveryKit }
  | {
      name: 'initiate'
      kit: RecoveryKit
      claimant: Claimant
      txid: string
      vout: number
      value: number
      fee: number
    }
  | {
      name: 'clawback'
      kit: RecoveryKit
      claimant: Claimant
      guardian: Claimant
      txid: string
      vout: number
      value: number
      fee: number
    }
  | {
      name: 'claim'
      kit: RecoveryKit
      claimant: Claimant
      dest: string
      txid: string
      vout: number
      value: number
      fee: number
    }
  | { name: 'verify'; psbtHex: string }
  | { name: 'bump'; psbtHex: string; fee: number }
  | {
      name: 'status'
      kit: RecoveryKit
      claimant: Claimant
      tip?: number
      height?: number
      mempool?: boolean
      spent?: 'quarantine' | 'other'
      prevHeight?: number
      requested?: boolean
      esplora?: string
      txid?: string
      vout?: number
    }

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= args.length) return undefined
  return args[i + 1]
}

function requireFlag(args: string[], name: string): string {
  const value = flag(args, name)
  if (!value) throw new Error(`--${name} required`)
  return value
}

function requireClaimant(args: string[], name = 'claimant'): Claimant {
  const value = requireFlag(args, name)
  if (!(CLAIMANTS as readonly string[]).includes(value)) throw new Error(`${name} must be phone, hardware, or recovery`)
  return value as Claimant
}

function requireInt(args: string[], name: string): number {
  const raw = requireFlag(args, name)
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`)
  return n
}

export function parseKitCli(argv: string[], loadKit: (path: string) => RecoveryKit): KitCliCommand {
  const [name, file, ...rest] = argv
  if (!name) throw new Error('usage: inspect|status|initiate|clawback|claim|verify|bump')
  if (name === 'verify') {
    if (!file) throw new Error('verify requires a psbt hex string or file path')
    return { name: 'verify', psbtHex: file }
  }
  if (name === 'bump') {
    if (!file) throw new Error('bump requires a psbt hex string or file path')
    return { name: 'bump', psbtHex: file, fee: requireInt(rest, 'fee') }
  }
  if (!file) throw new Error(`${name} requires a Recovery Kit json path`)
  const kit = loadKit(file)
  if (name === 'inspect') return { name: 'inspect', kit }
  if (name === 'status') {
    const spentRaw = flag(rest, 'spent')
    if (spentRaw && spentRaw !== 'quarantine' && spentRaw !== 'other') {
      throw new Error('spent must be quarantine or other')
    }
    const esplora = flag(rest, 'esplora')
    if (!esplora && !flag(rest, 'tip')) throw new Error('status requires --tip or --esplora')
    return {
      name: 'status',
      kit,
      claimant: requireClaimant(rest),
      tip: flag(rest, 'tip') ? requireInt(rest, 'tip') : undefined,
      height: flag(rest, 'height') ? requireInt(rest, 'height') : undefined,
      mempool: rest.includes('--mempool'),
      spent: spentRaw === 'quarantine' || spentRaw === 'other' ? spentRaw : undefined,
      prevHeight: flag(rest, 'prev-height') ? requireInt(rest, 'prev-height') : undefined,
      requested: rest.includes('--requested'),
      esplora,
      txid: flag(rest, 'txid'),
      vout: flag(rest, 'vout') ? requireInt(rest, 'vout') : undefined,
    }
  }
  const coin = {
    txid: requireFlag(rest, 'txid'),
    vout: requireInt(rest, 'vout'),
    value: requireInt(rest, 'value'),
    fee: requireInt(rest, 'fee'),
  }
  if (name === 'initiate') {
    return { name: 'initiate', kit, claimant: requireClaimant(rest), ...coin }
  }
  if (name === 'clawback') {
    return {
      name: 'clawback',
      kit,
      claimant: requireClaimant(rest),
      guardian: requireClaimant(rest, 'guardian'),
      ...coin,
    }
  }
  if (name === 'claim') {
    return {
      name: 'claim',
      kit,
      claimant: requireClaimant(rest),
      dest: requireFlag(rest, 'dest'),
      ...coin,
    }
  }
  throw new Error('usage: inspect|status|initiate|clawback|claim|verify|bump')
}

export function runKitCli(cmd: KitCliCommand): string {
  if (cmd.name === 'inspect') {
    const report = inspectRecoveryKit(cmd.kit)
    const lines = [
      `vault ${report.vaultId}`,
      `hash ${report.hash}`,
      ...report.trees.map((tree) => {
        const extra = tree.delay ? ` csv ${tree.delay}` : tree.guardians ? ` ${tree.guardians.join('+')}` : ''
        return `${tree.role} ${tree.address}${extra}`
      }),
      ...report.warnings.map((line) => `warning ${line}`),
    ]
    return lines.join('\n')
  }
  if (cmd.name === 'status') {
    if (cmd.esplora) throw new Error('status --esplora requires runKitCliAsync')
    return formatStatus(cmd)
  }
  if (cmd.name === 'bump') {
    const next = bumpTransitionFee(cmd.psbtHex, cmd.fee)
    const view = inspectTransitionPsbt(next)
    return `${view.feeSats}\n${next}`
  }
  if (cmd.name === 'verify') {
    try {
      const view = inspectTransitionPsbt(cmd.psbtHex)
      return `transition dest ${view.destScript} fee ${view.feeSats} p2a ${view.p2aSats}`
    } catch {
      const view = inspectClaimPsbt(cmd.psbtHex)
      return `claim dest ${view.destScript} fee ${view.feeSats} csv ${view.sequence}`
    }
  }
  const family = familyFromDescriptor(requireSavingsRecoveryKit(cmd.kit).descriptor)
  const coin = { txid: cmd.txid, vout: cmd.vout, value: cmd.value }
  if (cmd.name === 'initiate') {
    selectRoute({ role: 'normal' }, { type: 'initiate', claimant: cmd.claimant })
    const built = buildInitiatePsbt({ family, claimant: cmd.claimant, coin, feeSats: cmd.fee })
    return `${built.destAddress}\n${built.psbtHex}`
  }
  if (cmd.name === 'clawback') {
    selectRoute({ role: 'pending', claimant: cmd.claimant }, { type: 'clawback', guardian: cmd.guardian })
    const built = buildClawbackPsbt({
      family,
      claimant: cmd.claimant,
      guardian: cmd.guardian,
      coin,
      feeSats: cmd.fee,
    })
    return `${built.destAddress}\n${built.psbtHex}`
  }
  selectRoute({ role: 'pending', claimant: cmd.claimant }, { type: 'claim' })
  const built = buildClaimPsbt({
    family,
    claimant: cmd.claimant,
    coin,
    destAddress: cmd.dest,
    feeSats: cmd.fee,
    network: cmd.kit.descriptor.network,
  })
  return built.psbtHex
}

function formatStatus(cmd: Extract<KitCliCommand, { name: 'status' }>, view?: Parameters<typeof deriveSession>[1]) {
  const key = `savings-${cmd.claimant}` as const
  const pending = requireSavingsRecoveryKit(cmd.kit).descriptor.pending[key]
  const snapshot = deriveSession(
    pending.delay,
    view || {
      tipHeight: cmd.tip ?? 0,
      pending: cmd.height
        ? { txid: '00', vout: 0, value: 0, confirmed: true, blockHeight: cmd.height }
        : cmd.mempool
          ? { txid: '00', vout: 0, value: 0, confirmed: false }
          : undefined,
      spends: cmd.spent ? [{ txid: 'ff', confirmed: true, dest: cmd.spent }] : undefined,
      previouslyConfirmedHeight: cmd.prevHeight,
      requested: cmd.requested,
    },
  )
  return [
    `${key} ${pending.address}`,
    `state ${snapshot.state}`,
    `confirmed ${snapshot.confirmedHeight ?? '-'}`,
    `remaining ${snapshot.remaining ?? '-'}`,
    `claimable ${snapshot.claimable ? 'yes' : 'no'}`,
  ].join('\n')
}

export async function runKitCliAsync(cmd: KitCliCommand): Promise<string> {
  if (cmd.name === 'status' && cmd.esplora) {
    const key = `savings-${cmd.claimant}` as const
    const pending = requireSavingsRecoveryKit(cmd.kit).descriptor.pending[key]
    const quarantine = requireSavingsRecoveryKit(cmd.kit).descriptor.quarantine[key]
    const view = await loadSessionView({
      base: cmd.esplora,
      pendingAddress: pending.address,
      quarantineScriptHex: quarantine.script,
      outpoint: cmd.txid !== undefined && cmd.vout !== undefined ? { txid: cmd.txid, vout: cmd.vout } : undefined,
      previouslyConfirmedHeight: cmd.prevHeight,
      requested: cmd.requested,
    })
    return formatStatus(cmd, view)
  }
  return runKitCli(cmd)
}

export { parseRecoveryKit }
