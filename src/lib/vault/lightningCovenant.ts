import {
  RestArkProvider,
  VHTLC,
  getNetwork,
  provisionRefundKey,
  resolveEmulatorPubkey,
  toXOnly,
  type IWallet,
  type NetworkName,
} from '@arkade-os/sdk'
import {
  AddressMismatch,
  assertFundable,
  lightningSendRequest,
  lightningSendVtxoScript,
  newRfqId,
  registerLockupContract,
  unilateralClaimDelay,
  type InvoiceFacts,
  type LightningSendTreeParams,
  type RfqQuote,
  type RfqTransport,
} from '@arkade-os/swap'
import { hex } from '@scure/base'
import { resolveQuotedRefundWithoutReceiverDelay } from './lightningRefundDelay'

export type LightningCovenantVariant = 'eight-leaf' | 'nine-leaf'

export interface LightningCovenantCandidates {
  eight: InstanceType<typeof VHTLC.ScriptV2>
  nine: InstanceType<typeof VHTLC.ScriptV2>
  eightAddress: string
  nineAddress: string
  treeParams: LightningSendTreeParams
}

export interface LightningSendCandidateOptions {
  /**
   * Validated `profile.refund_without_receiver_delay` from the quote. When
   * present it binds the solo CSV delay of BOTH candidate shapes, so neither
   * the eight- nor the nine-leaf address can be accepted while ignoring the
   * advertised term.
   */
  refundWithoutReceiverDelay?: number
}

function solverHex(value: unknown, field: string): Uint8Array {
  try {
    return hex.decode(String(value))
  } catch {
    throw new Error(`solver sent malformed hex for ${field}`)
  }
}

/**
 * Build both protocol-supported candidates from Vaulted's own tree params.
 *
 * The eight-leaf tree is the package `lightningSendVtxoScript` derivation.
 * The nine-leaf tree clones that script's options and sets
 * `nonInteractiveRefund.withoutReceiver: true` (timelocked non-interactive
 * refund: server + emulator, CLTV). Leaves are never hand-rolled. When the
 * quote advertises a bounded `refundWithoutReceiverDelay`, that value binds
 * the solo CSV leaf of both shapes: an older eight-leaf quote whose address was
 * derived from the fixed delay can then no longer be accepted as a downgrade.
 */
export function buildLightningSendCandidates(
  treeParams: LightningSendTreeParams,
  hrp: string,
  serverPubkey: Uint8Array,
  options: LightningSendCandidateOptions = {},
): LightningCovenantCandidates {
  const packageEight = lightningSendVtxoScript(treeParams)
  const nonInteractiveRefund = packageEight.options.nonInteractiveRefund
  if (!nonInteractiveRefund) throw new Error('lightning-send covenant is missing its non-interactive refund leaf')
  const eight =
    options.refundWithoutReceiverDelay === undefined
      ? packageEight
      : new VHTLC.ScriptV2({
          ...packageEight.options,
          unilateralRefundWithoutReceiverDelay: {
            type: packageEight.options.unilateralRefundWithoutReceiverDelay.type,
            value: BigInt(options.refundWithoutReceiverDelay),
          },
        })
  const nine = new VHTLC.ScriptV2({
    ...eight.options,
    nonInteractiveRefund: { ...nonInteractiveRefund, withoutReceiver: true },
  })
  return {
    eight,
    nine,
    eightAddress: eight.address(hrp, serverPubkey).encode(),
    nineAddress: nine.address(hrp, serverPubkey).encode(),
    treeParams,
  }
}

export function matchLightningSendCandidate(
  candidates: LightningCovenantCandidates,
  quotedAddress: unknown,
): { variant: LightningCovenantVariant; script: InstanceType<typeof VHTLC.ScriptV2>; address: string } {
  if (typeof quotedAddress === 'string' && quotedAddress === candidates.eightAddress) {
    return { variant: 'eight-leaf', script: candidates.eight, address: candidates.eightAddress }
  }
  if (typeof quotedAddress === 'string' && quotedAddress === candidates.nineAddress) {
    return { variant: 'nine-leaf', script: candidates.nine, address: candidates.nineAddress }
  }
  throw new AddressMismatch(
    `${candidates.eightAddress} | ${candidates.nineAddress}`,
    typeof quotedAddress === 'string' ? quotedAddress : undefined,
  )
}

