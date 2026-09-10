// @vitest-environment node
import { Buffer } from 'buffer'
import { describe, expect, it, vi } from 'vitest'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { ledgerRecoveryFixture, ledgerFixtureSeed } from '../recovery/testdata/ledger'
import { ledgerBip32Versions } from './ledgerNativeKeys'
import { signLedgerSavingsRecoveryWithDevice } from './ledgerRecoveryDevice'
import {
  prepareSavingsRecovery,
  validateSavingsRecovery,
  signLedgerSavingsRecoveryWithSeed,
  finalizeSavingsRecovery,
  type SavingsRecoveryPath,
} from './onchainRecovery'

function hardwareDevice(file: ReturnType<typeof prepareSavingsRecovery>) {
  const view = validateSavingsRecovery(file)
  const context = 'ledgerSavings' in file.kit.descriptor ? file.kit.descriptor.ledgerSavings.context : undefined
  if (!context) throw new Error('Ledger context required')
  const seed = new Uint8Array(32).fill(0x42)
  const nodes: HDKey[] = []
  let key = HDKey.fromMasterSeed(seed, ledgerBip32Versions(context.network))
  nodes.push(key)
  const root = key
  for (const index of context.hardware.path) {
    key = key.deriveChild(index)
    nodes.push(key)
  }
  const account = key.publicExtendedKey
  const app = {
    getMasterFingerprint: vi.fn(async () => root.fingerprint.toString(16).padStart(8, '0')),
    getExtendedPubkey: vi.fn(async () => account),
    registerWallet: vi.fn(
      async (policy: { getId(): Buffer }) => [policy.getId(), Buffer.alloc(32, 4)] as [Buffer, Buffer],
    ),
    getWalletAddress: vi.fn(async () => {
      const path = file.path,
        d = file.kit.descriptor
      return path.program === 'savings-admin'
        ? ('savingsChange' in d && path.change === 1 ? d.savingsChange : d.savings).address
        : (path.program === 'quarantine' ? d.quarantine : d.pending)[`savings-${path.claimant}`].address
    }),
    signPsbt: vi.fn(async (bytes: Buffer) => {
      const tx = Transaction.fromPSBT(bytes),
        derivation = tx
          .getInput(0)
          .tapBip32Derivation!.find(([pub]) => hex.encode(pub) === view.pubs[view.signers.indexOf('hardware')])![1]
      let child = root
      for (const index of derivation.der.path) {
        child = child.deriveChild(index)
        nodes.push(child)
      }
      tx.signIdx(child.privateKey!, 0)
      const [pub, signature] = tx
        .getInput(0)
        .tapScriptSig!.find(([pub]) => hex.encode(pub.pubKey) === view.pubs[view.signers.indexOf('hardware')])!
      return [
        [
          0,
          {
            pubkey: Buffer.from(pub.pubKey),
            tapleafHash: Buffer.from(pub.leafHash),
            signature: Buffer.from(signature),
          },
        ],
      ] as Awaited<ReturnType<Parameters<typeof signLedgerSavingsRecoveryWithDevice>[0]['signPsbt']>>
    }),
  }
  return {
    app,
    clear: () => {
      seed.fill(0)
      nodes.forEach((n) => n.wipePrivateData())
    },
  }
}

describe('Ledger Savings public-kit recovery signing', () => {
  for (const network of ['mainnet', 'mutinynet'] as const)
    it(`registers and signs complete receive/change/pending/quarantine trees on ${network}`, async () => {
      const { kit, archive } = await ledgerRecoveryFixture(false, network)
      const paths: SavingsRecoveryPath[] = [
        { program: 'savings-admin' },
        { program: 'savings-admin', change: 1 },
        { program: 'pending-claim', claimant: 'hardware' },
        { program: 'pending-cancel', claimant: 'phone' },
        { program: 'quarantine', claimant: 'phone' },
      ]
      for (const path of paths) {
        const tree =
          path.program === 'savings-admin'
            ? path.change === 1
              ? kit.descriptor.savingsChange
              : kit.descriptor.savings
            : (path.program === 'quarantine' ? kit.descriptor.quarantine : kit.descriptor.pending)[
                `savings-${path.claimant}`
              ]
        const coin = archive.onchain.find((c) => c.script === tree.script)!
        let file = prepareSavingsRecovery({
          kit,
          path,
          parentHex: coin.parentHex,
          vout: 0,
          destination: kit.descriptor.savings.address,
          feeSats: 200,
        })
        expect(file.version).toBe(2)
        if (path.program === 'savings-admin') file = signLedgerSavingsRecoveryWithSeed(file, ledgerFixtureSeed)
        const device = hardwareDevice(file)
        try {
          const original = structuredClone(file)
          const signed = await signLedgerSavingsRecoveryWithDevice(device.app, file, 'hardware')
          expect(file).toEqual(original)
          expect(validateSavingsRecovery(signed).complete).toBe(true)
          expect(finalizeSavingsRecovery(signed).txid).toMatch(/^[0-9a-f]{64}$/)
          expect(device.app.registerWallet).toHaveBeenCalledTimes(1)
          expect(device.app.getWalletAddress.mock.calls[0]).toBeDefined()
        } finally {
          device.clear()
        }
      }
    }, 30000)
  it('rejects a different device before registration and verifies seed origin and prior signatures', async () => {
    const { kit, archive } = await ledgerRecoveryFixture()
    const file = prepareSavingsRecovery({
      kit,
      path: { program: 'savings-admin' },
      parentHex: archive.onchain[0].parentHex,
      vout: 0,
      destination: kit.descriptor.savings.address,
      feeSats: 200,
    })
    expect(() => signLedgerSavingsRecoveryWithSeed(file, new Uint8Array(32).fill(1))).toThrow()
    const device = hardwareDevice(file)
    device.app.getMasterFingerprint.mockResolvedValue('00000000')
    try {
      await expect(signLedgerSavingsRecoveryWithDevice(device.app, file, 'hardware')).rejects.toThrow(
        'selected recovery account',
      )
      expect(device.app.registerWallet).not.toHaveBeenCalled()
    } finally {
      device.clear()
    }
  }, 15000)
})
