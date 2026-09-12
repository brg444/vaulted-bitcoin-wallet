import { sha256 } from '@noble/hashes/sha2.js'
import { canonicalLedgerValue } from './ledgerEnrollment'
import kitVectors from './ledger-recovery-kit-vectors.json'
import { describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { ledgerRecoveryFixture } from '../recovery/testdata/ledger'
import { isLedgerRecoveryKit, type LedgerRecoveryKit } from './kit'
import { ledgerBip32Versions, ledgerRecoveryChild, ledgerSavingsChild } from './ledgerNativeKeys'
import type { Claimant } from './constants'
import {
  prepareSavingsRecovery,
  validateSavingsRecovery,
  acceptSavingsRecoverySignature,
  finalizeSavingsRecovery,
  executeSavingsRecovery,
  type SavingsRecoveryFile,
  type SavingsRecoveryPath,
} from './onchainRecovery'

const opts = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const
function fixture(path: SavingsRecoveryPath, kit: LedgerRecoveryKit) {
  const parent = new Transaction(opts)
  parent.addInput({ txid: 'ab'.repeat(32), index: 0 })
  const tree =
    path.program === 'savings-admin'
      ? path.change === 1
        ? kit.descriptor.savingsChange
        : kit.descriptor.savings
      : (path.program === 'quarantine' ? kit.descriptor.quarantine : kit.descriptor.pending)[`savings-${path.claimant}`]
  parent.addOutput({ script: hex.decode(tree.script), amount: 50_000n })
  return prepareSavingsRecovery({
    kit,
    path,
    parentHex: hex.encode(parent.toBytes(true, false)),
    vout: 0,
    destination: kit.descriptor.savings.address,
    feeSats: 200,
  })
}

function partial(file: SavingsRecoveryFile, role: Claimant) {
  if (!isLedgerRecoveryKit(file.kit)) throw new Error('Ledger fixture required')
  const context = file.kit.descriptor.ledgerSavings.context
  const seed = new Uint8Array(32).fill({ phone: 0x43, hardware: 0x42, recovery: 0x44 }[role])
  const nodes: HDKey[] = []
  try {
    let account = HDKey.fromMasterSeed(seed, ledgerBip32Versions(context.network))
    nodes.push(account)
    for (const index of context[role]!.path) {
      account = account.deriveChild(index)
      nodes.push(account)
    }
    const child =
      file.path.program === 'savings-admin'
        ? ledgerSavingsChild(account, file.path.change ?? 0)
        : ledgerRecoveryChild(
            account,
            file.path.program === 'pending-claim'
              ? 'claim'
              : file.path.program === 'pending-cancel'
                ? 'cancel'
                : 'quarantine',
          )
    nodes.push(child)
    const tx = Transaction.fromPSBT(hex.decode(file.psbt), opts)
    tx.signIdx(child.privateKey!, 0)
    return hex.encode(tx.toPSBT())
  } finally {
    seed.fill(0)
    nodes.forEach((node) => node.wipePrivateData())
  }
}
function sign(file: SavingsRecoveryFile) {
  let result = file
  for (const role of validateSavingsRecovery(file).signers) {
    result = acceptSavingsRecoverySignature(result, partial(result, role), role)
  }
  return result
}

describe('independent Ledger Savings recovery transactions', () => {
  it.each(kitVectors.cases)(
    'preserves committed kit and every unsigned path on $network advanced=$advanced',
    async (vector) => {
      const { kit, archive } = await ledgerRecoveryFixture(vector.advanced, vector.network as 'mainnet' | 'mutinynet')
      expect(hex.encode(sha256(new TextEncoder().encode(canonicalLedgerValue(kit))))).toBe(vector.kitSha256)
      for (const expected of vector.transactions) {
        const path = expected.path as SavingsRecoveryPath
        const tree =
          path.program === 'savings-admin'
            ? path.change === 1
              ? kit.descriptor.savingsChange
              : kit.descriptor.savings
            : (path.program === 'quarantine' ? kit.descriptor.quarantine : kit.descriptor.pending)[
                `savings-${path.claimant}`
              ]
        const coin = archive.onchain.find((c) => c.script === tree.script)!
        const file = prepareSavingsRecovery({
          kit,
          path,
          parentHex: coin.parentHex,
          vout: coin.vout,
          destination: kit.descriptor.savings.address,
          feeSats: 200,
        })
        expect(hex.encode(sha256(hex.decode(file.psbt)))).toBe(expected.psbtSha256)
        expect(() => validateSavingsRecovery({ ...file, version: 1 } as unknown as SavingsRecoveryFile)).toThrow(
          'Invalid Savings recovery file',
        )
      }
    },
  )

  it.each([false, true])('prepares and signs every allowed Savings path (advanced=%s)', async (advanced) => {
    const { kit } = await ledgerRecoveryFixture(advanced)
    const roles = advanced ? (['phone', 'hardware', 'recovery'] as const) : (['phone', 'hardware'] as const)
    const paths: SavingsRecoveryPath[] = [
      { program: 'savings-admin' },
      { program: 'savings-admin', change: 1 },
      ...roles.flatMap((claimant) => [
        { program: 'pending-claim' as const, claimant },
        { program: 'pending-cancel' as const, claimant },
        { program: 'quarantine' as const, claimant },
      ]),
    ]
    for (const path of paths) {
      const file = fixture(path, kit)
      expect(() => finalizeSavingsRecovery(file)).toThrow('Every required')
      const signed = sign(file)
      const final = finalizeSavingsRecovery(JSON.parse(JSON.stringify(signed)))
      expect(Transaction.fromRaw(hex.decode(final.txHex), opts).id).toBe(final.txid)
      if (path.program === 'pending-claim')
        expect(validateSavingsRecovery(signed).sequence).toBe(
          file.kit.descriptor.pending[`savings-${path.claimant}`].delay,
        )
    }
  })
  it('rejects changed parent, control block, destination and missing prior signatures', async () => {
    const file = fixture({ program: 'savings-admin' }, (await ledgerRecoveryFixture(true)).kit)
    expect(() => validateSavingsRecovery({ ...file, vout: 1 })).toThrow('parent output')
    const phoneSigned = acceptSavingsRecoverySignature(file, partial(file, 'phone'), 'phone')
    expect(() => acceptSavingsRecoverySignature(phoneSigned, partial(file, 'hardware'), 'hardware')).toThrow(
      'retain prior',
    )
    expect(() => validateSavingsRecovery({ ...phoneSigned, feeSats: 201 })).toThrow('metadata changed')
    const changed = Transaction.fromPSBT(hex.decode(file.psbt), opts)
    const leaf = changed.getInput(0).tapLeafScript![0]
    leaf[0].internalKey[0] ^= 1
    changed.updateInput(0, { tapLeafScript: [leaf] }, true)
    expect(() => validateSavingsRecovery({ ...file, psbt: hex.encode(changed.toPSBT()) })).toThrow()
  })
  it.each(kitVectors.cases)(
    'requires every remaining cancellation key on $network advanced=$advanced',
    async ({ advanced, network }) => {
      const { kit } = await ledgerRecoveryFixture(advanced, network as 'mainnet' | 'mutinynet')
      const roles: Claimant[] = advanced ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']
      for (const claimant of roles) {
        const file = fixture({ program: 'pending-cancel', claimant }, kit)
        const required = roles.filter((role) => role !== claimant)
        expect(validateSavingsRecovery(file).signers).toEqual(required)
        expect(() => acceptSavingsRecoverySignature(file, file.psbt, claimant)).toThrow('not required')
        let signed = file
        for (const role of required) {
          expect(() => finalizeSavingsRecovery(signed)).toThrow('Every required')
          const psbt = partial(signed, role)
          const invalid = Transaction.fromPSBT(hex.decode(psbt), opts)
          const inputs = (invalid as unknown as { inputs: ReturnType<Transaction['getInput']>[] }).inputs
          inputs[0].tapScriptSig = inputs[0].tapScriptSig!.map(([key]) => [key, new Uint8Array(64)])
          expect(() => acceptSavingsRecoverySignature(signed, hex.encode(invalid.toPSBT()), role)).toThrow(
            /Invalid signature/,
          )
          signed = acceptSavingsRecoverySignature(signed, psbt, role)
        }
        expect(validateSavingsRecovery(signed).complete).toBe(true)
        expect(finalizeSavingsRecovery(signed).txid).toMatch(/^[0-9a-f]{64}$/)
      }
    },
  )
  it('resumes exact signed bytes after lost broadcast response and checks maturity again after a reorg', async () => {
    const file = sign(
      fixture({ program: 'pending-claim', claimant: 'hardware' }, (await ledgerRecoveryFixture(true)).kit),
    )
    const final = finalizeSavingsRecovery(file)
    const delay = validateSavingsRecovery(file).sequence
    const chain = {
      status: vi.fn(async () => ({ confirmed: true, blockHeight: 100 })),
      tipHeight: vi.fn(async () => 100 + delay - 2),
      outspend: vi.fn(async () => ({ spent: false, txid: undefined as string | undefined })),
      broadcast: vi.fn(async () => {
        throw new Error('lost response')
      }),
    }
    await expect(executeSavingsRecovery(file, chain)).rejects.toThrow('delay')
    expect(chain.broadcast).not.toHaveBeenCalled()
    chain.tipHeight.mockResolvedValue(100 + delay - 1)
    await expect(executeSavingsRecovery(file, chain)).rejects.toThrow('lost response')
    expect(chain.broadcast).toHaveBeenCalledWith(final.txHex)
    chain.outspend.mockResolvedValue({ spent: true, txid: final.txid })
    expect((await executeSavingsRecovery(file, chain)).confirmed).toBe(true)
    expect(chain.broadcast).toHaveBeenCalledTimes(1)
    chain.outspend.mockResolvedValue({ spent: false, txid: undefined })
    chain.status.mockResolvedValue({ confirmed: false, blockHeight: 100 })
    await expect(executeSavingsRecovery(file, chain)).rejects.toThrow('delay')
  })
})
