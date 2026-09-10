import { p2tr } from '@scure/btc-signer'
import { vaultAddressNetwork } from '../addressNetwork'
import { checksigScript } from '../savingsTree'
import { spendingPolicyDigest, validateSpendingPolicy, type SpendingPolicy } from '../spendingPolicy'
import { familyClaimants, type Claimant } from './constants'
import {
  ledgerAccountExpression,
  ledgerAccountKey,
  ledgerRecoveryChild,
  ledgerRecoveryInternalParent,
  ledgerGuardianClawbackBranch,
  ledgerGuardianClawbackChild,
  ledgerSavingsGuardianParent,
  ledgerSavingsChild,
  LEDGER_RECOVERY_BRANCH,
  type LedgerSavingsKeyContext,
} from './ledgerNativeKeys'
import { buildLedgerNativeSavings } from './ledgerNativePolicy'
import { pushInt } from './script'
import { pendingDelay, pendingGuardians, tapTreeFromScripts } from './trees'

const andKeys = (keys: string[]) =>
  keys.reduceRight((rest, key) => (rest ? `and_v(v:pk(${key}),${rest})` : `pk(${key})`), '')

function policy(name: string, leaves: string[], keysInfo: string[]) {
  const tree =
    leaves.length === 1
      ? leaves[0]
      : leaves.length === 3
        ? `{{${leaves[0]},${leaves[1]}},${leaves[2]}}`
        : `{{${leaves[0]},${leaves[1]}},{${leaves[2]},${leaves[3]}}}`
  if (![1, 3, 4].includes(leaves.length)) throw new Error('unexpected Ledger recovery leaf count')
  const descriptorTemplate = `tr(@0/**,${tree})`
  if (keysInfo.length > 15 || descriptorTemplate.length > 512) throw new Error('Ledger recovery policy exceeds limits')
  return { name, descriptorTemplate, keysInfo }
}

/** Builds the complete new contract from enrolled identity and policy, rather
 * than accepting recovery programs or destinations from an imported PSBT.
 * Receive and change converge on the same claimant-specific recovery outputs. */
export function buildLedgerNativeFamily(context: LedgerSavingsKeyContext, rawPolicy: SpendingPolicy) {
  const spendingPolicy = validateSpendingPolicy(rawPolicy, context.network)
  if (spendingPolicyDigest(spendingPolicy, context.network) !== context.policyDigest)
    throw new Error('Ledger Savings policy digest mismatch')
  const claimants = familyClaimants(Boolean(context.recovery))
  const guardianParent = ledgerSavingsGuardianParent(context)
  const account = (role: Claimant) => ledgerAccountKey(context[role]!, context.network)
  const pub = (role: Claimant, use: keyof typeof LEDGER_RECOVERY_BRANCH) =>
    ledgerRecoveryChild(account(role), use).publicKey!.slice(1)
  const recovery = Object.fromEntries(
    claimants.map((claimant) => {
      const guardians = pendingGuardians(claimant, Boolean(context.recovery))
      const quarantineInternal = ledgerRecoveryInternalParent(context, claimant, 'quarantine')
      const quarantineScript = checksigScript(guardians.map((role) => pub(role, 'quarantine')))
      const quarantinePayment = p2tr(
        ledgerSavingsChild(quarantineInternal, 0).publicKey!.slice(1),
        { script: quarantineScript },
        vaultAddressNetwork(context.network),
        true,
      )
      const quarantinePolicy = policy(
        `Vaulted ${claimant} safe`,
        [andKeys(guardians.map((_, i) => `@${i + 1}/<10;11>/*`))],
        [
          quarantineInternal.publicExtendedKey,
          ...guardians.map((r) => ledgerAccountExpression(context[r]!, context.network)),
        ],
      )
      const pendingInternal = ledgerRecoveryInternalParent(context, claimant, 'pending')
      // and_v(v:pk(claimant),older(delay)): ordinary Miniscript, same CSV rights.
      // The old CSV/DROP spelling and OP_RETURN padding remain legacy-only.
      const claimKey = pub(claimant, 'claim')
      const claim = new Uint8Array([0x20, ...claimKey, 0xad, ...pushInt(pendingDelay(claimant)), 0xb2])
      const clawbacks = guardians.map((guardian) =>
        checksigScript([
          pub(guardian, 'clawback'),
          ledgerGuardianClawbackChild(context, guardianParent, claimant, guardian).publicKey!.slice(1),
        ]),
      )
      const cancel = checksigScript(guardians.map((role) => pub(role, 'cancel')))
      const pendingPayment = p2tr(
        ledgerSavingsChild(pendingInternal, 0).publicKey!.slice(1),
        tapTreeFromScripts([claim, ...clawbacks, cancel]),
        vaultAddressNetwork(context.network),
        true,
      )
      const userIndex = (role: Claimant) => 1 + claimants.indexOf(role)
      const guardianIndex = claimants.length + 1
      const pendingPolicy = policy(
        `Vaulted ${claimant} wait`,
        [
          `and_v(v:pk(@${userIndex(claimant)}/<4;5>/*),older(${pendingDelay(claimant)}))`,
          ...guardians.map((guardian) => {
            const branch = ledgerGuardianClawbackBranch(context, claimant, guardian)
            return andKeys([`@${userIndex(guardian)}/<6;7>/*`, `@${guardianIndex}/<${branch};${branch + 1}>/*`])
          }),
          andKeys(guardians.map((guardian) => `@${userIndex(guardian)}/<8;9>/*`)),
        ],
        [
          pendingInternal.publicExtendedKey,
          ...claimants.map((role) => ledgerAccountExpression(context[role]!, context.network)),
          guardianParent.publicExtendedKey,
        ],
      )
      return [
        claimant,
        {
          claimant,
          guardians,
          delay: pendingDelay(claimant),
          pending: { ...pendingPayment, walletPolicy: pendingPolicy, claim, clawbacks, cancel },
          quarantine: { ...quarantinePayment, walletPolicy: quarantinePolicy, admin: quarantineScript },
        },
      ]
    }),
  ) as Partial<Record<Claimant, LedgerRecoveryFamily>>
  const normal = buildLedgerNativeSavings(context)
  return { ...normal, recovery, spendingPolicy }
}

type TapPayment = ReturnType<typeof p2tr>
export interface LedgerRecoveryFamily {
  claimant: Claimant
  guardians: Claimant[]
  delay: number
  pending: TapPayment & {
    walletPolicy: ReturnType<typeof policy>
    claim: Uint8Array
    clawbacks: Uint8Array[]
    cancel: Uint8Array
  }
  quarantine: TapPayment & { walletPolicy: ReturnType<typeof policy>; admin: Uint8Array }
}
