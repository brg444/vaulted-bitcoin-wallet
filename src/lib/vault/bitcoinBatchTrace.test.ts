import { beforeEach, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  SettlementEventType,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import { getLogs } from '../logs'
import { scalarSecret } from './program/fixtures'
import { recoveryFixture } from './recovery/testdata/helpers'
import { exitArchiveProviders, validateExitArchive } from './recovery/exitArchive'
import { vaultRecoveryBinding } from './vtxo/recoveryArchive'
import { traceBitcoinBatch } from './bitcoinBatchTrace'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

it.each(['mainnet', 'mutinynet'] as const)('traces the real SDK participation decision on %s', async (network) => {
  const f = recoveryFixture(false, network)
  const binding = vaultRecoveryBinding(f.kit, f.status)
  const provider = new RestArkProvider('https://operator.invalid')
  vi.spyOn(provider, 'getInfo').mockResolvedValue(validateExitArchive(f.archive.spending, binding).info)
  const ack = vi.spyOn(provider, 'confirmRegistration').mockResolvedValue(undefined)
  const wallet = await Wallet.create({
    identity: SingleKey.fromPrivateKey(scalarSecret(3)),
    arkProvider: provider,
    indexerProvider: exitArchiveProviders(f.archive.spending, binding).indexerProvider,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    walletMode: 'static',
    settlementConfig: false,
  })
  try {
    const id = '55618613-1b4f-4783-b98f-86094193da39'
    const hash = hex.encode(sha256(new TextEncoder().encode(id)))
    const markParticipating = vi.fn()
    const handler = traceBitcoinBatch(wallet.createBatchHandler(id, [], []), markParticipating)
    const event = {
      type: SettlementEventType.BatchStarted as const,
      id: 'test-batch',
      batchExpiry: 2591744n,
      intentIdHashes: [] as string[],
    }
    expect(await handler.onBatchStarted(event)).toEqual({ skip: true })
    expect(ack).not.toHaveBeenCalled()
    expect(markParticipating).not.toHaveBeenCalled()
    expect(getLogs().at(-1)?.msg).toContain('not selected')
    expect(await handler.onBatchStarted({ ...event, intentIdHashes: [hash] })).toEqual({ skip: false })
    expect(ack).toHaveBeenCalledExactlyOnceWith(id)
    expect(markParticipating).toHaveBeenCalledOnce()
    expect(getLogs().at(-1)?.msg).toContain('participation acknowledged')

    const failure = new Error('confirmation session not started')
    ack.mockRejectedValue(failure)
    await expect(handler.onBatchStarted({ ...event, intentIdHashes: [hash] })).rejects.toBe(failure)
    expect(getLogs().at(-1)?.msg).toContain('participation failed: confirmation session not started')

    ack.mockClear()
    await expect(handler.onBatchStarted({ ...event, intentIdHashes: [hash], batchExpiry: 1n })).rejects.toThrow()
    expect(ack).not.toHaveBeenCalled()
    expect(getLogs().at(-1)?.msg).toContain('participation failed: batch expiry rejected')
  } finally {
    await wallet.dispose()
  }
})
