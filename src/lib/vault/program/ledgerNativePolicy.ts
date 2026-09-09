import { hex } from '@scure/base'
import { p2tr } from '@scure/btc-signer'
import { vaultAddressNetwork } from '../addressNetwork'
import { checksigScript } from '../savingsTree'
import { familyClaimants } from './constants'
import { tapTreeFromScripts } from './trees'
import {
  ledgerAccountExpression,
  ledgerAccountKey,
  ledgerGuardianInitiateBranch,
  ledgerGuardianInitiateChild,
  ledgerSavingsChild,
  ledgerSavingsGuardianParent,
  ledgerSavingsInternalParent,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'

/** Builds the enrolled Guardian recovery contract without external program keys. */
export function buildLedgerNativeSavings(input: LedgerSavingsKeyContext) {
  const claimants = familyClaimants(Boolean(input.recovery))
  const internal = ledgerSavingsInternalParent(input)
  const phone = ledgerAccountKey(input.phone, input.network)
  const hardware = ledgerAccountKey(input.hardware, input.network)
  const recovery = input.recovery ? ledgerAccountKey(input.recovery, input.network) : undefined
  const guardian = ledgerSavingsGuardianParent(input)
  const keysInfo = [
    internal.publicExtendedKey,
    ledgerAccountExpression(input.phone, input.network),
    ledgerAccountExpression(input.hardware, input.network),
    guardian.publicExtendedKey,
    ...(input.recovery ? [ledgerAccountExpression(input.recovery, input.network)] : []),
  ]
  const and = (keys: string[]) =>
    keys.reduceRight((rest, key) => (rest ? `and_v(v:pk(${key}),${rest})` : `pk(${key})`), '')
  const leaves = [
    and(['@1/**', '@2/**']),
    ...claimants.map((claimant) => {
      const branch = ledgerGuardianInitiateBranch(input, claimant, 0)
      return and([
        claimant === 'phone' ? '@1/<2;3>/*' : claimant === 'hardware' ? '@2/<2;3>/*' : '@4/**',
        `@3/<${branch};${branch + 1}>/*`,
      ])
    }),
  ]
  const tree = input.recovery
    ? `{{${leaves[0]},${leaves[1]}},{${leaves[2]},${leaves[3]}}}`
    : `{{${leaves[0]},${leaves[1]}},${leaves[2]}}`
  const descriptorTemplate = `tr(@0/**,${tree})`
  if (keysInfo.length > 15 || descriptorTemplate.length > 512)
    throw new Error('Ledger wallet policy exceeds device limits')
  const at = (change: 0 | 1) => {
    const phonePub = ledgerSavingsChild(phone, change).publicKey!.slice(1)
    const hardwarePub = ledgerSavingsChild(hardware, change).publicKey!.slice(1)
    const initiateKeys = claimants.map((claimant) => [
      ledgerSavingsChild(
        claimant === 'phone' ? phone : claimant === 'hardware' ? hardware : recovery!,
        claimant === 'recovery' ? change : 2 + change,
      ).publicKey!.slice(1),
      ledgerGuardianInitiateChild(input, guardian, claimant, change).publicKey!.slice(1),
    ])
    const pubs = [phonePub, hardwarePub, ...initiateKeys.flat()].map((key) => hex.encode(key))
    if (new Set(pubs).size !== pubs.length) throw new Error('Ledger Savings derived authorities must be distinct')
    const admin = checksigScript([phonePub, hardwarePub])
    const initiate = initiateKeys.map(checksigScript)
    const payment = p2tr(
      ledgerSavingsChild(internal, change).publicKey!.slice(1),
      tapTreeFromScripts([admin, ...initiate]),
      vaultAddressNetwork(input.network),
      true,
    )
    if (!payment.address) throw new Error('Ledger Savings address required')
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
  return { walletPolicy: { name: 'Vaulted Savings', descriptorTemplate, keysInfo }, receive: at(0), change: at(1) }
}
