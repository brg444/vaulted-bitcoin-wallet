import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { decryptRecoveryBackup, validateVaultRecoveryFile, type VaultRecoveryFile } from './backupCodec'
import { recoveryFileStore } from './fileStore'
import { createPortableRecoveryPackage, parsePortableRecoveryPackage, portableRecoverySource } from './portable'
import { executeMatureBoardingRecoveryFile, validateMatureBoardingRecoveryFile } from '../vtxo/boardingRecoveryFile'
import { loadMatureBoardingAttempt } from '../vtxo/matureBoardingJournal'
import { signedPortableMatureBoarding } from './testdata/matureBoardingPortable'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const pending = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', {
    locks: {
      request: (key: string, run: () => Promise<unknown>) => {
        const next = (pending.get(key) ?? Promise.resolve()).then(run)
        pending.set(
          key,
          next.catch(() => undefined),
        )
        return next
      },
    },
  })
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function mockBitcoin(broadcast: (raw: string) => Promise<string>): OnchainProvider & {
  broadcastTransaction: ReturnType<typeof vi.fn>
} {
  const broadcastTransaction = vi.fn(broadcast)
  return {
    getFeeRate: async () => 1,
    getCoins: async () => [],
    getTxStatus: async () => {
      throw new Error('404')
    },
    getChainTip: async () => ({ height: 10000, time: 2_000_000_000, hash: 'ab'.repeat(32) }),
    getTxOutspends: async () => [{ spent: false }],
    getTransactions: async () => [],
    watchAddresses: async () => () => {},
    broadcastTransaction,
  }
}

async function forgetLiveWalletState() {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
}

describe('independent mature boarding recovery', () => {
  it.each(['mainnet', 'mutinynet'] as const)(
    'exports a two-input signed attempt, forgets live state, and exact-byte executes on %s',
    async (network) => {
      const networkRequest = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('services unavailable'))
      const { f, live, file, key, txid } = await signedPortableMatureBoarding(network)
      const view = validateMatureBoardingRecoveryFile(live.evidence)
      expect(view.inputs).toHaveLength(2)
      expect(view.txid).toBe(txid)
      expect(view.hex).toBe(live.hex)
      expect(view.destination).toBe(live.evidence.destination)
      expect(live.evidence.network).toBe(network)
      expect(view.descriptor.network).toBe(network)

      const storedKey = file.header.binding.descriptorHash
      await recoveryFileStore(storedKey, file)
      expect((await recoveryFileStore<VaultRecoveryFile>(storedKey))?.matureBoardingJournal?.txid).toBe(live.txid)

      const portable = JSON.parse(JSON.stringify(await createPortableRecoveryPackage(file, key)))
      const pkg = parsePortableRecoveryPackage(portable)
      const readable = portableRecoverySource(pkg)
      expect(readable.name).toBe('vaulted-readable-recovery')
      expect('matureBoardingJournal' in readable).toBe(false)

      await forgetLiveWalletState()
      expect(await recoveryFileStore(storedKey)).toBeNull()
      expect(await loadMatureBoardingAttempt(f.status)).toBeNull()

      const opened = validateVaultRecoveryFile(await decryptRecoveryBackup(pkg.backup, key))
      const journal = opened.matureBoardingJournal
      if (!journal) throw new Error('Saved mature boarding recovery is missing')
      expect(journal.txid).toBe(live.txid)
      expect(journal.hex).toBe(live.hex)
      expect(journal.evidence.inputs).toEqual(live.evidence.inputs)
      expect(journal.evidence.destination).toBe(live.evidence.destination)
      expect(journal.evidence.psbt).toBe(live.evidence.psbt)
      expect(journal.evidence.vaultId).toBe(opened.header.status.vaultId)
      expect(journal.evidence.network).toBe(opened.header.status.network)
      const independent = validateMatureBoardingRecoveryFile(journal.evidence)
      expect(independent.txid).toBe(view.txid)
      expect(independent.hex).toBe(view.hex)
      expect(independent.inputs).toEqual(view.inputs)
      expect(Number(independent.tx.getOutput(0).amount)).toBe(Number(view.tx.getOutput(0).amount))

      const bitcoin = mockBitcoin(async (raw) => Transaction.fromRaw(hex.decode(raw)).id)
      await expect(executeMatureBoardingRecoveryFile(journal.evidence, bitcoin)).resolves.toBe(view.txid)
      expect(bitcoin.broadcastTransaction).toHaveBeenCalledWith(view.hex)
      expect(networkRequest).not.toHaveBeenCalled()

      const alteredBytes = structuredClone(journal.evidence)
      alteredBytes.psbt = '00'
      expect(() => validateMatureBoardingRecoveryFile(alteredBytes)).toThrow()
      const altered = structuredClone(journal.evidence)
      altered.inputs[0].value += 1
      expect(() => validateMatureBoardingRecoveryFile(altered)).toThrow()
      const foreign = structuredClone(journal.evidence)
      foreign.vaultId = `other-${foreign.vaultId}`
      foreign.network = network === 'mainnet' ? 'mutinynet' : 'mainnet'
      expect(() => validateMatureBoardingRecoveryFile(foreign)).toThrow()
      expect(bitcoin.broadcastTransaction).toHaveBeenCalledTimes(1)
    },
    90_000,
  )
})
