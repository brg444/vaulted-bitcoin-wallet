import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import {
  createBoardingProgramScript,
  getNetwork,
  Transaction,
  type ExtendedCoin,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { EnrollmentSecrets } from '../tenantEnrollment'
import type { BoardingDescriptor, VaultStatus } from '../types'
import {
  MUTINYNET_OPERATOR_SIGNER_PUB,
  BOARDING_EXIT_DELAY,
  BOARDING_EXIT_DELAY_UNIT,
  BOARDING_PROGRAM,
  BOARDING_SCHEMA,
  BOARDING_TEMPLATE,
} from './board'
import {
  acknowledgeMatureBoardingRecovery,
  findMatureBoardingInputs,
  recoverMatureBoardingInputs,
} from './boardingRecovery'
import { validateMatureBoardingRecoveryFile } from './boardingRecoveryFile'
import { matureBoardingOutputSats, type MatureBoardingAttempt } from './matureBoardingJournal'
import type { VaultLockManager } from './lock'
import {
  chainProvider,
  exclusiveVaultLocks,
  matureCoin,
  memoryAttemptStore,
  signLiveMatureBoarding,
} from './testdata/matureBoarding'
import { requireExactDefaultTapscriptSignatures } from '../taprootSignatures'

const availableLocks: VaultLockManager = {
  request: async (_name, _options, run) => run({ held: true }),
}

const secret = (value: number) => {
  const out = new Uint8Array(32)
  out[31] = value
  return out
}

function fixture() {
  const boardingSecret = secret(1)
  const phoneSecret = secret(2)
  const cosignerSecret = secret(3)
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
  const enrollment = { vaultId: status.vaultId } as EnrollmentSecrets
  return { descriptor, enrollment, mature, phoneSecret, program, status }
}

describe('vault-board-v1 one-shot recovery', () => {
  it('discovers only current exact-program confirmed matured inputs', async () => {
    const { mature, status } = fixture()
    const immature = {
      ...mature,
      txid: '22'.repeat(32),
      status: { ...mature.status, block_time: Math.floor(Date.now() / 1000) },
    }
    const unconfirmed = { ...mature, txid: '33'.repeat(32), status: { confirmed: false as const } }
    const foreign = { ...mature, txid: '44'.repeat(32), tapTree: new Uint8Array(mature.tapTree.length) }

    await expect(
      findMatureBoardingInputs(status, {
        getBoardingUtxos: async () => [immature, unconfirmed, foreign, mature],
      }),
    ).resolves.toEqual({ inputs: [mature], totalSats: mature.value })
  })

  it('uses the SDK recovery helper with release fee caps and zeros the phone scalar', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const recover = vi.fn().mockResolvedValue('55'.repeat(32))
    const store = memoryAttemptStore()

    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => phoneSecret,
        recover,
        onchainProvider: {} as OnchainProvider,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).resolves.toBe('55'.repeat(32))
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [mature],
        maxFeeRateSatVb: 10,
        absoluteFeeCapSats: 2_000n,
      }),
    )
    expect(phoneSecret.every((value) => value === 0)).toBe(true)
  })

  it('does not sign or broadcast when Face ID is cancelled', async () => {
    const { enrollment, mature, status } = fixture()
    const recover = vi.fn()
    const store = memoryAttemptStore()
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => {
          throw new Error('The operation was aborted.')
        },
        recover,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow(/aborted/)
    expect(recover).not.toHaveBeenCalled()
  })

  it('refuses a second recovery action while the per-vault lock is held', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const store = memoryAttemptStore()
    let finish!: (txid: string) => void
    const recover = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const locks = exclusiveVaultLocks()
    const first = recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature],
      unlockPhone: async () => phoneSecret,
      recover,
      onchainProvider: {} as OnchainProvider,
      locks,
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
    })
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        locks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow(/already in progress/)
    finish('66'.repeat(32))
    await expect(first).resolves.toBe('66'.repeat(32))
  })

  it('refuses a second-tab recovery while the per-vault lock is held', async () => {
    const { enrollment, mature, status } = fixture()
    const recover = vi.fn()
    const heldLocks: VaultLockManager = {
      request: async (_name, _options, run) => run(null),
    }

    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        recover,
        locks: heldLocks,
      }),
    ).rejects.toThrow(/already in progress/)
    expect(recover).not.toHaveBeenCalled()
  })
})

