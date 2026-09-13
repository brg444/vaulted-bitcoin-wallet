import { CSVMultisigTapscript, SingleKey, Transaction, type Identity, type IWallet } from '@arkade-os/sdk'
import {
  arkadeRefunder,
  lockupContractParams,
  rebuildRfqSwap,
  type InMemoryAssetSwapRepository,
  type RfqSwap,
} from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { lightningQuoteHarness } from '../lightningTestUtils'

/** Quote `from_amount` from `lightningQuoteHarness` / `completeRequestResult`. */
export const LIGHTNING_REFUND_QUOTE_SATS = 2125

/** Two original lockup coins whose sum is above the RFQ quote. */
export const LIGHTNING_REFUND_INPUT_VALUES = [1_500, 900] as const

export interface LightningRefundLockupInput {
  txid: string
  vout: number
  value: number
}

export interface LightningRefundSubmission {
  signedRefundPsbt: string
  serverRefundPsbt: string
  checkpointPsbts: string[]
  serverCheckpointPsbts: string[]
}

export interface LightningRefundFinalization {
  arkTxid: string
  checkpointPsbts: string[]
}

export interface LightningRefundPackageFacts {
  rfqId: string
  lockupAddress: string
  lockupPkScriptHex: string
  amountSats: number
  destination: string
  vaultId: string
  network: string
  senderPub: string
  serverPub: string
}

export interface LightningRefundOperatorArk {
  getInfo: () => Promise<{ checkpointTapscript: string }>
  submitTx: (
    signedRefundPsbt: string,
    checkpointPsbts: string[],
  ) => Promise<{ arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] }>
  finalizeTx: (arkTxid: string, checkpointPsbts: string[]) => Promise<void>
}

export interface LightningRefundPackageFixture {
  originalLockupInputs: LightningRefundLockupInput[]
  swap: RfqSwap
  signedRefundPsbt: string
  serverRefundPsbt: string
  submittedCheckpointPsbts: string[]
  serverCheckpointPsbts: string[]
  finalCheckpointPsbts: string[]
  refundId: string
  resultAmount: number
  quotedAmountSats: number
  destinationAddress: string
  destinationPkScriptHex: string
  senderPub: string
  serverPub: string
  submissions: LightningRefundSubmission[]
  finalizations: LightningRefundFinalization[]
  wallet: IWallet
  repository: InMemoryAssetSwapRepository
}

function operatorIdentity(): Identity {
  return SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
}

function checkpointTapscriptHex(serverPub: Uint8Array): string {
  return hex.encode(
    CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: 4096n },
      pubkeys: [serverPub],
    }).script,
  )
}

function originalLockupInputs(): LightningRefundLockupInput[] {
  return LIGHTNING_REFUND_INPUT_VALUES.map((value, index) => ({
    txid: (index === 0 ? 'a1' : 'a2').repeat(32),
    vout: index,
    value,
  }))
}

function lockupIndexer(scriptHex: string, inputs: readonly LightningRefundLockupInput[]) {
  const vtxos = inputs.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    value: input.value,
    script: scriptHex,
    isUnrolled: false,
  }))
  return {
    getVtxos: async (options?: { recoverableOnly?: boolean }) => {
      if (options?.recoverableOnly) return { vtxos: [] }
      return { vtxos }
    },
    getVirtualTxs: async () => ({ txs: [] }),
  }
}

