import { prepareExitArchivePrevouts, type RecoveryCommitmentReader } from './archivePrevouts'
import { hex } from '@scure/base'
import {
  Wallet,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  ReadonlySingleKey,
  Transaction,
  UnilateralExit,
  VHTLCV2ContractHandler,
  sequenceToTimelock,
  type ExitPackage,
  type Identity,
  type OnchainProvider,
  type ExitFeeWallet,
} from '@arkade-os/sdk'
import { bitcoinDustSats, scriptHexFromAddress } from '../bitcoin'
import { networkPins } from '../networkPins'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'
import {
  lightningArchiveProviders,
  type LightningArchiveBinding,
  type LightningRecoveryEntry,
} from './lightningArchive'
import { canonicalRecoveryGraph, type RecoveryFeeLimits, type RecoveryGraphSweep } from './graphPackage'

export interface LightningRecoveryPackage {
  name: 'vaulted-lightning-refund'
  version: 1
  entry: LightningRecoveryEntry
  binding: LightningArchiveBinding
  exitPackage: ExitPackage
  /** Exact PSBTs keep signing metadata independently of the finalized witnesses. */
  sweeps: string[]
}
export type LightningRecoverySigner = (request: { psbt: string; publicKey: string }) => Promise<string>

function sweepFacts(
  entry: LightningRecoveryEntry,
  binding: LightningArchiveBinding,
  destination: string,
  psbt: string,
  limits: RecoveryFeeLimits,
  complete: boolean,
): RecoveryGraphSweep {
  const local = lightningArchiveProviders(entry, binding)
  const script = VHTLCV2ContractHandler.createScript(local.contract.params)
  const tx = Transaction.fromPSBT(hex.decode(psbt))
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1)
    throw new Error('Lightning refund must have one input and one output')
  const input = tx.getInput(0)
  const coin = local.coins.find((coin) => coin.txid === hex.encode(input.txid!) && coin.vout === input.index)
  if (!coin) throw new Error('Lightning refund input is not in the saved archive')
  const output = tx.getOutput(0),
    fee = coin.value - Number(output.amount)
  if (
    !Number.isSafeInteger(fee) ||
    fee < 0 ||
    fee > limits.absoluteFeeCapSats ||
    Number(output.amount) < bitcoinDustSats(destination, binding.network)
  )
    throw new Error('Lightning refund fee is outside the wallet limits')
  const sequence = Number(entry.contract.params.refundNoReceiverDelay)
  const timelock = sequenceToTimelock(sequence)
  const expected = new Transaction({ version: 2 })
  expected.addInput({
    txid: coin.txid,
    index: coin.vout,
    sequence,
    tapLeafScript: [script.unilateralRefundWithoutReceiver()],
    witnessUtxo: { amount: BigInt(coin.value), script: script.pkScript },
    sighashType: 0,
  })
  expected.addOutput({ amount: output.amount, script: hex.decode(scriptHexFromAddress(destination, binding.network)) })
  const signatures = input.tapScriptSig ?? []
  if (signatures.length) expected.updateInput(0, { tapScriptSig: signatures })
  if (hex.encode(tx.toPSBT()) !== hex.encode(expected.toPSBT()))
    throw new Error('Lightning refund transaction or metadata changed')
  if (complete || signatures.length) requireExactDefaultTapscriptSignatures(tx, 0, [binding.phonePub.slice(2)])
  return { tx, coin, fee, delay: { type: timelock.type, value: Number(timelock.value) }, path: 'vhtlc-v2:unilateral' }
}

/** Actual SDK preparation, with the broadcast capability removed and only the
 * enrolled sender's exact CSV refund accepted by the transient signing adapter. */
