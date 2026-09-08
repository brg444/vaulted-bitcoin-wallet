import { hex } from '@scure/base'
import type { HDKey } from '@scure/bip32'
import { familyClaimants, type Claimant } from './constants'
import { buildNormalWithKeys, type InitiateTweaks } from './trees'
import {
  ledgerAccountExpression,
  ledgerAccountKey,
  ledgerRecoveryProgramParent,
  ledgerSavingsChild,
  ledgerSavingsInternalParent,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'

/** Reuses the native Savings leaf builder. Recovery programs must come from the
 * canonical family reconstruction; this constructor is not an enrollment API. */
export function buildLedgerNativeSavings(input: LedgerSavingsKeyContext, programs: Partial<Record<Claimant, string>>) {
  const claimants = familyClaimants(Boolean(input.recovery))
  if (Object.keys(programs).sort().join() !== [...claimants].sort().join())
    throw new Error('recovery programs must match claimants')
  const internal = ledgerSavingsInternalParent(input)
  const phone = ledgerAccountKey(input.phone, input.network)
  const hardware = ledgerAccountKey(input.hardware, input.network)
  const recovery = input.recovery ? ledgerAccountKey(input.recovery, input.network) : undefined
  const keysInfo = [
    internal.publicExtendedKey,
    ledgerAccountExpression(input.phone, input.network),
    ledgerAccountExpression(input.hardware, input.network),
  ]
  const parents = new Map<Claimant, { vault: HDKey; arkade: HDKey }>()
  const pairs = new Map<Claimant, number[]>()
  for (const claimant of claimants) {
    const programHex = programs[claimant]!
    if (!/^(?:[0-9a-f]{2})+$/.test(programHex)) throw new Error('recovery program must be canonical hex')
    const program = hex.decode(programHex)
    const pair = {
      vault: ledgerRecoveryProgramParent(input, claimant, 'vault', program),
      arkade: ledgerRecoveryProgramParent(input, claimant, 'arkade', program),
    }
    pairs.set(claimant, [keysInfo.length, keysInfo.length + 1])
    keysInfo.push(pair.vault.publicExtendedKey, pair.arkade.publicExtendedKey)
    parents.set(claimant, pair)
  }
  const recoveryIndex = keysInfo.length
  if (input.recovery) keysInfo.push(ledgerAccountExpression(input.recovery, input.network))
  const and = (keys: string[]) =>
    keys.reduceRight((rest, key) => (rest ? `and_v(v:pk(${key}),${rest})` : `pk(${key})`), '')
  const leaves = [
    and(['@1/**', '@2/**']),
    ...claimants.map((claimant) =>
      and([
        claimant === 'phone' ? '@1/<2;3>/*' : claimant === 'hardware' ? '@2/<2;3>/*' : `@${recoveryIndex}/**`,
        ...pairs.get(claimant)!.map((i) => `@${i}/**`),
      ]),
    ),
  ]
  const tree = input.recovery
    ? `{{${leaves[0]},${leaves[1]}},{${leaves[2]},${leaves[3]}}}`
    : `{{${leaves[0]},${leaves[1]}},${leaves[2]}}`
  const descriptorTemplate = `tr(@0/**,${tree})`
  if (keysInfo.length > 15 || descriptorTemplate.length > 512)
    throw new Error('Ledger wallet policy exceeds device limits')
  const pub = (parent: HDKey, branch: number) => hex.encode(ledgerSavingsChild(parent, branch).publicKey!)
  const at = (change: 0 | 1) => {
    const initiate = {} as InitiateTweaks
    const initiateUserPubs: Partial<Record<Claimant, string>> = {}
    for (const claimant of claimants) {
      const pair = parents.get(claimant)!
      initiate[claimant] = { vault: pub(pair.vault, change), arkade: pub(pair.arkade, change) }
      initiateUserPubs[claimant] = pub(
        claimant === 'phone' ? phone : claimant === 'hardware' ? hardware : recovery!,
        claimant === 'recovery' ? change : 2 + change,
      )
    }
    return buildNormalWithKeys(
      {
        vaultId: input.vaultId,
        network: input.network,
        templateVersion: input.templateVersion,
        phonePub: pub(phone, change),
        hardwarePub: pub(hardware, change),
        recoveryPub: recovery ? pub(recovery, change) : undefined,
        initiate,
      },
      { internalKey: ledgerSavingsChild(internal, change).publicKey!.slice(1), initiateUserPubs },
    )
  }
  return { walletPolicy: { name: 'Vaulted Savings', descriptorTemplate, keysInfo }, receive: at(0), change: at(1) }
}
