import { describe, expect, it, vi } from 'vitest'
import { Transaction, OnchainWallet, SingleKey, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { scalarSecret } from '../program/fixtures'
import { recoveryFixture, sharedSpendingRecoveryFixture } from '../recovery/testdata/helpers'
import {
  prepareVaultSpendingRecovery,
  validateSpendingRecoveryPackage,
  executeVaultSpendingRecovery,
} from './spendingRecovery'

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

describe('current SDK Spending recovery with required signer sets', () => {
  it('prepares the shared Light exit with the phone alone and no Guardian or Operator', async () => {
    const { archive } = sharedSpendingRecoveryFixture()
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Services unavailable'))
    try {
      const sign = vi.fn(async ({ psbt, requiredKeys }) => {
        expect(requiredKeys.map((key: { role: string }) => key.role)).toEqual(['phone'])
        const tx = Transaction.fromPSBT(hex.decode(psbt))
        tx.sign(new Uint8Array(32).fill(7))
        return hex.encode(tx.toPSBT())
      })
      const file = await prepareVaultSpendingRecovery(archive, archive.status.vtxoBoardingAddress!, sign, onchain())
      expect(sign).toHaveBeenCalled()
      expect(validateSpendingRecoveryPackage(JSON.parse(JSON.stringify(file)))).toBeTruthy()
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })

  it('unrolls a saved parent with a real SDK fee child and resumes without rebroadcasting', async () => {
    const { archive, tx: parent } = recoveryFixture(false)
    const confirmed = new Set(['01'.repeat(32)])
    const chain: OnchainProvider = {
      ...onchain(),
      getTxStatus: async (txid) => {
        if (!confirmed.has(txid)) throw new Error('404 transaction not found')
        return { confirmed: true, blockTime: 1, blockHeight: 1 }
      },
      getCoins: async () => [
        { txid: 'ab'.repeat(32), vout: 0, value: 50_000, status: { confirmed: true, block_time: 1, block_height: 1 } },
      ],
      broadcastTransaction: vi.fn(async (...raws: string[]) => {
        for (const raw of raws) confirmed.add(Transaction.fromRaw(hex.decode(raw)).id)
        return Transaction.fromRaw(hex.decode(raws[raws.length - 1])).id
      }),
    }
    const file = await prepareVaultSpendingRecovery(
      archive,
      archive.kit.descriptor.savings.address,
      async ({ psbt }) => {
        const tx = Transaction.fromPSBT(hex.decode(psbt))
        tx.sign(scalarSecret(3))
        tx.sign(scalarSecret(4))
        return hex.encode(tx.toPSBT())
      },
      chain,
    )
    expect(file.exitPackage.steps.map((step) => step.kind)).toEqual(['bump', 'sweep'])
    expect(chain.broadcastTransaction).not.toHaveBeenCalled()
    const feeWallet = await OnchainWallet.create(SingleKey.fromPrivateKey(scalarSecret(22)), 'mutinynet', chain)
    for await (const event of executeVaultSpendingRecovery(file, chain, feeWallet))
      expect(event.status).not.toBe('failed')
    expect(confirmed.has(parent.id)).toBe(true)
    expect(chain.broadcastTransaction).toHaveBeenCalledTimes(2)
    for await (const event of executeVaultSpendingRecovery(JSON.parse(JSON.stringify(file)), chain, feeWallet))
      expect(event.status).not.toBe('failed')
    expect(chain.broadcastTransaction).toHaveBeenCalledTimes(2)
  })
  it.each([false, true])(
    'prepares an actual SDK graph with every required signature (advanced=%s)',
    async (advanced) => {
      const { archive } = recoveryFixture(advanced)
      const chain = onchain()
      const sign = vi.fn(async ({ psbt, requiredKeys }) => {
        expect(requiredKeys.map((key: { role: string }) => key.role)).toEqual(
          advanced ? ['hardware', 'recovery'] : ['phone', 'hardware'],
        )
        const tx = Transaction.fromPSBT(hex.decode(psbt))
        tx.sign(scalarSecret(4))
        tx.sign(scalarSecret(advanced ? 5 : 3))
        return hex.encode(tx.toPSBT())
      })
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Guardian and Operator unavailable'))
      try {
        const file = await prepareVaultSpendingRecovery(archive, archive.kit.descriptor.savings.address, sign, chain)
        expect(sign).toHaveBeenCalledTimes(1)
        expect(file.exitPackage.steps.filter((step) => step.kind === 'sweep')).toHaveLength(1)
        expect(validateSpendingRecoveryPackage(JSON.parse(JSON.stringify(file)))).toEqual(file)
        for (const change of [
          (copy: typeof file) => {
            copy.exitPackage.steps = copy.exitPackage.steps.filter((step) => step.kind === 'sweep')
          },
          (copy: typeof file) => {
            const step = copy.exitPackage.steps[0]
            if (step.kind === 'bump') step.forVtxos = []
          },
          (copy: typeof file) => {
            copy.exitPackage.steps.reverse()
          },
        ]) {
          const copy = structuredClone(file)
          change(copy)
          expect(() => validateSpendingRecoveryPackage(copy)).toThrow('graph')
        }
        expect(chain.broadcastTransaction).not.toHaveBeenCalled()
        expect(network).not.toHaveBeenCalled()
        const changed = structuredClone(file)
        const sweep = changed.exitPackage.steps.find((step) => step.kind === 'sweep')!
        if (sweep.kind === 'sweep') sweep.delay.value = 0
        expect(() => validateSpendingRecoveryPackage(changed)).toThrow('delay changed')
      } finally {
        network.mockRestore()
      }
    },
  )
  it('refuses a package when only one of the required keys signs', async () => {
    const { archive } = recoveryFixture(true)
    await expect(
      prepareVaultSpendingRecovery(
        archive,
        archive.kit.descriptor.savings.address,
        async ({ psbt }) => {
          const tx = Transaction.fromPSBT(hex.decode(psbt))
          tx.sign(scalarSecret(4))
          return hex.encode(tx.toPSBT())
        },
        onchain(),
      ),
    ).rejects.toThrow()
  })
})