export async function prepareLightningRecovery(
  entry: LightningRecoveryEntry,
  binding: LightningArchiveBinding,
  destination: string,
  sign: LightningRecoverySigner,
  feeLimits: RecoveryFeeLimits,
  onchain: OnchainProvider = new EsploraProvider('/esplora'),
  readCommitment?: RecoveryCommitmentReader,
): Promise<LightningRecoveryPackage> {
  const saved = JSON.parse(JSON.stringify(entry)) as LightningRecoveryEntry
  const enrolled = { ...binding }
  const limits = { ...feeLimits }
  const archiveBinding = lightningArchiveProviders(saved, enrolled).binding
  saved.exit = await prepareExitArchivePrevouts(saved.exit, archiveBinding, readCommitment)
  const local = lightningArchiveProviders(saved, enrolled)
  if (!local.coins.length) throw new Error('No saved Lightning outputs to recover')
  scriptHexFromAddress(destination, enrolled.network)
  const pins = networkPins(enrolled.network)
  const readonly = ReadonlySingleKey.fromPublicKey(hex.decode(enrolled.phonePub))
  const denied = (): never => {
    throw new Error('Only the saved Lightning refunds may be signed')
  }
  const sweeps: string[] = []
  const identity: Identity = {
    compressedPublicKey: () => readonly.compressedPublicKey(),
    xOnlyPublicKey: () => readonly.xOnlyPublicKey(),
    signMessage: denied,
    signerSession: denied,
    sign: async (tx) => {
      const psbt = hex.encode(tx.toPSBT()),
        facts = sweepFacts(saved, enrolled, destination, psbt, limits, false)
      const result = await sign({ psbt, publicKey: enrolled.phonePub })
      const accepted = sweepFacts(saved, enrolled, destination, result, limits, true)
      if (
        accepted.fee !== facts.fee ||
        accepted.coin.txid !== facts.coin.txid ||
        accepted.coin.vout !== facts.coin.vout
      )
        throw new Error('Lightning signer changed the requested transaction')
      sweeps.push(hex.encode(accepted.tx.toPSBT()))
      return accepted.tx
    },
  }
  const readOnlyChain = new Proxy(onchain, {
    get(target, name) {
      if (name === 'broadcastTransaction')
        return () => {
          throw new Error('Recovery preparation cannot broadcast')
        }
      const member = Reflect.get(target, name, target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
  const onchainWallet = await OnchainWallet.create(identity, pins.sdkNetwork, readOnlyChain)
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: pins.operatorOrigin,
    arkProvider: local.arkProvider,
    indexerProvider: local.indexerProvider,
    onchainProvider: readOnlyChain,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
      exitDataCapture: { mode: 'full', sources: [local.source] },
    },
    walletMode: 'static',
    settlementConfig: { autoRenewVtxos: false, boardingUtxoSweep: false, deprecatedSignerMigration: false },
  })
  try {
    await (await wallet.getContractManager()).createContract({ ...local.contract, state: 'active' })
    const prepared = await UnilateralExit.prepare({
      wallet,
      onchainWallet,
      sweepAddress: destination,
      vtxos: local.coins.map(({ txid, vout }) => ({ txid, vout })),
      mode: 'graph',
      networkName: pins.sdkNetwork,
    })
    const exitPackage = canonicalLightningPackage(saved, enrolled, prepared, sweeps, limits)
    return validateLightningRecoveryPackage(
      { name: 'vaulted-lightning-refund', version: 1, entry: saved, binding: enrolled, exitPackage, sweeps },
      enrolled,
      limits,
    )
  } finally {
    await wallet[Symbol.asyncDispose]()
  }
}
function canonicalLightningPackage(
  entry: LightningRecoveryEntry,
  binding: LightningArchiveBinding,
  pkg: ExitPackage,
  sweeps: string[],
  limits: RecoveryFeeLimits,
) {
  const local = lightningArchiveProviders(entry, binding)
  if (!Array.isArray(sweeps) || sweeps.length !== local.coins.length)
    throw new Error('Lightning refund package is incomplete')
  const signed = sweeps.map((psbt) => {
    const result = sweepFacts(entry, binding, pkg.sweepAddress, psbt, limits, true)
    result.tx.finalize()
    return result
  })
  return canonicalRecoveryGraph({
    archive: entry.exit,
    archiveBinding: local.binding,
    phonePub: binding.phonePub,
    pkg,
    sweeps: signed,
    feeLimits: limits,
  })
}
export function validateLightningRecoveryPackage(
  file: LightningRecoveryPackage,
  expectedBinding: LightningArchiveBinding,
  feeLimits: RecoveryFeeLimits,
) {
  if (
    !file ||
    file.name !== 'vaulted-lightning-refund' ||
    file.version !== 1 ||
    !file.binding ||
    (Object.keys(expectedBinding) as (keyof LightningArchiveBinding)[]).some(
      (key) => file.binding[key] !== expectedBinding[key],
    ) ||
    JSON.stringify(file).length > 24_000_000
  )
    throw new Error('Invalid Lightning refund package')
  const expected = canonicalLightningPackage(file.entry, expectedBinding, file.exitPackage, file.sweeps, feeLimits)
  if (JSON.stringify(file.exitPackage) !== JSON.stringify(expected))
    throw new Error('Lightning refund graph, sweep or delay changed')
  return file
}

/** SDK behavior is deliberate: it packages an absent parent with a fee child;
 * an already-mempool parent is observed until confirmation, without replacement
 * or an independently broadcast CPFP child from this adapter. */
export function executeLightningRecovery(
  file: LightningRecoveryPackage,
  expectedBinding: LightningArchiveBinding,
  feeLimits: RecoveryFeeLimits,
  onchain: OnchainProvider,
  feeWallet: ExitFeeWallet,
  signal?: AbortSignal,
) {
  const snapshot = JSON.parse(JSON.stringify(file)) as LightningRecoveryPackage
  validateLightningRecoveryPackage(snapshot, expectedBinding, feeLimits)
  return new UnilateralExit.Executor(snapshot.exitPackage, onchain, { feeWallet, signal })
}
