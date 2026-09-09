import { Buffer } from 'buffer'
import { hex } from '@scure/base'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import type { AppClient } from '@ledgerhq/ledger-bitcoin'
import { readLedgerSavingsAccount } from '../ledgerClient'
import { canonicalLedgerValue } from './ledgerEnrollment'
import { isLedgerRecoveryKit } from './kit'
import { acceptSavingsRecoverySignature, validateSavingsRecovery, type SavingsRecoveryFile } from './onchainRecovery'
import {
  buildLedgerRecoveryPsbt,
  inspectLedgerRecoveryTransition,
  requireLedgerRecoveryUserApproval,
  type LedgerRecoveryTransition,
} from '../ledgerRecovery'
import { Transaction } from '@scure/btc-signer'

type Device = Pick<
  AppClient,
  'getMasterFingerprint' | 'getExtendedPubkey' | 'registerWallet' | 'getWalletAddress' | 'signPsbt'
>

/** Register and sign the complete selected recovery tree from the public kit. No phone secret is needed. */
export async function signLedgerSavingsRecoveryWithDevice(
  app: Device,
  input: SavingsRecoveryFile,
  role: 'hardware' | 'recovery',
  signal?: AbortSignal,
): Promise<SavingsRecoveryFile> {
  signal?.throwIfAborted()
  const file = structuredClone(input),
    view = validateSavingsRecovery(file)
  if (!isLedgerRecoveryKit(view.kit) || !view.signers.includes(role) || !('walletPolicy' in view))
    throw new Error('The selected Ledger recovery key is not required')
  const context = view.kit.descriptor.ledgerSavings.context,
    expected = context[role]
  if (!expected) throw new Error('Ledger recovery account is not enrolled')
  const actual = await readLedgerSavingsAccount(app, context.network, expected.path[2] - 0x80000000)
  signal?.throwIfAborted()
  if (canonicalLedgerValue(actual) !== canonicalLedgerValue(expected))
    throw new Error('Connect the Ledger for the selected recovery account')
  globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
  const { WalletPolicy } = await import('@ledgerhq/ledger-bitcoin')
  const p = view.walletPolicy,
    policy = new WalletPolicy(p.name, p.descriptorTemplate, p.keysInfo)
  const [id, hmac] = await app.registerWallet(policy)
  signal?.throwIfAborted()
  if (!id.equals(policy.getId()) || hmac.length !== 32) throw new Error('Ledger returned another recovery policy')
  const change = file.path.program === 'savings-admin' ? (file.path.change ?? 0) : 0
  const sourceAddress =
    file.path.program === 'savings-admin'
      ? (change === 0 ? view.kit.descriptor.savings : view.kit.descriptor.savingsChange).address
      : (file.path.program === 'quarantine' ? view.kit.descriptor.quarantine : view.kit.descriptor.pending)[
          `savings-${file.path.claimant}`
        ].address
  if ((await app.getWalletAddress(policy, hmac, change, 0, true)) !== sourceAddress)
    throw new Error('Ledger recovery policy address changed')
  signal?.throwIfAborted()
  const signatures = await app.signPsbt(Buffer.from(view.tx.toPSBT()), policy, hmac)
  signal?.throwIfAborted()
  const expectedPub = view.pubs[view.signers.indexOf(role)]
  if (signatures.length !== 1) throw new Error('Ledger must return exactly the selected recovery signature')
  const [index, signature] = signatures[0]
  if (
    index !== 0 ||
    signature.signature.length !== 64 ||
    signature.pubkey.length !== 32 ||
    hex.encode(signature.pubkey) !== expectedPub ||
    !signature.tapleafHash ||
    hex.encode(signature.tapleafHash) !== hex.encode(tapLeafHash(view.leaf))
  )
    throw new Error('Ledger returned an unexpected recovery signature')
  view.tx.updateInput(0, {
    tapScriptSig: [
      ...(view.tx.getInput(0).tapScriptSig || []),
      [
        { pubKey: Uint8Array.from(signature.pubkey), leafHash: Uint8Array.from(signature.tapleafHash) },
        Uint8Array.from(signature.signature),
      ],
    ],
  })
  return acceptSavingsRecoverySignature(file, hex.encode(view.tx.toPSBT()), role)
}

/** The acting H/R account signs only the exact initiation or cancellation capability. */
export async function signLedgerRecoveryTransitionWithDevice(
  app: Device,
  input: LedgerRecoveryTransition,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const transition = structuredClone(input),
    view = inspectLedgerRecoveryTransition(transition)
  if (view.user !== 'hardware' && view.user !== 'recovery')
    throw new Error('This transition requires the phone account')
  const origin = transition.contract.context[view.user]!
  const actual = await readLedgerSavingsAccount(app, transition.contract.context.network, origin.path[2] - 0x80000000)
  signal?.throwIfAborted()
  if (canonicalLedgerValue(actual) !== canonicalLedgerValue(origin))
    throw new Error('Connect the enrolled acting Ledger account')
  globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
  const { WalletPolicy } = await import('@ledgerhq/ledger-bitcoin')
  const p = view.walletPolicy,
    policy = new WalletPolicy(p.name, p.descriptorTemplate, p.keysInfo)
  const [id, hmac] = await app.registerWallet(policy)
  signal?.throwIfAborted()
  if (!id.equals(policy.getId()) || hmac.length !== 32) throw new Error('Ledger returned another recovery policy')
  if ((await app.getWalletAddress(policy, hmac, transition.action.change, 0, true)) !== view.sourceAddress)
    throw new Error('Ledger recovery source address changed')
  signal?.throwIfAborted()
  const tx = Transaction.fromPSBT(hex.decode(buildLedgerRecoveryPsbt(transition)))
  const signatures = await app.signPsbt(Buffer.from(tx.toPSBT()), policy, hmac)
  signal?.throwIfAborted()
  if (signatures.length !== 1) throw new Error('Ledger must return exactly one recovery signature')
  const [index, signature] = signatures[0]
  if (
    index !== 0 ||
    signature.signature.length !== 64 ||
    signature.pubkey.length !== 32 ||
    signature.tapleafHash?.length !== 32
  )
    throw new Error('Ledger returned an unexpected recovery signature')
  tx.updateInput(0, {
    tapScriptSig: [[{ pubKey: signature.pubkey, leafHash: signature.tapleafHash }, signature.signature]],
  })
  return hex.encode(requireLedgerRecoveryUserApproval(transition, hex.encode(tx.toPSBT())).toPSBT())
}
