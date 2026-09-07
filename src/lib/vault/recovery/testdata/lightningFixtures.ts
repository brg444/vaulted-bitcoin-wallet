import { p2tr } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import {
  VHTLC,
  VHTLCV2ContractHandler,
  Transaction,
  ChainTxType,
  getNetwork,
  resolveEmulatorPubkey,
  type Contract,
} from '@arkade-os/sdk'
import { lightningSendVtxoScript, type RfqSwapRecord } from '@arkade-os/swap'
import { MAINNET_INVOICE, MUTINYNET_INVOICE } from '../../lightningTestUtils'
import { decodeVaultLightningInvoice } from '../../lightningInvoice'
import { compressedFromScalar, scalarSecret } from '../../program/fixtures'
import { networkPins } from '../../networkPins'
import { recoveryFixture } from './helpers'
import lightVectors from '../../light/testdata/contracts.json'
import { lightDescriptorDigest, type LightDescriptor } from '../../light/contract'
import { packExitArchive } from '../exitArchive'
import { lightningExitBinding, type LightningArchiveBinding, type LightningRecoveryJournal } from '../lightningArchive'

export function lightningRecoveryFixture(
  options: {
    network?: 'mainnet' | 'mutinynet'
    nine?: boolean
    funded?: boolean
    advanced?: boolean
    light?: boolean
  } = {},
) {
  const network = options.network ?? 'mainnet'
  const pins = networkPins(network)
  const base = recoveryFixture(options.advanced ?? false, network)
  const binding: LightningArchiveBinding = {
    vaultId: base.status.vaultId,
    network,
    phonePub: base.kit.descriptor.keys.phoneBip340,
    descriptorHash: base.archive.spending.descriptorHash,
    spendingScript: base.status.spendingArkScript!,
  }
  if (options.light) {
    const descriptor = lightVectors.find((v) => v.descriptor.network === network)!.descriptor as LightDescriptor
    binding.vaultId = descriptor.vaultId
    binding.phonePub = `02${descriptor.ownerPub}`
    binding.descriptorHash = lightDescriptorDigest(descriptor)
    binding.spendingScript = descriptor.scriptPubKey
  }
  const invoice = decodeVaultLightningInvoice(
    network === 'mainnet' ? MAINNET_INVOICE : MUTINYNET_INVOICE,
    pins.sdkNetwork,
    0,
  )
  const rfqId = 'ab'.repeat(32),
    now = 1_734_606_755
  const tree = lightningSendVtxoScript({
    senderPubkey: hex.decode(binding.phonePub).slice(1),
    serverPubkey: hex.decode(pins.operatorSignerPub).slice(1),
    solverPubkey: hex.decode(compressedFromScalar(5)).slice(1),
    refundLocktime: now + 10000,
    paymentHash: invoice.paymentHash,
    claimDelay: 2048,
    receiverPkScript: p2tr(hex.decode(compressedFromScalar(6)).slice(1)).script,
    emulatorPubkey: hex.decode(resolveEmulatorPubkey(getNetwork(pins.sdkNetwork))).slice(1),
    refundPkScript: hex.decode(binding.spendingScript),
  })
  const script = options.nine
    ? new VHTLC.ScriptV2({
        ...tree.options,
        nonInteractiveRefund: { ...tree.options.nonInteractiveRefund!, withoutReceiver: true },
      })
    : tree
  const address = script.address(pins.arkHrp, hex.decode(pins.operatorSignerPub).slice(1)).encode()
  const contract: Contract = {
    type: 'vhtlc-v2',
    params: VHTLCV2ContractHandler.serializeParams(script.options),
    script: hex.encode(script.pkScript),
    address,
    state: 'active',
    watch: 'watched',
    createdAt: now * 1000,
    metadata: { genericallySpendable: false, kind: 'rfq-swap-lockup' },
    label: 'Lightning swap lockup',
  }
  const record: RfqSwapRecord = {
    rfqId,
    kind: 'lightning_send',
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    amount: 2125,
    lockupAddress: address,
    profile: {
      signer: { signingDescriptor: `tr(${binding.phonePub.slice(2)})` },
      hashlock: { paymentHash: invoice.paymentHash },
      vaultLightning: {
        version: 2,
        network: pins.sdkNetwork,
        invoice: invoice.raw,
        fundingState: 'quoted',
        quote: {
          v: 1,
          type: 'rfq_quote',
          rfq_id: rfqId,
          pair: 'arkade:BTC->lightning:BTC',
          amount_side: 'to',
          from_amount: 2125,
          to_amount: invoice.amountSats,
          solver_pubkey: hex.encode(script.options.receiver),
          valid_until: now + 100,
          refund_locktime: now + 10000,
          profile: {
            receiver_pk_script: hex.encode(script.options.nonInteractiveClaim!.receiverPkScript),
            lockup_address: address,
          },
        },
      },
    },
  }
  const parent = p2tr(hex.decode(compressedFromScalar(21)).slice(1), undefined, getNetwork(pins.sdkNetwork))
  const tx = new Transaction({ version: 3 })
  tx.addInput({
    txid: '01'.repeat(32),
    index: 0,
    witnessUtxo: { script: parent.script, amount: 2125n },
    tapInternalKey: parent.tapInternalKey,
  })
  tx.addOutput({ amount: 2125n, script: script.pkScript })
  tx.addOutput({ amount: 0n, script: hex.decode('51024e73') })
  tx.sign(scalarSecret(21))
  const coin = {
    txid: tx.id,
    vout: 0,
    value: 2125,
    script: contract.script,
    isSpent: false,
    createdAt: '2026-09-06T00:00:00Z',
  }
  const funded = options.funded !== false
  if (funded) {
    const profile = record.profile.vaultLightning as Record<string, unknown>
    profile.fundingState = 'funding'
    profile.fundingProof = {
      rfqId,
      operationId: 'aa'.repeat(16),
      bundleDigest: 'bb'.repeat(32),
      address,
      amountSats: 2125,
      fundingFeeSats: 100,
    }
    // Deliberately missing fundingArkTxid: a interrupted post-submit write must
    // not erase the durable funding phase and its exact operation binding.
  }
  const exitBinding = lightningExitBinding({ record, contract }, binding)
  const journal: LightningRecoveryJournal = {
    name: 'vaulted-lightning-recovery',
    version: 1,
    binding,
    entries: [
      {
        record,
        contract,
        exit: {
          version: 1,
          descriptorHash: exitBinding.descriptorHash,
          capturedAt: '2026-09-06T00:00:00Z',
          info: base.archive.spending.info,
          coins: packExitArchive(funded ? [coin] : []),
          branches: funded
            ? {
                [tx.id + ':0']: [
                  { txid: '01'.repeat(32), type: ChainTxType.COMMITMENT, spends: [], expiresAt: '0' },
                  { txid: tx.id, type: ChainTxType.TREE, spends: ['01'.repeat(32)], expiresAt: '1789000000' },
                ],
              }
            : {},
          transactions: funded ? { [tx.id]: base64.encode(tx.toPSBT()) } : {},
        },
      },
    ],
  }
  return { journal, binding, entry: journal.entries[0], record, contract, script, tx, coin }
}