/**
 * Vaulted Lightning-send requester with dual-candidate lockup matching.
 *
 * Reuses the package helpers (`provisionRefundKey`, `lightningSendRequest`,
 * `lightningSendVtxoScript`, `registerLockupContract`, `unilateralClaimDelay`,
 * `assertFundable`, `RestArkProvider`, `resolveEmulatorPubkey`, `toXOnly` /
 * `getNetwork`) and substitutes dual-candidate matching for the package's
 * single `verifyLockupAddress` call, so a valid nine-leaf quote is not
 * rejected as `AddressMismatch` before Vaulted can try the second candidate.
 *
 * Never funds a solver-supplied address Vaulted did not derive: when neither
 * locally derived candidate matches `quote.profile.lockup_address` it throws
 * before registering any contract and before returning any funding address.
 */
export async function requestVaultLightningSend(
  wallet: IWallet,
  arkServerUrl: string,
  transport: RfqTransport,
  params: { invoice: InvoiceFacts; rfqId?: string; emulatorPubkey?: string },
): Promise<{
  rfqId: string
  quote: RfqQuote
  address: string
  fundAmount: number
  swapPkScript: Uint8Array
  script: InstanceType<typeof VHTLC.ScriptV2>
  refundAddress: string
  senderPubkey: Uint8Array
  secrets: Awaited<ReturnType<typeof provisionRefundKey>>
  treeParams: LightningSendTreeParams
}> {
  const rfqId = params.rfqId ?? newRfqId()
  const secrets = await provisionRefundKey(wallet)
  const senderPubkey = secrets.pubkey
  const refundAddress = secrets.address
  const info = await new RestArkProvider(arkServerUrl).getInfo()
  const quote = await transport.requestQuote(
    lightningSendRequest({ rfqId, invoice: params.invoice.raw, refundAddress, senderPubkey }),
  )
  if (quote.refund_locktime === undefined) {
    throw new Error('lightning-send quote is missing refund_locktime')
  }
  const receiverPkScriptHex = (quote.profile as Record<string, unknown> | undefined)?.receiver_pk_script
  if (receiverPkScriptHex === undefined) {
    throw new Error('lightning-send quote is missing profile.receiver_pk_script')
  }
  if (quote.to_amount !== params.invoice.amountSats) {
    throw new Error(`quote to_amount ${quote.to_amount} does not match the invoice's ${params.invoice.amountSats}`)
  }
  if (quote.from_amount < quote.to_amount) {
    throw new Error(
      `quote from_amount ${quote.from_amount} is below the invoice amount — a negative spread is not a quote`,
    )
  }
  const serverPubkey = toXOnly(hex.decode(info.signerPubkey), 'ark signer key')
  const network = getNetwork(info.network as NetworkName)
  const exitDelay = Number(info.unilateralExitDelay)
  if (!Number.isSafeInteger(exitDelay) || exitDelay < 1) {
    throw new Error('Arkade Operator unilateralExitDelay is missing or malformed')
  }
  const claimDelay = unilateralClaimDelay(exitDelay)
  const now = Math.floor(Date.now() / 1000)
  const quotedRefundDelay = resolveQuotedRefundWithoutReceiverDelay({
    quoted: (quote.profile as Record<string, unknown> | undefined)?.refund_without_receiver_delay,
    claimDelay,
    refundLocktime: quote.refund_locktime,
    nowSeconds: now,
  })
  const treeParams: LightningSendTreeParams = {
    solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), 'solver key'),
    refundLocktime: quote.refund_locktime,
    serverPubkey,
    paymentHash: params.invoice.paymentHash,
    claimDelay,
    emulatorPubkey: toXOnly(hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)), 'emulator signer key'),
    senderPubkey,
    receiverPkScript: solverHex(receiverPkScriptHex, 'profile.receiver_pk_script'),
    refundPkScript: secrets.pkScript,
  }
  const candidates = buildLightningSendCandidates(treeParams, network.hrp, serverPubkey, {
    refundWithoutReceiverDelay: quotedRefundDelay,
  })
  const quoted = (quote.profile as Record<string, unknown> | undefined)?.lockup_address
  const matched = matchLightningSendCandidate(candidates, quoted)
  assertFundable({
    quote,
    invoiceExpiresAt: params.invoice.expiresAt,
    now,
  })
  await registerLockupContract(await wallet.getContractManager(), matched.script, matched.address)
  return {
    rfqId,
    quote,
    address: matched.address,
    fundAmount: quote.from_amount,
    swapPkScript: matched.script.pkScript,
    script: matched.script,
    refundAddress,
    senderPubkey,
    secrets,
    treeParams,
  }
}
