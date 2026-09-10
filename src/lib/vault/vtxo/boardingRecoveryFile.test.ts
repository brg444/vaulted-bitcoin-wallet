import { requireSavingsRecoveryKit } from '../program/kit'
import { describe, expect, it, vi } from 'vitest'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { recoveryFixture } from '../recovery/testdata/helpers'
import { scalarSecret } from '../program/fixtures'
import {
  prepareBoardingRecoveryFile,
  validateBoardingRecoveryFile,
  executeBoardingRecoveryFile,
  type BoardingRecoverySource,
} from './boardingRecoveryFile'

describe('standalone named boarding recovery', () => {
  it.each([
    ['mainnet', 'full'],
    ['mutinynet', 'full'],
    ['mainnet', 'public'],
    ['mutinynet', 'public'],
  ] as const)('uses the SDK phone recovery leaf and resumes on %s from %s data', async (network, sourceKind) => {
    const { archive, board } = recoveryFixture(false, network)
    const parent = new Transaction()
    parent.addInput({ txid: 'ab'.repeat(32), index: 0 })
    parent.addOutput({ amount: 50_000n, script: board.pkScript })
    archive.onchain = [
      {
        txid: parent.id,
        vout: 0,
        value: 50_000,
        script: hex.encode(board.pkScript),
        parentHex: hex.encode(parent.toBytes(true, false)),
      },
    ]
    const source: BoardingRecoverySource =
      sourceKind === 'full'
        ? archive
        : {
            name: 'vaulted-public-boarding-data',
            version: 1,
            kit: archive.kit,
            descriptor: archive.status.vtxoBoardingDescriptor!,
            onchain: archive.onchain,
          }
    const confirmed = new Set([parent.id])
    const broadcast = vi.fn(async (raw: string) => {
      const txid = Transaction.fromRaw(hex.decode(raw)).id
      confirmed.add(txid)
      return txid
    })
    const chain: OnchainProvider = {
      getFeeRate: async () => 1,
      getCoins: async () => [],
      getTxStatus: async (txid) => {
        if (!confirmed.has(txid)) throw new Error('404')
        return { confirmed: true, blockHeight: 1, blockTime: 1 }
      },
      getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: 'ab'.repeat(32) }),
      getTxOutspends: async () => [{ spent: false }],
      getTransactions: async () => [],
      watchAddresses: async () => () => {},
      broadcastTransaction: broadcast,
    }
    const networkRequest = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Guardian and Operator unavailable'))
    try {
      await expect(
        prepareBoardingRecoveryFile(source, { txid: parent.id, vout: 0 }, scalarSecret(4), chain),
      ).rejects.toThrow('identity')
      const phone = scalarSecret(3)
      const requested = { txid: parent.id, vout: 0 }
      const status = chain.getTxStatus
      let changedSource = false
      chain.getTxStatus = async (...args) => {
        if (!changedSource) {
          changedSource = true
          source.onchain[0].value++
          requested.txid = 'ff'.repeat(32)
          phone.fill(0)
        }
        return status(...args)
      }
      const file = await prepareBoardingRecoveryFile(source, requested, phone, chain)
      expect(file.archive.onchain[0].value).toBe(50_000)
      expect(source.onchain[0].value).toBe(50_001)
      expect(phone.every((byte) => byte === 0)).toBe(true)
      expect(broadcast).not.toHaveBeenCalled()
      expect(validateBoardingRecoveryFile(JSON.parse(JSON.stringify(file))).tx.inputsLength).toBe(1)
      for await (const event of executeBoardingRecoveryFile(file, chain)) expect(event.status).not.toBe('failed')
      expect(broadcast).toHaveBeenCalledTimes(1)
      for await (const event of executeBoardingRecoveryFile(file, chain)) expect(event.status).not.toBe('failed')
      expect(broadcast).toHaveBeenCalledTimes(1)
      expect(networkRequest).not.toHaveBeenCalled()
      if (file.archive.name === 'vaulted-public-boarding-data') {
        const mutations: ((
          source: Extract<BoardingRecoverySource, { name: 'vaulted-public-boarding-data' }>,
        ) => void)[] = [
          (source) => {
            source.descriptor.network = network === 'mainnet' ? 'mutinynet' : 'mainnet'
          },
          (source) => {
            source.descriptor.exitDelay++
          },
          (source) => {
            source.descriptor.operatorPub = source.descriptor.boardingPub
          },
          (source) => {
            source.descriptor.recoveryPhonePub = requireSavingsRecoveryKit(source.kit).descriptor.keys.hardware
          },
          (source) => {
            source.descriptor.script = '5120' + '00'.repeat(32)
          },
          (source) => {
            source.kit.descriptorHash = '00'.repeat(32)
          },
          (source) => {
            source.onchain[0].parentHex = '00'
          },
          (source) => {
            source.onchain[0].txid = '00'.repeat(32)
          },
          (source) => {
            source.onchain[0].vout = 1
          },
          (source) => {
            source.onchain[0].script = '5120' + '00'.repeat(32)
          },
          (source) => {
            source.onchain.push(source.onchain[0])
          },
          (source) => {
            source.onchain = []
          },
        ]
        for (const mutate of mutations) {
          const changed = structuredClone(file)
          if (changed.archive.name !== 'vaulted-public-boarding-data') throw new Error('fixture')
          mutate(changed.archive)
          expect(() => validateBoardingRecoveryFile(changed)).toThrow()
        }
      }
      const changed = structuredClone(file)
      changed.archive.onchain[0].value++
      expect(() => validateBoardingRecoveryFile(changed)).toThrow('parent changed')
    } finally {
      networkRequest.mockRestore()
    }
  })
})
