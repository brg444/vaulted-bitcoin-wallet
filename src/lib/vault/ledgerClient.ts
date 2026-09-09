import { Buffer } from 'buffer'
import { hex } from '@scure/base'
import type { AppClient } from '@ledgerhq/ledger-bitcoin'
import { buildLedgerNativeFamily } from './program/ledgerNativeFamily'
import { ledgerAccountKey, ledgerSavingsContextDigest, type LedgerAccountOrigin } from './program/ledgerNativeKeys'
import {
  acceptLedgerSavingsSignatures,
  requireLedgerSavingsPhoneApproval,
  type LedgerSavingsContract,
  type LedgerSavingsPayment,
} from './ledgerSavings'
import type { VaultNetwork } from './network'

export interface LedgerSavingsRegistration {
  name: 'vaulted-ledger-registration'
  version: 1
  contextDigest: string
  walletId: string
  walletHmac: string
  walletPolicy: ReturnType<typeof buildLedgerNativeFamily>['walletPolicy']
  receiveAddress: string
  changeAddress: string
}

type LedgerApp = Pick<
  AppClient,
  'getMasterFingerprint' | 'getExtendedPubkey' | 'registerWallet' | 'getWalletAddress' | 'signPsbt'
>

async function policyFor(contract: LedgerSavingsContract) {
  // The official client uses the Node Buffer API. Load it only for Ledger work.
  globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
  const { WalletPolicy } = await import('@ledgerhq/ledger-bitcoin')
  const family = buildLedgerNativeFamily(contract.context, contract.spendingPolicy)
  const { name, descriptorTemplate, keysInfo } = family.walletPolicy
  return { family, policy: new WalletPolicy(name, descriptorTemplate, keysInfo) }
}

export async function readLedgerSavingsAccount(
  app: LedgerApp,
  network: VaultNetwork,
  account = 0,
): Promise<LedgerAccountOrigin> {
  if (!Number.isInteger(account) || account < 0 || account > 100) throw new Error('invalid Ledger account number')
  const coin = network === 'mainnet' ? 0 : 1
  const fingerprint = await app.getMasterFingerprint()
  const xpub = await app.getExtendedPubkey(`m/86'/${coin}'/${account}'`, false)
  const origin = { fingerprint, xpub, path: [0x80000056, 0x80000000 + coin, 0x80000000 + account] }
  ledgerAccountKey(origin, network)
  return origin
}

async function requireEnrolledDevice(app: LedgerApp, contract: LedgerSavingsContract) {
  const expected = contract.context.hardware
  const actual = await readLedgerSavingsAccount(app, contract.context.network, expected.path[2] - 0x80000000)
  if (actual.fingerprint !== expected.fingerprint || actual.xpub !== expected.xpub)
    throw new Error('Connect the Ledger used for this Savings wallet.')
}

/** Registration data can be included in a recovery package, but is not itself
 * a Recovery Kit. It contains no phone key and never proves a recovery path works. */
export async function validateLedgerSavingsRegistration(
  contract: LedgerSavingsContract,
  raw: unknown,
): Promise<LedgerSavingsRegistration> {
  const record = raw as LedgerSavingsRegistration | null
  const { family, policy } = await policyFor(contract)
  if (
    !record ||
    record.name !== 'vaulted-ledger-registration' ||
    record.version !== 1 ||
    record.contextDigest !== hex.encode(ledgerSavingsContextDigest(contract.context)) ||
    record.walletId !== policy.getId().toString('hex') ||
    !/^[0-9a-f]{64}$/.test(record.walletHmac) ||
    record.walletPolicy?.name !== family.walletPolicy.name ||
    record.walletPolicy?.descriptorTemplate !== family.walletPolicy.descriptorTemplate ||
    JSON.stringify(record.walletPolicy?.keysInfo) !== JSON.stringify(family.walletPolicy.keysInfo) ||
    record.receiveAddress !== family.receive.address ||
    record.changeAddress !== family.change.address
  )
    throw new Error('Ledger registration does not match this Savings wallet. Register the original policy again.')
  // Copy the exact public contract; discard unrecognized imported fields.
  return {
    name: 'vaulted-ledger-registration',
    version: 1,
    contextDigest: record.contextDigest,
    walletId: record.walletId,
    walletHmac: record.walletHmac,
    walletPolicy: family.walletPolicy,
    receiveAddress: family.receive.address,
    changeAddress: family.change.address,
  }
}

export async function registerLedgerSavings(
  app: LedgerApp,
  contract: LedgerSavingsContract,
): Promise<LedgerSavingsRegistration> {
  contract = structuredClone(contract)
  const { family, policy } = await policyFor(contract)
  await requireEnrolledDevice(app, contract)
  const [id, hmac] = await app.registerWallet(policy)
  if (!id.equals(policy.getId()) || hmac.length !== 32) throw new Error('Ledger returned a different Savings policy')
  // Receive verification is on-device. A registration is not considered complete until this succeeds.
  const receive = await app.getWalletAddress(policy, hmac, 0, 0, true)
  const change = await app.getWalletAddress(policy, hmac, 1, 0, false)
  return validateLedgerSavingsRegistration(contract, {
    name: 'vaulted-ledger-registration',
    version: 1,
    contextDigest: hex.encode(ledgerSavingsContextDigest(contract.context)),
    walletId: id.toString('hex'),
    walletHmac: hmac.toString('hex'),
    walletPolicy: family.walletPolicy,
    receiveAddress: receive,
    changeAddress: change,
  })
}

export async function signLedgerSavings(
  app: LedgerApp,
  input: LedgerSavingsPayment,
  phonePsbt: string,
  registration: LedgerSavingsRegistration,
): Promise<string> {
  // Retain independent copies across device prompts and asynchronous transport calls.
  const payment = structuredClone(input)
  const approved = requireLedgerSavingsPhoneApproval(payment, phonePsbt)
  const record = await validateLedgerSavingsRegistration(payment.contract, registration)
  const { policy } = await policyFor(payment.contract)
  await requireEnrolledDevice(app, payment.contract)
  const signatures = await app.signPsbt(Buffer.from(approved.toPSBT()), policy, Buffer.from(record.walletHmac, 'hex'))
  const seen = new Set<number>()
  if (signatures.length !== approved.inputsLength) throw new Error('Ledger did not approve every Savings input')
  for (const [index, signature] of signatures) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= approved.inputsLength ||
      seen.has(index) ||
      signature.pubkey.length !== 32 ||
      signature.tapleafHash?.length !== 32 ||
      signature.signature.length !== 64
    )
      throw new Error('Ledger returned an unexpected Savings signature')
    seen.add(index)
    approved.updateInput(index, {
      tapScriptSig: [
        ...(approved.getInput(index).tapScriptSig || []),
        [{ pubKey: signature.pubkey, leafHash: signature.tapleafHash }, signature.signature],
      ],
    })
  }
  return acceptLedgerSavingsSignatures(payment, phonePsbt, hex.encode(approved.toPSBT()))
}

/** Desktop WebHID only. Mobile Safari must use the dedicated desktop signing
 * workflow; transport availability must never silently select connector signing. */
export async function connectLedgerSavings() {
  if (!globalThis.isSecureContext || typeof navigator === 'undefined' || !('hid' in navigator))
    throw new Error('Connect your Ledger using a desktop browser with USB device support.')
  globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
  const { default: Transport } = await import('@ledgerhq/hw-transport-webhid')
  const { AppClient: Client } = await import('@ledgerhq/ledger-bitcoin')
  const transport = await Transport.create()
  return { app: new Client(transport), close: () => transport.close() }
}
