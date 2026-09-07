import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  Transaction,
  SingleKey,
  createBoardingProgramScript,
  getNetwork,
  recoverBoardingProgram,
  timelockToSequence,
  UnilateralExit,
  type OnchainProvider,
  type ExitPackage,
  type ExtendedCoin,
} from '@arkade-os/sdk'
import { validateVaultRecoveryArchive, type VaultRecoveryArchive } from './recoveryArchive'
import { requireBoardingStatus, requireBoardingDescriptor, BOARDING_PROGRAM } from './board'
import { parseRecoveryKit, type RecoveryKit } from '../program/kit'
import type { BoardingDescriptor } from '../types'
import { networkPins } from '../networkPins'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'

export type BoardingRecoverySource =
  | VaultRecoveryArchive
  | {
      name: 'vaulted-public-boarding-data'
      version: 1
      kit: RecoveryKit
      descriptor: BoardingDescriptor
      onchain: VaultRecoveryArchive['onchain']
    }

export interface BoardingRecoveryFile {
  name: 'vaulted-boarding-recovery'
  version: 1
  archive: BoardingRecoverySource
  psbt: string
}

function facts(archive: BoardingRecoverySource) {
  let descriptor: BoardingDescriptor
  let kit: RecoveryKit
  if (archive.name === 'vaulted-public-boarding-data') {
    if (
      archive.version !== 1 ||
      JSON.stringify(archive).length > 24_000_000 ||
      !Array.isArray(archive.onchain) ||
      archive.onchain.length > 1024
    )
      throw new Error('Invalid public boarding data')
    kit = parseRecoveryKit(archive.kit)
    descriptor = requireBoardingDescriptor(archive.descriptor, {
      vaultId: kit.descriptor.vaultId,
      phonePub: kit.descriptor.keys.phoneBip340,
      boardingPub: archive.descriptor?.boardingPub,
      network: kit.descriptor.network,
    })
    // A public kit supplies the exact Bitcoin boarding script. This source
    // makes no claim about Spending capture or an enrollment composite.
    const seen = new Set<string>()
    for (const coin of archive.onchain) {
      const outpoint = `${coin.txid}:${coin.vout}`
      if (
        !/^[0-9a-f]{64}$/.test(coin.txid) ||
        !Number.isSafeInteger(coin.vout) ||
        coin.vout < 0 ||
        coin.vout > 0xffffffff ||
        !Number.isSafeInteger(coin.value) ||
        coin.value <= 0 ||
        coin.value > 2_100_000_000_000_000 ||
        coin.script !== descriptor.script ||
        seen.has(outpoint) ||
        typeof coin.parentHex !== 'string' ||
        coin.parentHex.length > 8_000_000
      )
        throw new Error('Invalid public boarding output')
      seen.add(outpoint)
      const parent = Transaction.fromRaw(hex.decode(coin.parentHex), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      })
      const output = parent.getOutput(coin.vout)
      if (
        parent.id !== coin.txid ||
        output.amount !== BigInt(coin.value) ||
        hex.encode(output.script!) !== descriptor.script
      )
        throw new Error('Boarding recovery parent changed')
    }
  } else {
    validateVaultRecoveryArchive(archive)
    kit = archive.kit
    const status = archive.status
    descriptor = requireBoardingStatus(status, status.vtxoBoardingDescriptor!.boardingPub)
  }
  const program = {
    name: BOARDING_PROGRAM,
    boardingPubKey: hex.decode(descriptor.boardingPub).slice(1),
    cosignerPubKey: hex.decode(descriptor.vaultBoardCosignerPub).slice(1),
    recoveryPubKey: hex.decode(descriptor.recoveryPhonePub).slice(1),
  }
  const network = getNetwork(networkPins(descriptor.network).sdkNetwork)
  const operatorPubKey = hex.decode(descriptor.operatorPub).slice(1)
  const boardingTimelock = { type: 'seconds' as const, value: BigInt(descriptor.exitDelay) }
  const script = createBoardingProgramScript(program, operatorPubKey, boardingTimelock)
  const destination = p2tr(program.recoveryPubKey, undefined, network).address!
  return {
    descriptor,
    program,
    operatorPubKey,
    boardingTimelock,
    script,
    network,
    destination,
    policy: kit.descriptor.policy,
  }
}