async function recordingRefundOperator(server: Identity, serverPub: Uint8Array) {
  const submissions: LightningRefundSubmission[] = []
  const finalizations: LightningRefundFinalization[] = []
  const tapscript = checkpointTapscriptHex(serverPub)
  return {
    submissions,
    finalizations,
    ark: {
      getInfo: async () => ({ checkpointTapscript: tapscript }),
      submitTx: async (signedRefundPsbt: string, checkpointPsbts: string[]) => {
        const serverRefund = await server.sign(Transaction.fromPSBT(base64.decode(signedRefundPsbt)))
        const serverRefundPsbt = base64.encode(serverRefund.toPSBT())
        const serverCheckpointPsbts = await Promise.all(
          checkpointPsbts.map(async (psbt) => {
            const signed = await server.sign(Transaction.fromPSBT(base64.decode(psbt)), [0])
            return base64.encode(signed.toPSBT())
          }),
        )
        submissions.push({
          signedRefundPsbt,
          serverRefundPsbt,
          checkpointPsbts: [...checkpointPsbts],
          serverCheckpointPsbts: [...serverCheckpointPsbts],
        })
        return {
          arkTxid: Transaction.fromPSBT(base64.decode(signedRefundPsbt)).id,
          finalArkTx: serverRefundPsbt,
          signedCheckpointTxs: serverCheckpointPsbts,
        }
      },
      finalizeTx: async (arkTxid: string, checkpointPsbts: string[]) => {
        finalizations.push({ arkTxid, checkpointPsbts: [...checkpointPsbts] })
      },
    },
  }
}

/** Build a real two-input `arkadeRefunder` refund against in-memory transports. */
export async function lightningRefundPackageFixture(options?: {
  wrapArk?: (ark: LightningRefundOperatorArk, facts: LightningRefundPackageFacts) => LightningRefundOperatorArk
}): Promise<LightningRefundPackageFixture> {
  const harness = await lightningQuoteHarness({ rfqId: 'ab'.repeat(32) })
  try {
    const quote = await harness.request()
    const record = await harness.repository.getRfqSwap(quote.rfqId)
    if (!record) throw new Error('Lightning refund fixture has no RFQ record.')
    const params = await lockupContractParams(harness.contracts, record.lockupAddress)
    const swap = rebuildRfqSwap(record, params)
    if (!swap.lockup?.script) throw new Error('Rebuilt Lightning refund swap is missing its lockup script.')

    const inputs = originalLockupInputs()
    const scriptHex = hex.encode(swap.lockup.script.pkScript)
    const server = operatorIdentity()
    const serverPub = (await server.xOnlyPublicKey())!
    const { ark, submissions, finalizations } = await recordingRefundOperator(server, serverPub)
    const destinationAddress = await harness.wallet.getAddress()
    const facts: LightningRefundPackageFacts = {
      rfqId: swap.rfqId,
      lockupAddress: record.lockupAddress,
      lockupPkScriptHex: hex.encode(swap.lockup.script.pkScript),
      amountSats: inputs.reduce((total, input) => total + input.value, 0),
      destination: destinationAddress,
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      senderPub: hex.encode(swap.lockup.script.options.sender),
      serverPub: hex.encode(serverPub),
    }
    const result = await arkadeRefunder({
      ark: (options?.wrapArk ? options.wrapArk(ark, facts) : ark) as never,
      indexer: lockupIndexer(scriptHex, inputs) as never,
      wallet: harness.wallet,
      repository: harness.repository,
    })(swap)
    if (!result) throw new Error('Lightning refund fixture produced no package result.')

    const submitted = submissions[0]
    if (!submitted) throw new Error('Lightning refund fixture captured no submit.')
    const finalized = finalizations[0]
    if (!finalized) throw new Error('Lightning refund fixture captured no finalize.')

    return {
      originalLockupInputs: inputs,
      swap,
      signedRefundPsbt: submitted.signedRefundPsbt,
      serverRefundPsbt: submitted.serverRefundPsbt,
      submittedCheckpointPsbts: submitted.checkpointPsbts,
      serverCheckpointPsbts: submitted.serverCheckpointPsbts,
      finalCheckpointPsbts: finalized.checkpointPsbts,
      refundId: result.arkTxid,
      resultAmount: result.amount,
      quotedAmountSats: quote.fundAmountSats,
      destinationAddress,
      destinationPkScriptHex: hex.encode(swap.lockup.script.options.nonInteractiveRefund!.senderPkScript),
      senderPub: hex.encode(swap.lockup.script.options.sender),
      serverPub: hex.encode(serverPub),
      submissions,
      finalizations,
      wallet: harness.wallet,
      repository: harness.repository,
    }
  } finally {
    await harness.manager.stop()
  }
}
