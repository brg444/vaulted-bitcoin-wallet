import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  EsploraProvider,
  SingleKey,
  createBoardingProgramScript,
  getNetwork,
  hasBoardingTxExpired,
  recoverBoardingProgram,
  type ExtendedCoin,
  type Identity,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { zeroBytes } from '../ceremony/directauth'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { VaultStatus } from '../types'
import { unlockPhoneBip340 } from '../savingsSpend'
import { withVaultWalletState } from './walletWorker'
import { browserVaultLockManager, requireVaultLockManager, type VaultLockManager } from './lock'
import { networkPins } from '../networkPins'
import { requireBoardingStatus, BOARDING_PROGRAM } from './board'
import {
  matureBoardingInputSetKey,
  validateMatureBoardingRecoveryFile,
  type MatureBoardingRecoveryFile,
} from './boardingRecoveryFile'
import {
  canRetireMatureBoardingAttempt,
  inspectMatureBoardingConflict,
  loadMatureBoardingAttempt,
  matureBoardingOutputSats,
  persistMatureBoardingAttempt,
  retireMatureBoardingAttempt,
  type MatureBoardingAttempt,
} from './matureBoardingJournal'
import {
  readCommittedRecoveryEvidence,
  type CommittedRecoveryCoverage,
  type CommittedRecoveryEvidence,
} from '../recovery/committedCoverage'

type RecoveryDependencies = {
  getBoardingUtxos?: (status: VaultStatus) => Promise<ExtendedCoin[]>
  unlockPhone?: (enrollment: EnrollmentSecrets, status: VaultStatus, signal?: AbortSignal) => Promise<Uint8Array>
  recover?: typeof recoverBoardingProgram
  onchainProvider?: OnchainProvider
  locks?: VaultLockManager | null
  signal?: AbortSignal
  check?: () => void
  loadAttempt?: (status: VaultStatus) => Promise<MatureBoardingAttempt | null>
  persistAttempt?: (status: VaultStatus, record: MatureBoardingAttempt) => Promise<MatureBoardingAttempt>
  retireAttempt?: typeof retireMatureBoardingAttempt
  readEvidence?: (status: VaultStatus) => Promise<CommittedRecoveryEvidence | null>
}

