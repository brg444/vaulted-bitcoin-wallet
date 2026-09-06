import { canonicalRecoveryGraph } from '../recovery/graphPackage'
import { hex } from '@scure/base'
import {
  Wallet,
  ArkAddress,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  ReadonlySingleKey,
  Transaction,
  UnilateralExit,
  contractHandlers,
  timelockToSequence,
  type Identity,
  type ExitPackage,
  type ExitFeeWallet,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { scriptHexFromAddress, bitcoinDustSats } from '../bitcoin'
import { networkPins } from '../networkPins'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'
import { VaultPolicyV1ContractHandler } from './contractHandler'
import { vaultPolicyV1ScriptFromStatus } from './spend'
import {
  validateVaultRecoveryArchive,
  vaultArchiveProviders,
  vaultRecoveryBinding,
  type VaultRecoveryArchive,
} from './recoveryArchive'

// Registered only by explicit recovery preparation, never by the online worker.
const RECOVERY_TYPE = 'vault-policy-v1-recovery'
export function registerVaultSpendingRecoveryHandler() {
  if (contractHandlers.has(RECOVERY_TYPE)) return
  const handler: typeof VaultPolicyV1ContractHandler = {
    ...VaultPolicyV1ContractHandler,
    type: RECOVERY_TYPE,
    getAllSpendingPaths: (script, _contract, context) =>
      context.collaborative
        ? []
        : [{ leaf: script.exit(), sequence: timelockToSequence({ type: 'seconds', value: script.params.exitDelay }) }],
  }
  contractHandlers.register(handler)
}

export interface SpendingRecoveryPackage {
  name: 'vaulted-spending-recovery'
  version: 1
  archive: VaultRecoveryArchive
  exitPackage: ExitPackage
  /** Preserves signatures and full signing metadata independently of final witnesses. */
  sweeps: string[]
}
export type SpendingRecoverySigner = (request: {
  psbt: string
  requiredKeys: { role: 'phone' | 'hardware' | 'recovery'; publicKey: string }[]
}) => Promise<string>

function sweepFacts(archive: VaultRecoveryArchive, destination: string, psbt: string, complete: boolean) {
  const local = vaultArchiveProviders(archive)
  const script = vaultPolicyV1ScriptFromStatus(archive.status)
  const tx = Transaction.fromPSBT(hex.decode(psbt))
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1)
    throw new Error('Recovery sweep must have one input and one output')
  const input = tx.getInput(0)
  const coin = local.coins.find((coin) => coin.txid === hex.encode(input.txid!) && coin.vout === input.index)
  if (!coin) throw new Error('Recovery sweep input is not in the saved archive')
  const output = tx.getOutput(0)
  const fee = coin.value - Number(output.amount)
  if (
    !Number.isSafeInteger(fee) ||
    fee < 0 ||
    fee > archive.kit.descriptor.policy.absoluteFeeCapSats ||
    Number(output.amount) < bitcoinDustSats(destination, archive.status.network)
  )
    throw new Error('Recovery sweep fee is outside the vault limits')
  const expected = new Transaction({ version: 2 })
  expected.addInput({
    txid: coin.txid,
    index: coin.vout,
    tapLeafScript: [script.exit()],
    sequence: timelockToSequence({ type: 'seconds', value: script.params.exitDelay }),
    witnessUtxo: { amount: BigInt(coin.value), script: script.pkScript },
    sighashType: 0,
  })
  expected.addOutput({
    amount: output.amount,
    script: hex.decode(scriptHexFromAddress(destination, archive.status.network)),
  })
  const keys = archive.kit.descriptor.keys
  const requiredKeys: Parameters<SpendingRecoverySigner>[0]['requiredKeys'] = keys.recovery
    ? [
        { role: 'hardware', publicKey: keys.hardware },
        { role: 'recovery', publicKey: keys.recovery },
      ]
    : [
        { role: 'phone', publicKey: keys.phoneBip340 },
        { role: 'hardware', publicKey: keys.hardware },
      ]
  const signatures = input.tapScriptSig ?? []
  if (signatures.length) expected.updateInput(0, { tapScriptSig: signatures })
  if (hex.encode(tx.toPSBT()) !== hex.encode(expected.toPSBT()))
    throw new Error('Recovery sweep transaction or metadata changed')
  const pubs = requiredKeys.map((key) => key.publicKey.slice(2))
  if (complete) requireExactDefaultTapscriptSignatures(tx, 0, pubs)
  else if (signatures.length) {
    const signed = signatures.map(([key]) => hex.encode(key.pubKey))
    if (signed.some((key) => !pubs.includes(key))) throw new Error('Unexpected recovery key')
    requireExactDefaultTapscriptSignatures(tx, 0, signed)
  }
  return { tx, coin, fee, requiredKeys }
}

