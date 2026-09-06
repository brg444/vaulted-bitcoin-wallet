import { describe, it, expect } from 'vitest'
import { Transaction, SingleKey } from '@arkade-os/sdk'
import { p2tr } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { scalarSecret, compressedFromScalar } from '../program/fixtures'
import { acceptRecoveryPsbtSignatures } from './signatureImport'

describe('external recovery signature import', () => {
  it('accepts only an authentic DEFAULT signature over the unchanged fee request', async () => {
    const tx = new Transaction({ version: 3 })
    const root = p2tr(hex.decode(compressedFromScalar(3)).slice(1))
    tx.addInput({
      txid: 'ab'.repeat(32),
      index: 0,
      witnessUtxo: { amount: 10000n, script: root.script },
      tapInternalKey: root.tapInternalKey,
    })
    tx.addOutput({ script: root.script, amount: 9000n })
    const request = hex.encode(tx.toPSBT())
    const signed = await SingleKey.fromPrivateKey(scalarSecret(3)).sign(tx)
    expect(acceptRecoveryPsbtSignatures(request, hex.encode(signed.toPSBT()), [compressedFromScalar(3)])).toBe(
      hex.encode(signed.toPSBT()),
    )
    const changed = Transaction.fromPSBT(hex.decode(request))
    changed.updateOutput(0, { amount: 8000n })
    const other = await SingleKey.fromPrivateKey(scalarSecret(3)).sign(changed)
    expect(() => acceptRecoveryPsbtSignatures(request, hex.encode(other.toPSBT()), [compressedFromScalar(3)])).toThrow(
      'changed',
    )
    expect(() => acceptRecoveryPsbtSignatures(request, request, [compressedFromScalar(3)])).toThrow('no signature')
  })
})
