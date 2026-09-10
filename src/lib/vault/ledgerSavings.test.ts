import { describe, expect, it } from 'vitest'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import vectors from './program/ledger-key-vectors.json'
import {
  acceptLedgerSavingsSignatures,
  buildLedgerSavingsPsbt,
  requireLedgerSavingsPhoneApproval,
  signLedgerSavingsWithPhone,
  type LedgerSavingsPayment,
} from './ledgerSavings'
import { finalizeSavingsPsbt, inspectSavingsPsbt } from './savingsSpend'

const opts = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true } as const
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'

describe('native Ledger Savings payments', () => {
  for (const vector of vectors)
    it(`spends and then spends change: ${vector.input.network} ${vector.input.recovery ? 'advanced' : 'standard'}`, () => {
      const { payment, family, phone, signHardware } = ledgerPaymentFixture(vector)
      const approved = signLedgerSavingsWithPhone(payment, phone)
      const first = acceptLedgerSavingsSignatures(payment, approved, signHardware(approved))
      const completed = finalizeSavingsPsbt(first)
      const inspection = inspectSavingsPsbt(first)
      expect(inspection.inputs).toHaveLength(1)
      expect(inspection.outputs).toEqual([
        { script: hex.encode(family.receive.script), amount: 20000 },
        { script: hex.encode(family.change.script), amount: 79000 },
      ])
      expect(inspection.fee).toBe(1000)
      // Use BOTH outputs of a completed transaction to prove mixed origins work.
      const again: LedgerSavingsPayment = {
        ...payment,
        amountSats: 98000,
        coins: [
          { txid: completed.txid, vout: 1, value: 79000, branch: 1, index: 0, parentTxHex: completed.txHex },
          { txid: completed.txid, vout: 0, value: 20000, branch: 0, index: 0, parentTxHex: completed.txHex },
        ],
      }
      const next = signLedgerSavingsWithPhone(again, phone)
      const final = acceptLedgerSavingsSignatures(again, next, signHardware(next, [0, 1]))
      expect(inspectSavingsPsbt(final).outputs).toHaveLength(1)
      expect(finalizeSavingsPsbt(final).txid).toHaveLength(64)
    })

  it('rejects wrong parents, values, branches, indices and duplicate inputs before signing', () => {
    const { payment } = ledgerPaymentFixture()
    const coin = payment.coins[0]
    for (const patch of [
      { txid: 'aa'.repeat(32) },
      { value: 100001 },
      { vout: 1 },
      { vout: 2 ** 32 },
      { branch: 1 },
      { index: 1 },
      { parentTxHex: '00' },
    ])
      expect(() =>
        buildLedgerSavingsPsbt({ ...payment, coins: [{ ...coin, ...patch }] } as LedgerSavingsPayment),
      ).toThrow()
    expect(() => buildLedgerSavingsPsbt({ ...payment, coins: [coin, coin] })).toThrow('duplicate')
    for (const amountSats of [Number.MAX_SAFE_INTEGER, NaN, -1, 20000.1])
      expect(() => buildLedgerSavingsPsbt({ ...payment, amountSats })).toThrow()
  })

  it('rejects legacy scalars or another phone account, not reinterpret them', () => {
    const { payment, hardware } = ledgerPaymentFixture()
    expect(() => signLedgerSavingsWithPhone(payment, hardware)).toThrow('phone HD account')
    expect(() =>
      signLedgerSavingsWithPhone(payment, HDKey.fromExtendedKey(payment.contract.context.phone.xpub)),
    ).toThrow()
  })

  it('rejects substituted outputs, origins, recovery leaves and weakened signing modes', () => {
    const { payment, phone, family, signHardware } = ledgerPaymentFixture()
    const approved = signLedgerSavingsWithPhone(payment, phone)
    const signed = signHardware(approved)
    const altered = (mutate: (tx: Transaction) => void) => {
      const tx = Transaction.fromPSBT(hex.decode(signed), opts)
      mutate(tx)
      return hex.encode(tx.toPSBT())
    }
    // Rebuild a mutable copy before changing signed transaction fields.
    const raw = Transaction.fromPSBT(hex.decode(signed), opts)
    expect(() => acceptLedgerSavingsSignatures({ ...payment, amountSats: 21000 }, approved, signed)).toThrow()
    expect(() =>
      acceptLedgerSavingsSignatures(
        payment,
        approved,
        altered((tx) => tx.updateInput(0, { tapKeySig: new Uint8Array(64) })),
      ),
    ).toThrow()
    expect(() =>
      acceptLedgerSavingsSignatures(
        payment,
        approved,
        altered((tx) => tx.updateInput(0, { sighashType: 0x83 })),
      ),
    ).toThrow()
    const replacement = new Transaction(opts)
    const substituted = Transaction.fromPSBT(hex.decode(approved), opts).getInput(0)
    substituted.tapBip32Derivation![0][1].der.path = [...payment.contract.context.hardware.path, 2, 0]
    replacement.addInput(substituted, true)
    for (let i = 0; i < raw.outputsLength; i++) replacement.addOutput(raw.getOutput(i), true)
    expect(() => requireLedgerSavingsPhoneApproval(payment, hex.encode(replacement.toPSBT()))).toThrow(
      'metadata changed',
    )
    for (const mutate of [
      (tx: Transaction) => tx.updateOutput(0, { amount: 19000n }, true),
      (tx: Transaction) =>
        tx.updateOutput(
          1,
          {
            script: family.receive.script,
            tapTree: undefined,
            tapInternalKey: undefined,
            tapBip32Derivation: undefined,
          },
          true,
        ),
      (tx: Transaction) => tx.addOutput({ script: family.receive.script, amount: 330n }, true),
    ])
      expect(() => acceptLedgerSavingsSignatures(payment, approved, altered(mutate))).toThrow()
    const otherTree = family.change.tapLeafScript!
    expect(() =>
      requireLedgerSavingsPhoneApproval(
        payment,
        altered((tx) => tx.updateInput(0, { tapLeafScript: otherTree })),
      ),
    ).toThrow()
  })
})
