import { requireSavingsRecoveryKit } from '../program/kit'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { connectorTestSecret } from '../../../test/e2e-vault/fixtures/connector'
import { validateVaultRecoveryFile } from '../recovery/backupCodec'
import { prepareVaultSpendingRecovery, validateSpendingRecoveryPackage } from './spendingRecovery'

const directory = process.env.VAULT_SETUP_RECOVERY_DRILL
it.skipIf(!directory)(
  'prepares a signed unilateral exit from the funded setup archive with the Guardian and Operator offline',
  async () => {
    if (!directory || !isAbsolute(directory)) throw new Error('Private absolute Mutinynet drill directory required')
    const file = validateVaultRecoveryFile(
      JSON.parse(readFileSync(join(directory, 'complete-recovery-private.json'), 'utf8')),
    )
    if (file.archive.status.network !== 'mutinynet') throw new Error('Mutinynet drill only')
    const saved = JSON.parse(readFileSync(join(directory, 'private-wallet.json'), 'utf8'))
    const phone = hex.decode(saved.phoneSecret)
    const hardware = saved.hardwareSecret ? hex.decode(saved.hardwareSecret) : connectorTestSecret()
    const commitment = readFileSync(join(directory, 'commitment.hex'), 'utf8').trim()
    const commitmentId = Transaction.fromRaw(hex.decode(commitment)).id
    const bitcoin = JSON.parse(readFileSync(join(directory, 'commitment.json'), 'utf8'))
    const result = JSON.parse(readFileSync(join(directory, 'complete.json'), 'utf8'))
    expect(bitcoin.txid).toBe(commitmentId)
    expect(bitcoin.status.confirmed).toBe(true)
    const broadcast = vi.fn(async (): Promise<string> => {
      throw new Error('Offline preparation must not broadcast')
    })
    const chain: OnchainProvider = {
      getCoins: async () => [],
      getFeeRate: async () => 1,
      getTxStatus: async (id) => {
        if (id !== commitmentId) throw new Error('404 transaction not found')
        return { confirmed: true, blockHeight: bitcoin.status.block_height, blockTime: bitcoin.status.block_time }
      },
      getChainTip: async () => ({
        height: bitcoin.status.block_height,
        time: bitcoin.status.block_time,
        hash: bitcoin.status.block_hash,
      }),
      getTxOutspends: async () => [],
      getTransactions: async () => [],
      watchAddresses: async () => () => {},
      broadcastTransaction: broadcast,
    }
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Guardian and Operator offline'))
    try {
      const pkg = await prepareVaultSpendingRecovery(
        file.archive,
        requireSavingsRecoveryKit(file.archive.kit).descriptor.savings.address,
        async ({ psbt, requiredKeys }) => {
          expect(requiredKeys.map((key) => key.role)).toEqual(['phone', 'hardware'])
          const tx = Transaction.fromPSBT(hex.decode(psbt))
          tx.sign(phone)
          tx.sign(hardware)
          return hex.encode(tx.toPSBT())
        },
        chain,
        async (id) => {
          if (id !== commitmentId) throw new Error('Missing Bitcoin commitment in local drill')
          return commitment
        },
      )
      validateSpendingRecoveryPackage(JSON.parse(JSON.stringify(pkg)))
      expect(pkg.sweeps).toHaveLength(1)
      const sweep = Transaction.fromPSBT(hex.decode(pkg.sweeps[0]))
      expect(sweep.getInput(0).witnessUtxo?.amount).toBe(BigInt(result.replacement.value))
      expect(sweep.getInput(0).tapScriptSig).toHaveLength(2)
      expect(network).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()
      writeFileSync(join(directory, 'signed-exit-private.json'), JSON.stringify(pkg), { mode: 0o600 })
    } finally {
      phone.fill(0)
      hardware.fill(0)
      network.mockRestore()
    }
  },
  60000,
)