export function validateBoardingRecoveryFile(file: BoardingRecoveryFile) {
  if (
    !file ||
    file.name !== 'vaulted-boarding-recovery' ||
    file.version !== 1 ||
    typeof file.psbt !== 'string' ||
    file.psbt.length > 10_000_000
  )
    throw new Error('Invalid boarding recovery file')
  const f = facts(file.archive)
  const tx = Transaction.fromPSBT(hex.decode(file.psbt))
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1) throw new Error('Boarding recovery must have one exact input')
  const input = tx.getInput(0)
  const coin = file.archive.onchain.find(
    (coin) => coin.txid === hex.encode(input.txid!) && coin.vout === input.index && coin.script === f.descriptor.script,
  )
  if (!coin) throw new Error('Boarding parent is not in the saved archive')
  const output = tx.getOutput(0)
  const fee = coin.value - Number(output.amount)
  const policy = f.policy
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > policy.absoluteFeeCapSats || output.amount! < 330n)
    throw new Error('Boarding recovery fee is outside the vault limits')
  const expected = new Transaction()
  expected.addInput({
    txid: coin.txid,
    index: coin.vout,
    witnessUtxo: { amount: BigInt(coin.value), script: f.script.pkScript },
    tapLeafScript: [f.script.exit()],
    sequence: timelockToSequence(f.boardingTimelock),
  })
  expected.addOutputAddress(f.destination, output.amount!, f.network)
  expected.updateInput(0, { tapScriptSig: input.tapScriptSig })
  if (hex.encode(tx.toPSBT()) !== hex.encode(expected.toPSBT()))
    throw new Error('Boarding recovery destination or metadata changed')
  requireExactDefaultTapscriptSignatures(tx, 0, [f.descriptor.recoveryPhonePub.slice(2)])
  tx.finalize()
  if (fee > Math.ceil(tx.vsize * policy.feerateCapSatVb))
    throw new Error('Boarding recovery fee rate exceeds the vault cap')
  return { ...f, tx, coin, fee }
}

/** The SDK builds/signs the existing recovery path; its final transport is captured locally. */
export async function prepareBoardingRecoveryFile(
  archive: BoardingRecoverySource,
  outpoint: { txid: string; vout: number },
  phone: Uint8Array,
  onchain: OnchainProvider,
): Promise<BoardingRecoveryFile> {
  const saved = JSON.parse(JSON.stringify(archive)) as BoardingRecoverySource
  const requested = { ...outpoint }
  const material = Uint8Array.from(phone)
  let signedPsbt = ''
  try {
    const f = facts(saved)
    const coin = saved.onchain.find(
      (coin) => coin.txid === requested.txid && coin.vout === requested.vout && coin.script === f.descriptor.script,
    )
    if (!coin) throw new Error('Boarding parent is not in the saved archive')
    const status = await onchain.getTxStatus(coin.txid)
    if (!status.confirmed) throw new Error('Boarding parent has not confirmed')
    const owner = SingleKey.fromPrivateKey(material)
    const input: ExtendedCoin = {
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      status: { confirmed: true, block_height: status.blockHeight, block_time: status.blockTime },
      tapTree: f.script.encode(),
      forfeitTapLeafScript: f.script.forfeit(),
      intentTapLeafScript: f.script.forfeit(),
    }
    const txid = await recoverBoardingProgram({
      ...f,
      inputs: [input],
      recoveryIdentity: {
        compressedPublicKey: () => owner.compressedPublicKey(),
        xOnlyPublicKey: () => owner.xOnlyPublicKey(),
        signerSession: () => {
          throw new Error('Boarding recovery does not authorize a batch')
        },
        signMessage: async () => {
          throw new Error('Boarding recovery does not authorize messages')
        },
        sign: async (tx) => {
          const signed = await owner.sign(tx)
          signedPsbt = hex.encode(signed.toPSBT())
          return signed
        },
      },
      maxFeeRateSatVb: f.policy.feerateCapSatVb,
      absoluteFeeCapSats: BigInt(f.policy.absoluteFeeCapSats),
      onchainProvider: new Proxy(onchain, {
        get(target, property) {
          if (property === 'broadcastTransaction')
            return async (raw: string) => {
              const result = validateBoardingRecoveryFile({
                name: 'vaulted-boarding-recovery',
                version: 1,
                archive: saved,
                psbt: signedPsbt,
              })
              if (hex.encode(result.tx.extract()) !== raw)
                throw new Error('SDK boarding recovery changed before capture')
              return result.tx.id
            }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    })
    const file: BoardingRecoveryFile = {
      name: 'vaulted-boarding-recovery',
      version: 1,
      archive: saved,
      psbt: signedPsbt,
    }
    if (validateBoardingRecoveryFile(file).tx.id !== txid) throw new Error('Boarding recovery identity changed')
    return file
  } finally {
    material.fill(0)
  }
}

export function executeBoardingRecoveryFile(
  file: BoardingRecoveryFile,
  onchain: OnchainProvider,
  signal?: AbortSignal,
) {
  const view = validateBoardingRecoveryFile(file)
  const outpoint = `${view.coin.txid}:${view.coin.vout}`
  const delay = { type: 'seconds' as const, value: view.descriptor.exitDelay }
  const pkg: ExitPackage = {
    version: 1,
    mode: 'graph',
    network: networkPins(view.descriptor.network).sdkNetwork,
    createdAt: Math.floor(Date.now() / 1000),
    feeRate: view.fee / view.tx.vsize,
    sweepAddress: view.destination,
    totals: { txCount: 1, totalFeeSats: view.fee, fundingRequiredSats: 0, recoveredSats: view.coin.value - view.fee },
    vtxos: [{ outpoint, value: view.coin.value, sweepFee: view.fee, delay }],
    steps: [
      {
        kind: 'sweep',
        vtxo: outpoint,
        txid: view.tx.id,
        hex: hex.encode(view.tx.extract()),
        dependsOnTxid: view.coin.txid,
        delay,
      },
    ],
  }
  return new UnilateralExit.Executor(pkg, onchain, { signal })
}