function exactProgram(status: VaultStatus) {
  const descriptor = requireBoardingStatus(status, String(status.vtxoBoardingDescriptor?.boardingPub || ''))
  const program = {
    name: BOARDING_PROGRAM,
    boardingPubKey: hex.decode(descriptor.boardingPub).slice(1),
    cosignerPubKey: hex.decode(descriptor.vaultBoardCosignerPub).slice(1),
    recoveryPubKey: hex.decode(descriptor.recoveryPhonePub).slice(1),
  } as const
  const pins = networkPins(status.network)
  const operatorPubKey = hex.decode(pins.operatorSignerPub).slice(1)
  const boardingTimelock = { type: 'seconds' as const, value: BigInt(pins.boardExitDelay) }
  const encoded = createBoardingProgramScript(program, operatorPubKey, boardingTimelock).encode()
  return { descriptor, program, operatorPubKey, boardingTimelock, encoded }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function currentBoardingUtxos(status: VaultStatus): Promise<ExtendedCoin[]> {
  return withVaultWalletState(status, ({ wallet }) => wallet.getBoardingUtxos())
}

function providerOf(dependencies: RecoveryDependencies): OnchainProvider {
  return dependencies.onchainProvider || new EsploraProvider('/esplora')
}

function fence(dependencies: RecoveryDependencies) {
  dependencies.signal?.throwIfAborted()
  dependencies.check?.()
}

function bound<T>(target: object, property: PropertyKey): T {
  const value = Reflect.get(target, property)
  return (typeof value === 'function' ? value.bind(target) : value) as T
}

async function inspectAttempt(provider: OnchainProvider, attempt: MatureBoardingAttempt) {
  try {
    const status = await provider.getTxStatus(attempt.txid)
    if (status.confirmed) return { confirmed: true as const, seen: true as const, conflictTxid: undefined }
    return { confirmed: false as const, seen: true as const, conflictTxid: undefined }
  } catch {
    // Missing or failed indexer reads remain uncertain.
  }
  let conflictTxid: string | undefined
  for (const input of attempt.evidence.inputs) {
    try {
      conflictTxid = inspectMatureBoardingConflict(attempt, await provider.getTxOutspends(input.txid), input.vout)
      if (conflictTxid) break
    } catch {
      // Missing outspend evidence cannot prove consumption or authorize reuse.
    }
  }
  return { confirmed: false as const, seen: false as const, conflictTxid }
}

async function persistPhase(
  status: VaultStatus,
  persist: NonNullable<RecoveryDependencies['persistAttempt']>,
  attempt: MatureBoardingAttempt,
  phase: MatureBoardingAttempt['phase'],
  conflictTxid?: string,
) {
  return persist(status, {
    ...attempt,
    phase,
    ...(phase === 'conflict' && conflictTxid ? { conflictTxid } : { conflictTxid: undefined }),
  })
}

async function dispatchExact(
  status: VaultStatus,
  attempt: MatureBoardingAttempt,
  provider: OnchainProvider,
  persist: NonNullable<RecoveryDependencies['persistAttempt']>,
  dependencies: RecoveryDependencies,
) {
  fence(dependencies)
  const dispatched = await persistPhase(status, persist, attempt, 'dispatched')
  fence(dependencies)
  try {
    const txid = await provider.broadcastTransaction(dispatched.hex)
    if (txid !== dispatched.txid) throw new Error('Mature boarding recovery identity changed')
    return txid
  } catch (error) {
    await persistPhase(status, persist, dispatched, 'uncertain').catch(() => undefined)
    throw error
  }
}

async function resumeAttempt(
  status: VaultStatus,
  attempt: MatureBoardingAttempt,
  dependencies: RecoveryDependencies,
  persist: NonNullable<RecoveryDependencies['persistAttempt']>,
) {
  const view = validateMatureBoardingRecoveryFile(attempt.evidence)
  if (view.txid !== attempt.txid || view.hex !== attempt.hex)
    throw new Error('Mature boarding recovery evidence changed')
  fence(dependencies)
  const provider = providerOf(dependencies)
  const inspection = await inspectAttempt(provider, attempt)
  if (inspection.confirmed) {
    if (attempt.phase !== 'confirmed') await persistPhase(status, persist, attempt, 'confirmed')
    return attempt.txid
  }
  if (inspection.conflictTxid) {
    await persistPhase(status, persist, attempt, 'conflict', inspection.conflictTxid)
    throw new Error('Mature boarding recovery inputs were spent by a different transaction')
  }
  return dispatchExact(status, attempt, provider, persist, dependencies)
}

function recoveryIdentity(
  owner: SingleKey,
  capture: (psbt: string) => void,
  dependencies: RecoveryDependencies,
): Identity {
  return {
    compressedPublicKey: () => owner.compressedPublicKey(),
    xOnlyPublicKey: () => owner.xOnlyPublicKey(),
    signerSession: () => {
      throw new Error('Boarding recovery does not authorize a batch')
    },
    signMessage: async () => {
      throw new Error('Boarding recovery does not authorize messages')
    },
    sign: async (tx, indexes) => {
      fence(dependencies)
      const signed = await owner.sign(tx, indexes)
      capture(hex.encode(signed.toPSBT()))
      return signed
    },
  }
}

function captureThenDispatch(
  status: VaultStatus,
  provider: OnchainProvider,
  persistSigned: (raw: string) => Promise<MatureBoardingAttempt>,
  persist: NonNullable<RecoveryDependencies['persistAttempt']>,
  dependencies: RecoveryDependencies,
): OnchainProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'broadcastTransaction') {
        return async (raw: string, ...rest: string[]) => {
          if (rest.length) throw new Error('Boarding recovery broadcasts one transaction')
          const attempt = await persistSigned(raw)
          return dispatchExact(status, attempt, target, persist, dependencies)
        }
      }
      return bound(target, property)
    },
  })
}

