import { describe, expect, it, vi } from 'vitest'
import {
  Transaction,
  OnchainWallet,
  SingleKey,
  getNetwork,
  sequenceToTimelock,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { scalarSecret, compressedFromScalar } from '../program/fixtures'
import { lightningRecoveryFixture } from './testdata/lightningFixtures'
import {
  prepareLightningRecovery,
  validateLightningRecoveryPackage,
  executeLightningRecovery,
  type LightningRecoveryPackage,
} from './lightningRecovery'

const limits = { absoluteFeeCapSats: 5000, feerateCapSatVb: 10 }
function onchain() {
  return {
    getCoins: vi.fn(async () => []),
    getFeeRate: vi.fn(async () => 1),
    getTxStatus: vi.fn(async () => ({ confirmed: true, blockTime: 1, blockHeight: 1 })),
    getChainTip: vi.fn(async () => ({ height: 10000, time: 2_000_000_000, hash: '01'.repeat(32) })),
    getTxOutspends: vi.fn(async () => [{ spent: false }]),
    getTransactions: vi.fn(async () => []),
    watchAddresses: vi.fn(async () => () => {}),
    broadcastTransaction: vi.fn(async () => {
      throw new Error('preparation must not broadcast')
    }),
  } satisfies OnchainProvider
}
function destination(network: 'mainnet' | 'mutinynet') {
  return p2tr(
    hex.decode(compressedFromScalar(23)).slice(1),
    undefined,
    getNetwork(network === 'mainnet' ? 'bitcoin' : 'mutinynet'),
  ).address!
}
const signer =
  (key = 3) =>
  async ({ psbt }: { psbt: string }) => {
    const tx = Transaction.fromPSBT(hex.decode(psbt))
    tx.sign(scalarSecret(key))
    return hex.encode(tx.toPSBT())
  }
async function prepared() {
  const fixture = lightningRecoveryFixture()
  const file = await prepareLightningRecovery(
    fixture.entry,
    fixture.binding,
    destination('mainnet'),
    signer(),
    limits,
    onchain(),
  )
  return { ...fixture, file }
}

describe('saved sender-only Lightning recovery through the current SDK', () => {
  for (const network of ['mainnet', 'mutinynet'] as const)
    for (const nine of [false, true])
      for (const tier of ['standard', 'advanced', 'light']) {
        it(`prepares ${network} ${nine ? 9 : 8}-leaf ${tier} without online cosigners or broadcasting`, async () => {
          const fixture = lightningRecoveryFixture({
            network,
            nine,
            advanced: tier === 'advanced',
            light: tier === 'light',
          })
          const chain = onchain()
          const sign = vi.fn(signer(tier === 'light' ? 1 : 3))
          const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Operator and Guardian unavailable'))
          try {
            const file = await prepareLightningRecovery(
              fixture.entry,
              fixture.binding,
              destination(network),
              sign,
              limits,
              chain,
            )
            expect(sign).toHaveBeenCalledTimes(1)
            expect(sign.mock.calls[0][0]).toMatchObject({ publicKey: fixture.binding.phonePub })
            expect(file.exitPackage.steps.map((s) => s.kind)).toEqual(['bump', 'sweep'])
            const delay = sequenceToTimelock(Number(fixture.contract.params.refundNoReceiverDelay))
            expect(file.exitPackage.vtxos[0].delay).toEqual({ type: delay.type, value: Number(delay.value) })
            expect(validateLightningRecoveryPackage(structuredClone(file), fixture.binding, limits)).toEqual(file)
            expect(chain.broadcastTransaction).not.toHaveBeenCalled()
            expect(fetch).not.toHaveBeenCalled()
          } finally {
            fetch.mockRestore()
          }
        })
      }
  it('rejects transport mutations before the SDK can execute them', async () => {
    const { file, binding } = await prepared()
    const changes: ((file: LightningRecoveryPackage) => void)[] = [
      (f) => {
        f.exitPackage.steps.shift()
      },
      (f) => {
        f.exitPackage.steps.reverse()
      },
      (f) => {
        f.exitPackage.steps.push(f.exitPackage.steps[0])
      },
      (f) => {
        const s = f.exitPackage.steps[0]
        if (s.kind === 'bump') s.parentHex = '00'
      },
      (f) => {
        const s = f.exitPackage.steps[0]
        if (s.kind === 'bump') s.forVtxos = []
      },
      (f) => {
        const s = f.exitPackage.steps[1]
        if (s.kind === 'sweep') s.delay.value = 0
      },
      (f) => {
        f.exitPackage.totals.recoveredSats++
      },
      (f) => {
        f.exitPackage.feeRate = 11
      },
      (f) => {
        f.exitPackage.sweepAddress = destination('mutinynet')
      },
      (f) => {
        f.binding.descriptorHash = '00'.repeat(32)
      },
      (f) => {
        f.entry.contract.params.refundNoReceiverDelay = '1'
      },
      (f) => {
        f.sweeps = []
      },
      (f) => {
        const tx = Transaction.fromPSBT(hex.decode(f.sweeps[0]))
        const sig = tx.getInput(0).tapScriptSig![0][1]
        const original = hex.encode(sig)
        sig[0] ^= 1
        f.sweeps[0] = f.sweeps[0].replace(original, hex.encode(sig))
      },
    ]
    const chain = onchain()
    const feeWallet = await OnchainWallet.create(SingleKey.fromPrivateKey(scalarSecret(22)), 'bitcoin', chain)
    for (const [index, change] of changes.entries()) {
      const copy = structuredClone(file)
      change(copy)
      expect(() => executeLightningRecovery(copy, binding, limits, chain, feeWallet), `mutation ${index}`).toThrow()
    }
    expect(chain.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('rejects a signer changing outputs even when it signs the modified transaction', async () => {
    const { entry, binding } = lightningRecoveryFixture()
    await expect(
      prepareLightningRecovery(
        entry,
        binding,
        destination('mainnet'),
        async ({ psbt }) => {
          const tx = Transaction.fromPSBT(hex.decode(psbt))
          tx.updateOutput(0, { amount: tx.getOutput(0).amount! - 1n })
          tx.sign(scalarSecret(3))
          return hex.encode(tx.toPSBT())
        },
        limits,
        onchain(),
      ),
    ).rejects.toThrow()
  })
  it('rejects missing signatures and refuses a tighter independently supplied fee cap', async () => {
    const { file, entry, binding } = await prepared()
    await expect(
      prepareLightningRecovery(entry, binding, destination('mainnet'), async ({ psbt }) => psbt, limits, onchain()),
    ).rejects.toThrow()
    expect(() => validateLightningRecoveryPackage(file, binding, { ...limits, absoluteFeeCapSats: 0 })).toThrow()
  })
  it('retains confirmed ancestors and unrolls them after a reorg, then resumes without rebroadcast', async () => {
    const { file, binding, tx: parent } = await prepared()
    const confirmed = new Set(['01'.repeat(32)])
    const chain: OnchainProvider = {
      ...onchain(),
      getTxStatus: async (id) => {
        if (!confirmed.has(id)) throw new Error('404 transaction not found')
        return { confirmed: true, blockTime: 1, blockHeight: 1 }
      },
      getCoins: async () => [
        { txid: 'ab'.repeat(32), vout: 0, value: 50000, status: { confirmed: true, block_time: 1, block_height: 1 } },
      ],
      broadcastTransaction: vi.fn(async (...raws: string[]) => {
        for (const raw of raws) confirmed.add(Transaction.fromRaw(hex.decode(raw)).id)
        return Transaction.fromRaw(hex.decode(raws[raws.length - 1])).id
      }),
    }
    const feeWallet = await OnchainWallet.create(SingleKey.fromPrivateKey(scalarSecret(22)), 'bitcoin', chain)
    for await (const event of executeLightningRecovery(file, binding, limits, chain, feeWallet))
      expect(event.status).not.toBe('failed')
    expect(confirmed.has(parent.id)).toBe(true)
    expect(chain.broadcastTransaction).toHaveBeenCalledTimes(2)
    for await (const event of executeLightningRecovery(structuredClone(file), binding, limits, chain, feeWallet))
      expect(event.status).not.toBe('failed')
    expect(chain.broadcastTransaction).toHaveBeenCalledTimes(2)
  })
  it('snapshots the validated graph before returning an executor', async () => {
    const { file, binding } = await prepared()
    const chain = onchain()
    const feeWallet = await OnchainWallet.create(SingleKey.fromPrivateKey(scalarSecret(22)), 'bitcoin', chain)
    const executor = executeLightningRecovery(file, binding, limits, chain, feeWallet)
    const expected = structuredClone(executor.pkg)
    file.exitPackage.steps = []
    file.exitPackage.feeRate = 1000
    expect(executor.pkg).toEqual(expected)
  })
  it('waits on a mempool parent without broadcasting another fee child', async () => {
    const { file, binding, tx: parent } = await prepared()
    const signal = new AbortController()
    const chain: OnchainProvider = {
      ...onchain(),
      getTxStatus: async (id) => {
        if (id === parent.id) {
          signal.abort()
          return { confirmed: false }
        }
        return { confirmed: true, blockTime: 1, blockHeight: 1 }
      },
    }
    const feeWallet = await OnchainWallet.create(SingleKey.fromPrivateKey(scalarSecret(22)), 'bitcoin', chain)
    const run = async () => {
      for await (const event of executeLightningRecovery(file, binding, limits, chain, feeWallet, signal.signal))
        void event
    }
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' })
    expect(chain.broadcastTransaction).not.toHaveBeenCalled()
  })
})