export async function prepareVaultSpendingRecovery(
  archive: VaultRecoveryArchive,
  destination: string,
  sign: SpendingRecoverySigner,
  onchain: OnchainProvider = new EsploraProvider('/esplora'),
): Promise<SpendingRecoveryPackage> {
  validateVaultRecoveryArchive(archive)
  scriptHexFromAddress(destination, archive.status.network)
  registerVaultSpendingRecoveryHandler()
  const local = vaultArchiveProviders(archive)
  if (!local.coins.length) throw new Error('No saved Spending outputs to recover')
  const pins = networkPins(archive.status.network)
  const readonly = ReadonlySingleKey.fromPublicKey(hex.decode(archive.kit.descriptor.keys.phoneBip340))
  const denied = (): never => {
    throw new Error('Only the saved recovery sweeps may be signed')
  }
  const sweeps: string[] = []
  const identity: Identity = {
    compressedPublicKey: () => readonly.compressedPublicKey(),
    xOnlyPublicKey: () => readonly.xOnlyPublicKey(),
    signMessage: denied,
    signerSession: denied,
    sign: async (tx) => {
      const psbt = hex.encode(tx.toPSBT())
      const facts = sweepFacts(archive, destination, psbt, false)
      const signed = await sign({ psbt, requiredKeys: facts.requiredKeys })
      const accepted = sweepFacts(archive, destination, signed, true)
      // A signer cannot change the requested amount/fee even to another valid fee.
      if (
        accepted.fee !== facts.fee ||
        accepted.coin.txid !== facts.coin.txid ||
        accepted.coin.vout !== facts.coin.vout
      )
        throw new Error('Recovery signer changed the requested transaction')
      sweeps.push(hex.encode(accepted.tx.toPSBT()))
      return accepted.tx
    },
  }
  const onchainWallet = await OnchainWallet.create(identity, pins.sdkNetwork, onchain)
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: pins.operatorOrigin,
    arkProvider: local.arkProvider,
    indexerProvider: local.indexerProvider,
    onchainProvider: onchain,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
      exitDataCapture: { mode: 'full', sources: [local.source] },
    },
    walletMode: 'static',
    settlementConfig: { autoRenewVtxos: false, boardingUtxoSweep: false, deprecatedSignerMigration: false },
  })
  try {
    const script = vaultPolicyV1ScriptFromStatus(archive.status)
    await (
      await wallet.getContractManager()
    ).createContract({
      type: RECOVERY_TYPE,
      label: 'Spending recovery',
      params: VaultPolicyV1ContractHandler.serializeParams(script.params),
      script: hex.encode(script.pkScript),
      address: new ArkAddress(script.params.arkdServerPub, script.tweakedPublicKey, pins.arkHrp).encode(),
      state: 'active',
    })
    const preparedPackage = await UnilateralExit.prepare({
      wallet,
      onchainWallet,
      sweepAddress: destination,
      vtxos: local.coins.map(({ txid, vout }) => ({ txid, vout })),
      mode: 'graph',
      networkName: pins.sdkNetwork,
    })
    const exitPackage = canonicalSpendingPackage(archive, preparedPackage, sweeps)
    const result: SpendingRecoveryPackage = {
      name: 'vaulted-spending-recovery',
      version: 1,
      archive,
      exitPackage,
      sweeps,
    }
    validateSpendingRecoveryPackage(result)
    return result
  } finally {
    await wallet[Symbol.asyncDispose]()
  }
}

/** Complete ancestor transport makes confirmation/reorg status an execution concern. */
function canonicalSpendingPackage(archive: VaultRecoveryArchive, pkg: ExitPackage, sweeps: string[]): ExitPackage {
  validateVaultRecoveryArchive(archive)
  if (!Array.isArray(sweeps)) throw new Error('Recovery sweeps are missing')
  const signed = sweeps.map((psbt) => {
    const facts = sweepFacts(archive, pkg.sweepAddress, psbt, true)
    facts.tx.finalize()
    return {
      ...facts,
      delay: { type: 'seconds' as const, value: archive.status.vtxoExitDelay! },
      path: `${RECOVERY_TYPE}:unilateral`,
    }
  })
  return canonicalRecoveryGraph({
    archive: archive.spending,
    archiveBinding: vaultRecoveryBinding(archive.kit, archive.status),
    phonePub: archive.kit.descriptor.keys.phoneBip340,
    pkg,
    sweeps: signed,
    feeLimits: archive.kit.descriptor.policy,
  })
}

export function validateSpendingRecoveryPackage(file: SpendingRecoveryPackage) {
  if (!file || file.name !== 'vaulted-spending-recovery' || file.version !== 1)
    throw new Error('Invalid Spending recovery package')
  const expected = canonicalSpendingPackage(file.archive, file.exitPackage, file.sweeps)
  if (JSON.stringify(file.exitPackage) !== JSON.stringify(expected))
    throw new Error('Recovery graph, sweep or delay changed')
  return file
}

export function executeVaultSpendingRecovery(
  file: SpendingRecoveryPackage,
  onchain: OnchainProvider,
  feeWallet: ExitFeeWallet,
  signal?: AbortSignal,
) {
  const snapshot = JSON.parse(JSON.stringify(file)) as SpendingRecoveryPackage
  validateSpendingRecoveryPackage(snapshot)
  return new UnilateralExit.Executor(snapshot.exitPackage, onchain, { feeWallet, signal })
}