export async function findMatureBoardingInputs(
  status: VaultStatus,
  dependencies: RecoveryDependencies = {},
): Promise<{ inputs: ExtendedCoin[]; totalSats: number }> {
  const { boardingTimelock, encoded } = exactProgram(status)
  const inputs = (await (dependencies.getBoardingUtxos || currentBoardingUtxos)(status)).filter(
    (coin) =>
      coin.status.confirmed &&
      equalBytes(Uint8Array.from(coin.tapTree), encoded) &&
      hasBoardingTxExpired(coin, boardingTimelock),
  )
  return {
    inputs,
    totalSats: inputs.reduce((sum, input) => sum + input.value, 0),
  }
}

async function startAttempt(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  dependencies: RecoveryDependencies,
  persist: NonNullable<RecoveryDependencies['persistAttempt']>,
) {
  const { inputs } = await findMatureBoardingInputs(status, dependencies)
  fence(dependencies)
  if (inputs.length === 0) throw new Error('No matured received Bitcoin is ready to recover')
  const { descriptor, program, operatorPubKey, boardingTimelock } = exactProgram(status)
  let phoneSecret: Uint8Array | undefined
  let signedPsbt = ''
  try {
    phoneSecret = await (dependencies.unlockPhone || unlockPhoneBip340)(enrollment, status, dependencies.signal)
    fence(dependencies)
    const owner = SingleKey.fromPrivateKey(phoneSecret)
    const chain = getNetwork(networkPins(status.network).sdkNetwork)
    const destination = p2tr(await owner.xOnlyPublicKey(), undefined, chain).address
    if (!destination) throw new Error('Could not derive the boarding recovery destination')
    if (destination !== p2tr(program.recoveryPubKey, undefined, chain).address) {
      throw new Error('Recovered phone key does not match the vault-board-v1 descriptor')
    }
    const evidenceInputs = inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      value: input.value,
      script: descriptor.script,
    }))
    const persistSigned = async (raw: string) => {
      if (!signedPsbt) throw new Error('Boarding recovery signed before capture')
      const evidence: MatureBoardingRecoveryFile = {
        name: 'vaulted-mature-boarding-recovery',
        version: 1,
        vaultId: status.vaultId,
        network: descriptor.network,
        descriptor,
        inputs: evidenceInputs,
        destination,
        feerateCapSatVb: status.feerateCapSatVb,
        absoluteFeeCapSats: status.absoluteFeeCap,
        psbt: signedPsbt,
      }
      const view = validateMatureBoardingRecoveryFile(evidence)
      if (view.hex !== raw) throw new Error('SDK boarding recovery changed before capture')
      if (matureBoardingInputSetKey(view.inputs) !== matureBoardingInputSetKey(evidenceInputs))
        throw new Error('SDK boarding recovery changed before capture')
      fence(dependencies)
      return persist(status, {
        name: 'vaulted-mature-boarding-attempt',
        version: 1,
        vaultId: status.vaultId,
        network: status.network,
        descriptorHash: status.vtxoBoardingDescriptorHash!,
        evidence,
        txid: view.txid,
        hex: view.hex,
        phase: 'signed',
      })
    }
    const onchainProvider = captureThenDispatch(status, providerOf(dependencies), persistSigned, persist, dependencies)
    const txid = await (dependencies.recover || recoverBoardingProgram)({
      program,
      operatorPubKey,
      boardingTimelock,
      inputs,
      recoveryIdentity: recoveryIdentity(
        owner,
        (psbt) => {
          signedPsbt = psbt
        },
        dependencies,
      ),
      destination,
      network: chain,
      onchainProvider,
      maxFeeRateSatVb: status.feerateCapSatVb,
      absoluteFeeCapSats: BigInt(status.absoluteFeeCap),
    })
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('boarding recovery returned an invalid transaction id')
    return txid
  } finally {
    if (phoneSecret) zeroBytes(phoneSecret)
  }
}

function destinationReceive(
  record: MatureBoardingAttempt,
  txs: Awaited<ReturnType<OnchainProvider['getTransactions']>>,
) {
  const expected = matureBoardingOutputSats(record)
  for (const tx of txs) {
    if (tx.txid !== record.txid || !tx.status?.confirmed) continue
    const paid = tx.vout.reduce((sum, output) => {
      if (output.scriptpubkey_address !== record.evidence.destination) return sum
      const value = Number(output.value)
      return Number.isFinite(value) ? sum + value : sum
    }, 0)
    if (paid === expected) return { txid: record.txid, kind: 'received' as const, amountSats: paid }
  }
  return null
}