describe('durable mature boarding recovery', () => {
  it.each([false, true])('does not broadcast when dispatched persistence is cancelled: cancel=%s', async (cancel) => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const abort = new AbortController()
    const store = memoryAttemptStore()
    const provider = chainProvider()
    const result = await recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature],
      unlockPhone: async () => phoneSecret,
      onchainProvider: provider,
      locks: exclusiveVaultLocks(),
      signal: abort.signal,
      loadAttempt: store.loadAttempt,
      persistAttempt: async (nextStatus, next) => {
        const saved = await store.persistAttempt(nextStatus, next)
        if (cancel && next.phase === 'dispatched') abort.abort(new DOMException('Session ended', 'AbortError'))
        return saved
      },
    }).then(
      (txid) => ({ txid, aborted: false }),
      (error) => ({ aborted: error instanceof DOMException && error.name === 'AbortError' }),
    )
    expect(store.get()?.hex).toBeTruthy()
    expect(provider.broadcast).toHaveBeenCalledTimes(cancel ? 0 : 1)
    expect(result.aborted).toBe(cancel)
  })

  it('resumes exact bytes and still fences dispatch after cancelled dispatched persistence', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature],
      phoneSecret,
    })
    const pending = { ...signed.store.get()!, phase: 'signed' as const, conflictTxid: undefined }
    const store = memoryAttemptStore()
    store.set(pending)
    const abort = new AbortController()
    const retry = chainProvider()
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: vi.fn(),
        onchainProvider: retry,
        locks: exclusiveVaultLocks(),
        signal: abort.signal,
        loadAttempt: store.loadAttempt,
        persistAttempt: async (nextStatus, next) => {
          const saved = await store.persistAttempt(nextStatus, next)
          if (next.phase === 'dispatched') abort.abort(new DOMException('Session ended', 'AbortError'))
          return saved
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(retry.broadcast).not.toHaveBeenCalled()
    expect(store.get()).toMatchObject({ txid: pending.txid, hex: pending.hex, phase: 'dispatched' })
  })

  it('cancels after discovery without unlocking or signing', async () => {
    const { enrollment, mature, status } = fixture()
    const recover = vi.fn()
    const unlockPhone = vi.fn()
    const store = memoryAttemptStore()
    let discovered = false
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => {
          discovered = true
          return [mature]
        },
        unlockPhone,
        recover,
        locks: availableLocks,
        check: () => {
          if (discovered) throw new DOMException('Recovery session ended', 'AbortError')
        },
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(unlockPhone).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
    expect(store.get()).toBeNull()
  })

  it('wipes a phone key returned after cancellation and does not sign', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const recover = vi.fn()
    const store = memoryAttemptStore()
    const abort = new AbortController()
    let finish!: (secret: Uint8Array) => void
    const operation = recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature],
      unlockPhone: async () => new Promise((resolve) => (finish = resolve)),
      recover,
      locks: availableLocks,
      signal: abort.signal,
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
    })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    abort.abort()
    finish(phoneSecret)
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(recover).not.toHaveBeenCalled()
    expect(phoneSecret.every((value) => value === 0)).toBe(true)
    expect(store.get()).toBeNull()
  })

  it('fences SDK signing after cancellation without persisting or broadcasting', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const store = memoryAttemptStore()
    const provider = chainProvider()
    let fences = 0
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => phoneSecret,
        onchainProvider: provider,
        locks: availableLocks,
        check: () => {
          fences += 1
          if (fences >= 4) throw new DOMException('Recovery session ended', 'AbortError')
        },
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fences).toBe(4)
    expect(provider.broadcast).not.toHaveBeenCalled()
    expect(store.get()).toBeNull()
    expect(phoneSecret.every((value) => value === 0)).toBe(true)
  })

  it('does not dispatch when the durable write fails and preserves the previous record', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const store = memoryAttemptStore()
    const provider = chainProvider()
    store.fail(new Error('Storage is full'))
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => phoneSecret,
        onchainProvider: provider,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow('Storage is full')
    expect(provider.broadcast).not.toHaveBeenCalled()
    expect(store.get()).toBeNull()

    const signed = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature],
      phoneSecret: secret(2),
    })
    const previous = { ...signed.store.get()!, phase: 'signed' as const, conflictTxid: undefined }
    store.set(previous)
    store.fail(new Error('Storage is full'))
    const retry = chainProvider()
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: vi.fn(),
        onchainProvider: retry,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow('Storage is full')
    expect(retry.broadcast).not.toHaveBeenCalled()
    expect(store.get()).toEqual(previous)
  })

  it('drains an already dispatched broadcast after the session is cancelled', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const store = memoryAttemptStore()
    let finish!: () => void
    const provider = chainProvider({
      broadcast: async (raw) =>
        new Promise((resolve) => {
          finish = () => resolve(Transaction.fromRaw(hex.decode(raw)).id)
        }),
    })
    const abort = new AbortController()
    const operation = recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature],
      unlockPhone: async () => phoneSecret,
      onchainProvider: provider,
      locks: availableLocks,
      signal: abort.signal,
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
    })
    await vi.waitFor(() => expect(provider.broadcast).toHaveBeenCalledOnce())
    expect(store.get()?.phase).toBe('dispatched')
    abort.abort()
    finish()
    await expect(operation).resolves.toMatch(/^[0-9a-f]{64}$/)
    expect(store.get()?.phase).toBe('dispatched')
  })

  it('marks a lost broadcast response uncertain and retries the exact saved bytes', async () => {
    const { enrollment, mature, status } = fixture()
    const firstPhone = secret(2)
    const store = memoryAttemptStore()
    const provider = chainProvider({
      broadcast: async () => {
        throw new Error('lost response')
      },
    })
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => firstPhone,
        onchainProvider: provider,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow('lost response')
    const pending = store.get()
    expect(pending?.phase).toBe('uncertain')
    expect(pending?.hex).toMatch(/^[0-9a-f]+$/)
    const hexBytes = pending!.hex
    const unlockPhone = vi.fn()
    const retry = chainProvider()
    const txid = await recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature],
      unlockPhone,
      onchainProvider: retry,
      locks: availableLocks,
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
    })
    expect(unlockPhone).not.toHaveBeenCalled()
    expect(retry.broadcast).toHaveBeenCalledWith(hexBytes)
    expect(txid).toBe(pending!.txid)
    expect(store.get()?.phase).toBe('dispatched')
  })

  it('reloads a pending signed attempt without constructing a replacement', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature],
      phoneSecret,
    })
    const pending = signed.store.get()!
    expect(pending.phase).toBe('dispatched')
    const unlockPhone = vi.fn()
    const retryStore = memoryAttemptStore()
    retryStore.set({ ...pending, phase: 'signed' })
    const retry = chainProvider()
    const txid = await recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [mature, matureCoin(mature, '22'.repeat(32))],
      unlockPhone,
      onchainProvider: retry,
      locks: availableLocks,
      loadAttempt: retryStore.loadAttempt,
      persistAttempt: retryStore.persistAttempt,
    })
    expect(unlockPhone).not.toHaveBeenCalled()
    expect(txid).toBe(pending.txid)
    expect(retry.broadcast).toHaveBeenCalledWith(pending.hex)
  })

  it('rejects a malformed saved record without signing a replacement', async () => {
    const { enrollment, mature, status } = fixture()
    const unlockPhone = vi.fn()
    const recover = vi.fn()
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone,
        recover,
        locks: availableLocks,
        loadAttempt: async () => {
          throw new Error('Invalid mature boarding recovery attempt')
        },
        persistAttempt: async () => {
          throw new Error('should not persist')
        },
      }),
    ).rejects.toThrow('Invalid mature boarding recovery attempt')
    expect(unlockPhone).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
  })

  it('treats a different spender as conflict and does not reuse the inputs', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature],
      phoneSecret,
    })
    const pending = signed.store.get()!
    const store = memoryAttemptStore()
    store.set({ ...pending, phase: 'uncertain' })
    const unlockPhone = vi.fn()
    const conflict = '99'.repeat(32)
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone,
        onchainProvider: chainProvider({
          outspends: async () => [{ spent: true, txid: conflict }],
        }),
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow(/different transaction/)
    expect(unlockPhone).not.toHaveBeenCalled()
    expect(store.get()?.phase).toBe('conflict')
    expect(store.get()?.conflictTxid).toBe(conflict)
  })

  it('does not treat a missing indexer response as consumption', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature],
      phoneSecret,
    })
    const pending = signed.store.get()!
    const store = memoryAttemptStore()
    store.set({ ...pending, phase: 'uncertain' })
    const retry = chainProvider({
      txStatus: async () => {
        throw new Error('404')
      },
      outspends: async () => {
        throw new Error('404')
      },
    })
    const txid = await recoverMatureBoardingInputs(enrollment, status, {
      getBoardingUtxos: async () => [],
      unlockPhone: vi.fn(),
      onchainProvider: retry,
      locks: availableLocks,
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
    })
    expect(txid).toBe(pending.txid)
    expect(retry.broadcast).toHaveBeenCalledWith(pending.hex)
  })

  it('signs and persists a live multi-input sweep with real recovery signatures', async () => {
    const { descriptor, enrollment, mature, status } = fixture()
    const phone = secret(2)
    const second = matureCoin(mature, '22'.repeat(32))
    const { txid, store, provider } = await signLiveMatureBoarding({
      enrollment,
      status,
      inputs: [mature, second],
      phoneSecret: phone,
    })
    const record = store.get()!
    expect(record.evidence.inputs).toHaveLength(2)
    expect(record.txid).toBe(txid)
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(record.hex)
    const view = validateMatureBoardingRecoveryFile(record.evidence)
    expect(view.txid).toBe(txid)
    expect(view.hex).toBe(record.hex)
    const tx = Transaction.fromPSBT(hex.decode(record.evidence.psbt))
    expect(tx.inputsLength).toBe(2)
    requireExactDefaultTapscriptSignatures(tx, 0, [descriptor.recoveryPhonePub.slice(2)])
    requireExactDefaultTapscriptSignatures(tx, 1, [descriptor.recoveryPhonePub.slice(2)])
    expect(phone.every((value) => value === 0)).toBe(true)
  })

  it('rejects a fee rate above the vault cap before persisting', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const store = memoryAttemptStore()
    const provider = chainProvider({ feeRate: 11 })
    await expect(
      recoverMatureBoardingInputs(enrollment, status, {
        getBoardingUtxos: async () => [mature],
        unlockPhone: async () => phoneSecret,
        onchainProvider: provider,
        locks: availableLocks,
        loadAttempt: store.loadAttempt,
        persistAttempt: store.persistAttempt,
      }),
    ).rejects.toThrow(/fee rate/)
    expect(provider.broadcast).not.toHaveBeenCalled()
    expect(store.get()).toBeNull()
    expect(phoneSecret.every((value) => value === 0)).toBe(true)
  })
})

