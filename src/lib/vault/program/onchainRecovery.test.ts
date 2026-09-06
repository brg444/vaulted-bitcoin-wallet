import { describe, expect, it, vi } from 'vitest'
import { hex } from '@scure/base'
import { Transaction, p2tr } from '@scure/btc-signer'
import { vaultAddressNetwork } from '../addressNetwork'
import { CONNECTOR_TEMPLATE } from './connector'
import { buildVaultProgramDescriptor } from './descriptor'
import { buildRecoveryKit } from './kit'
import { PROGRAM_FIXTURE, scalarSecret } from './fixtures'
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
function fixture(path: SavingsRecoveryPath, advanced = true, connector = false) {
  const kit = buildRecoveryKit(
    buildVaultProgramDescriptor({
      ...PROGRAM_FIXTURE,
      protectionTier: advanced ? 'advanced' : 'standard',
      recoveryPub: advanced ? PROGRAM_FIXTURE.recoveryPub : undefined,
      ...(connector ? { templateVersion: CONNECTOR_TEMPLATE, connectorType: 'p2tr' as const } : {}),
    }),
  )
  const parent = new Transaction(opts)
  parent.addInput({ txid: 'ab'.repeat(32), index: 0 })
  const tree =
    path.program === 'savings-admin'
      ? kit.descriptor.savings
      : (path.program === 'quarantine' ? kit.descriptor.quarantine : kit.descriptor.pending)[`savings-${path.claimant}`]
  parent.addOutput({ script: hex.decode(tree.script), amount: 50_000n })
  return prepareSavingsRecovery({
    kit,
    path,
    parentHex: hex.encode(parent.toBytes(true, false)),
    vout: 0,
    destination: p2tr(hex.decode(PROGRAM_FIXTURE.hardwarePub).slice(1), undefined, vaultAddressNetwork('mutinynet'))
      .address!,
    feeSats: 200,
  })
}
function sign(file: SavingsRecoveryFile) {
  let result = file
  for (const role of validateSavingsRecovery(file).signers) {
    const tx = Transaction.fromPSBT(hex.decode(result.psbt), opts)
    tx.sign(scalarSecret(role === 'phone' ? 3 : role === 'hardware' ? 4 : 5))
    result = acceptSavingsRecoverySignature(result, hex.encode(tx.toPSBT()), role)
  }
  return result
}

describe('independent Savings recovery transactions', () => {
  it.each([false, true])('prepares and signs every allowed Savings path (advanced=%s)', (advanced) => {
    const roles = advanced ? (['phone', 'hardware', 'recovery'] as const) : (['phone', 'hardware'] as const)
    const paths: SavingsRecoveryPath[] = [
      { program: 'savings-admin' },
      ...roles.flatMap((claimant) => [
        { program: 'pending-claim' as const, claimant },
        { program: 'quarantine' as const, claimant },
      ]),
    ]
    for (const path of paths) {
      const file = fixture(path, advanced)
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
  it.each([false, true])('preserves connector paths and remaining-key cancellation (advanced=%s)', (advanced) => {
    expect(() => fixture({ program: 'savings-admin' }, advanced, true)).toThrow('Connector Savings')
    const file = fixture({ program: 'pending-cancel', claimant: 'phone' }, advanced, true)
    expect(validateSavingsRecovery(file).signers).toEqual(advanced ? ['hardware', 'recovery'] : ['hardware'])
    expect(finalizeSavingsRecovery(sign(file)).txid).toMatch(/^[0-9a-f]{64}$/)
  })
  it('rejects changed parent, control block, destination and missing prior signatures', () => {
    const file = fixture({ program: 'savings-admin' })
    expect(() => validateSavingsRecovery({ ...file, vout: 1 })).toThrow('parent output')
    const tx = Transaction.fromPSBT(hex.decode(file.psbt), opts)
    tx.sign(scalarSecret(3))
    const phoneSigned = acceptSavingsRecoverySignature(file, hex.encode(tx.toPSBT()), 'phone')
    const replaced = Transaction.fromPSBT(hex.decode(file.psbt), opts)
    replaced.sign(scalarSecret(4))
    expect(() => acceptSavingsRecoverySignature(phoneSigned, hex.encode(replaced.toPSBT()), 'hardware')).toThrow(
      'retain prior',
    )
    expect(() => validateSavingsRecovery({ ...phoneSigned, feeSats: 201 })).toThrow('metadata changed')
    const changed = Transaction.fromPSBT(hex.decode(file.psbt), opts)
    const leaf = changed.getInput(0).tapLeafScript![0]
    leaf[0].internalKey[0] ^= 1
    changed.updateInput(0, { tapLeafScript: [leaf] }, true)
    expect(() => validateSavingsRecovery({ ...file, psbt: hex.encode(changed.toPSBT()) })).toThrow()
  })
  it('resumes exact signed bytes after lost broadcast response and checks maturity again after a reorg', async () => {
    const file = sign(fixture({ program: 'pending-claim', claimant: 'hardware' }))
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
