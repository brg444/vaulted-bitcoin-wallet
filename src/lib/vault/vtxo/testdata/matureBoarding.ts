import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import {
  createBoardingProgramScript,
  getNetwork,
  Transaction,
  type ExtendedCoin,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { vi } from 'vitest'
import type { EnrollmentSecrets } from '../../tenantEnrollment'
import type { BoardingDescriptor, VaultStatus } from '../../types'
import type { VaultLockManager } from '../lock'
import { recoverMatureBoardingInputs } from '../boardingRecovery'
import type { MatureBoardingAttempt } from '../matureBoardingJournal'
import {
  BOARDING_EXIT_DELAY,
  BOARDING_EXIT_DELAY_UNIT,
  BOARDING_PROGRAM,
  BOARDING_SCHEMA,
  BOARDING_TEMPLATE,
  MUTINYNET_OPERATOR_SIGNER_PUB,
} from '../board'

export function scalar(value: number) {
  const out = new Uint8Array(32)
  out[31] = value
  return out
}

export function matureBoardingFixture() {
  const boardingSecret = scalar(1)
  const phoneSecret = scalar(2)
  const cosignerSecret = scalar(3)
  const boardingPub = hex.encode(secp256k1.getPublicKey(boardingSecret, true))
  const phonePub = hex.encode(secp256k1.getPublicKey(phoneSecret, true))
  const cosignerPub = hex.encode(secp256k1.getPublicKey(cosignerSecret, true))
  boardingSecret.fill(0)
  cosignerSecret.fill(0)
  const program = createBoardingProgramScript(
    {
      name: BOARDING_PROGRAM,
      boardingPubKey: hex.decode(boardingPub).slice(1),
      cosignerPubKey: hex.decode(cosignerPub).slice(1),
      recoveryPubKey: hex.decode(phonePub).slice(1),
    },
    hex.decode(MUTINYNET_OPERATOR_SIGNER_PUB).slice(1),
    { type: 'seconds', value: BigInt(BOARDING_EXIT_DELAY) },
  )
  const descriptor: BoardingDescriptor = {
    schema: BOARDING_SCHEMA,
    program: BOARDING_PROGRAM,
    template: BOARDING_TEMPLATE,
    network: 'mutinynet',
    boardingPub,
    recoveryPhonePub: phonePub,
    vaultBoardCosignerPub: cosignerPub,
    operatorPub: MUTINYNET_OPERATOR_SIGNER_PUB,
    exitDelay: BOARDING_EXIT_DELAY,
    exitDelayUnit: BOARDING_EXIT_DELAY_UNIT,
    script: hex.encode(program.pkScript),
    address: program.onchainAddress(getNetwork('mutinynet')),
  }
  const status = {
    enrolled: true,
    vaultId: 'vault-recovery',
    network: 'mutinynet',
    phoneBip340Pub: phonePub,
    vtxoBoardingActive: true,
    vtxoBoardingProgram: BOARDING_PROGRAM,
    vtxoBoardingDescriptor: descriptor,
    vtxoBoardingDescriptorHash: 'ab'.repeat(32),
    vtxoBoardingScript: descriptor.script,
    vtxoBoardingAddress: descriptor.address,
    vtxoBoardingExitDelay: BOARDING_EXIT_DELAY,
    vtxoBoardingExitDelayUnit: BOARDING_EXIT_DELAY_UNIT,
    feerateCapSatVb: 10,
    absoluteFeeCap: 2_000,
  } as VaultStatus
  const mature = {
    txid: '11'.repeat(32),
    vout: 0,
    value: 100_000,
    status: {
      confirmed: true,
      block_height: 1,
      block_time: Math.floor(Date.now() / 1000) - BOARDING_EXIT_DELAY - 1,
    },
    tapTree: program.encode(),
    forfeitTapLeafScript: [] as never,
    intentTapLeafScript: [] as never,
  } satisfies ExtendedCoin
  return {
    descriptor,
    enrollment: { vaultId: status.vaultId } as EnrollmentSecrets,
    mature,
    phoneSecret,
    program,
    status,
  }
}

export function exclusiveVaultLocks(): VaultLockManager {
  const held = new Set<string>()
  return {
    request: async (name, options, run) => {
      if (held.has(name)) {
        if (options.ifAvailable) return run(null)
        throw new Error(`lock ${name} is held`)
      }
      held.add(name)
      try {
        return await run({ held: true })
      } finally {
        held.delete(name)
      }
    },
  }
}

export function memoryAttemptStore() {
  let record: MatureBoardingAttempt | null = null
  let failWrite: Error | null = null
  return {
    loadAttempt: async () => (record ? structuredClone(record) : null),
    persistAttempt: async (_status: VaultStatus, next: MatureBoardingAttempt) => {
      if (failWrite) throw failWrite
      record = structuredClone(next)
      return structuredClone(record)
    },
    fail(error: Error | null) {
      failWrite = error
    },
    get() {
      return record ? structuredClone(record) : null
    },
    set(value: MatureBoardingAttempt | null) {
      record = value ? structuredClone(value) : null
    },
  }
}

export function chainProvider(
  options: {
    feeRate?: number
    broadcast?: (raw: string) => Promise<string>
    txStatus?: (
      txid: string,
    ) => Promise<{ confirmed: false } | { confirmed: true; blockHeight: number; blockTime: number }>
    outspends?: (txid: string) => Promise<{ spent: boolean; txid?: string }[]>
  } = {},
): OnchainProvider & { broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = options.broadcast
    ? vi.fn(options.broadcast)
    : vi.fn(async (raw: string) => Transaction.fromRaw(hex.decode(raw)).id)
  return {
    getFeeRate: async () => options.feeRate ?? 1,
    getCoins: async () => [],
    getTxStatus: async (txid) => {
      if (options.txStatus) return options.txStatus(txid)
      throw new Error('404')
    },
    getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: 'ab'.repeat(32) }),
    getTxOutspends: async (txid) => options.outspends?.(txid) ?? [{ spent: false }],
    getTransactions: async () => [],
    watchAddresses: async () => () => {},
    broadcastTransaction: broadcast,
    broadcast,
  }
}

export function matureCoin(base: ExtendedCoin, txid: string): ExtendedCoin {
  return {
    ...base,
    txid,
    status: {
      confirmed: true,
      block_height: 1,
      block_time: Math.floor(Date.now() / 1000) - BOARDING_EXIT_DELAY - 1,
    },
  }
}

export async function signLiveMatureBoarding(args: {
  enrollment: EnrollmentSecrets
  status: VaultStatus
  inputs: ExtendedCoin[]
  phoneSecret: Uint8Array
  store?: ReturnType<typeof memoryAttemptStore>
  provider?: OnchainProvider
  locks?: VaultLockManager
}) {
  const store = args.store ?? memoryAttemptStore()
  const provider = args.provider ?? chainProvider()
  const txid = await recoverMatureBoardingInputs(args.enrollment, args.status, {
    getBoardingUtxos: async () => args.inputs,
    unlockPhone: async () => args.phoneSecret,
    onchainProvider: provider,
    locks: args.locks ?? exclusiveVaultLocks(),
    loadAttempt: store.loadAttempt,
    persistAttempt: store.persistAttempt,
  })
  return { txid, store, provider }
}