describe('acknowledgment session fences', () => {
  async function prepared() {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({ enrollment, status, inputs: [mature], phoneSecret })
    const attempt = { ...signed.store.get()!, phase: 'confirmed' as const }
    signed.store.set(attempt)
    const coverage = {
      vaultId: attempt.vaultId,
      network: attempt.network,
      descriptorHash: attempt.descriptorHash,
      fileDigest: 'aa'.repeat(32),
      outputs: [] as const,
    }
    return { status, attempt, store: signed.store, coverage }
  }

  function snapshot(attempt: MatureBoardingAttempt, coverage: Awaited<ReturnType<typeof prepared>>['coverage']) {
    return { coverage, matureBoardingJournal: attempt }
  }

  it.each(['current', 'signal', 'owner'] as const)('fences delayed history: %s', async (mode) => {
    const { status, attempt, store, coverage } = await prepared()
    const abort = new AbortController()
    let current = true
    const retire = vi.fn(async () => null)
    const provider = chainProvider({
      txStatus: async () => ({ confirmed: true, blockHeight: 12, blockTime: 1 }),
      transactions: async () => {
        if (mode === 'signal') abort.abort(new DOMException('Session ended', 'AbortError'))
        if (mode === 'owner') current = false
        return [
          {
            txid: attempt.txid,
            vout: [
              { scriptpubkey_address: attempt.evidence.destination, value: String(matureBoardingOutputSats(attempt)) },
            ],
            status: { confirmed: true, block_time: 1 },
          },
        ]
      },
    })
    const outcome = await acknowledgeMatureBoardingRecovery(status, {
      coverage,
      onchainProvider: provider,
      locks: exclusiveVaultLocks(),
      signal: abort.signal,
      check: () => {
        if (!current) throw new DOMException('Owner replaced', 'AbortError')
      },
      loadAttempt: store.loadAttempt,
      persistAttempt: store.persistAttempt,
      retireAttempt: retire,
      readEvidence: async () => snapshot(attempt, coverage),
    }).catch((error) => (error instanceof DOMException && error.name === 'AbortError' ? false : Promise.reject(error)))
    expect(retire).toHaveBeenCalledTimes(mode === 'current' ? 1 : 0)
    expect(outcome).toBe(mode === 'current')
    expect(store.get()?.phase).toBe('confirmed')
  })

  it.each(['chain', 'file', 'journal'] as const)('fences delayed %s observation before retirement', async (hook) => {
    const { status, attempt, store, coverage } = await prepared()
    const abort = new AbortController()
    const retire = vi.fn(async () => null)
    let loads = 0
    const provider = chainProvider({
      txStatus: async () => {
        if (hook === 'chain') abort.abort(new DOMException('Session ended', 'AbortError'))
        return { confirmed: true, blockHeight: 12, blockTime: 1 }
      },
      transactions: async () => [
        {
          txid: attempt.txid,
          vout: [
            { scriptpubkey_address: attempt.evidence.destination, value: String(matureBoardingOutputSats(attempt)) },
          ],
          status: { confirmed: true, block_time: 1 },
        },
      ],
    })
    const outcome = await acknowledgeMatureBoardingRecovery(status, {
      coverage,
      onchainProvider: provider,
      locks: exclusiveVaultLocks(),
      signal: abort.signal,
      loadAttempt: async () => {
        loads += 1
        if (hook === 'journal' && loads > 1) abort.abort(new DOMException('Session ended', 'AbortError'))
        return store.loadAttempt()
      },
      persistAttempt: store.persistAttempt,
      retireAttempt: retire,
      readEvidence: async () => {
        if (hook === 'file') abort.abort(new DOMException('Session ended', 'AbortError'))
        return snapshot(attempt, coverage)
      },
    }).catch((error) => (error instanceof DOMException && error.name === 'AbortError' ? false : Promise.reject(error)))
    expect(retire).not.toHaveBeenCalled()
    expect(outcome).toBe(false)
    expect(store.get()?.phase).toBe('confirmed')
  })

  it('drains an admitted confirmed write and then fences retirement', async () => {
    const { enrollment, mature, phoneSecret, status } = fixture()
    const signed = await signLiveMatureBoarding({ enrollment, status, inputs: [mature], phoneSecret })
    const pending = { ...signed.store.get()!, phase: 'dispatched' as const, conflictTxid: undefined }
    signed.store.set(pending)
    const abort = new AbortController()
    const retire = vi.fn(async () => null)
    const coverage = {
      vaultId: pending.vaultId,
      network: pending.network,
      descriptorHash: pending.descriptorHash,
      fileDigest: 'aa'.repeat(32),
      outputs: [] as const,
    }
    await expect(
      acknowledgeMatureBoardingRecovery(status, {
        coverage,
        onchainProvider: chainProvider({
          txStatus: async () => ({ confirmed: true, blockHeight: 12, blockTime: 1 }),
          transactions: async () => [
            {
              txid: pending.txid,
              vout: [
                {
                  scriptpubkey_address: pending.evidence.destination,
                  value: String(matureBoardingOutputSats(pending)),
                },
              ],
              status: { confirmed: true, block_time: 1 },
            },
          ],
        }),
        locks: exclusiveVaultLocks(),
        signal: abort.signal,
        loadAttempt: signed.store.loadAttempt,
        persistAttempt: async (nextStatus, next) => {
          const saved = await signed.store.persistAttempt(nextStatus, next)
          if (next.phase === 'confirmed') abort.abort(new DOMException('Session ended', 'AbortError'))
          return saved
        },
        retireAttempt: retire,
        readEvidence: async () => snapshot(pending, coverage),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(signed.store.get()?.phase).toBe('confirmed')
    expect(retire).not.toHaveBeenCalled()
  })
})