function sameCoverage(left: CommittedRecoveryCoverage, right: CommittedRecoveryCoverage) {
  return (
    left.vaultId === right.vaultId &&
    left.network === right.network &&
    left.descriptorHash === right.descriptorHash &&
    left.fileDigest === right.fileDigest
  )
}

/** Retires a confirmed sweep only from committed file evidence and chain observations. */
export async function acknowledgeMatureBoardingRecovery(
  status: VaultStatus,
  options: RecoveryDependencies & { coverage?: CommittedRecoveryCoverage } = {},
): Promise<boolean> {
  const locks = requireVaultLockManager(options.locks === undefined ? browserVaultLockManager() : options.locks)
  const load = options.loadAttempt || loadMatureBoardingAttempt
  const persist =
    options.persistAttempt ||
    ((status: VaultStatus, record: MatureBoardingAttempt) => persistMatureBoardingAttempt(status, record, locks))
  const retire = options.retireAttempt || retireMatureBoardingAttempt
  const readEvidence = options.readEvidence || readCommittedRecoveryEvidence
  return locks.request(`arkade-vault-boarding-recovery:${status.vaultId}`, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error('Web Locks API returned no exclusive boarding recovery lock')
    fence(options)
    const live = await load(status)
    if (!live) return false
    const provider = providerOf(options)
    let confirmation: { txid: string; confirmed: true; blockHeight: number } | undefined
    try {
      const seen = await provider.getTxStatus(live.txid)
      if (seen.confirmed && seen.blockHeight > 0)
        confirmation = { txid: live.txid, confirmed: true, blockHeight: seen.blockHeight }
    } catch {
      return false
    }
    fence(options)
    if (!confirmation) return false
    let current = live
    if (current.phase !== 'confirmed') current = await persistPhase(status, persist, current, 'confirmed')
    fence(options)
    const snapshot = await readEvidence(status)
    fence(options)
    const committed = snapshot?.matureBoardingJournal
    if (
      !snapshot ||
      !committed ||
      committed.txid !== current.txid ||
      committed.hex !== current.hex ||
      (options.coverage && !sameCoverage(options.coverage, snapshot.coverage))
    )
      return false
    let history
    try {
      history = destinationReceive(current, await provider.getTransactions(current.evidence.destination))
    } catch {
      return false
    }
    fence(options)
    if (!history) return false
    const still = await load(status)
    fence(options)
    if (!still || still.txid !== current.txid || still.hex !== current.hex) return false
    const latest = await readEvidence(status)
    fence(options)
    if (!latest || !sameCoverage(latest.coverage, snapshot.coverage) || !latest.matureBoardingJournal) return false
    if (latest.matureBoardingJournal.txid !== committed.txid || latest.matureBoardingJournal.hex !== committed.hex)
      return false
    const evidence = {
      confirmation,
      history,
      recovery: {
        vaultId: committed.vaultId,
        network: committed.network,
        descriptorHash: committed.descriptorHash,
        attemptTxid: committed.txid,
        attemptHex: committed.hex,
      },
    }
    if (still.phase !== 'confirmed' || !canRetireMatureBoardingAttempt(still, evidence)) return false
    try {
      await retire(status, evidence, locks)
    } catch {
      return false
    }
    return true
  })
}

export async function recoverMatureBoardingInputs(
  enrollment: EnrollmentSecrets,
  status: VaultStatus,
  dependencies: RecoveryDependencies = {},
): Promise<string> {
  const locks = requireVaultLockManager(
    dependencies.locks === undefined ? browserVaultLockManager() : dependencies.locks,
  )
  const load = dependencies.loadAttempt || loadMatureBoardingAttempt
  const persist =
    dependencies.persistAttempt ||
    ((status: VaultStatus, record: MatureBoardingAttempt) => persistMatureBoardingAttempt(status, record, locks))
  return locks.request(
    `arkade-vault-boarding-recovery:${status.vaultId}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('boarding recovery is already in progress')
      fence(dependencies)
      const existing = await load(status)
      if (existing) return resumeAttempt(status, existing, dependencies, persist)
      return startAttempt(enrollment, status, dependencies, persist)
    },
  )
}
