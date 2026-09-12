import { hex } from '@scure/base'
import { Address, TEST_NETWORK, Transaction } from '@scure/btc-signer'
import { describe, expect, it } from 'vitest'
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'
import { acceptLedgerSavingsSignatures, buildLedgerSavingsPsbt, signLedgerSavingsWithPhone } from './ledgerSavings'
import { finalizeSavingsPsbt, inspectSavingsPsbt, psbtFile, psbtHexToBase64, readPsbtFile } from './savingsSpend'

describe('shared native Savings PSBT handling', () => {
  it('exports and reads the canonical binary PSBT', async () => {
    const { payment } = ledgerPaymentFixture()
    const psbt = buildLedgerSavingsPsbt(payment)
    const file = psbtFile(psbt)
    expect(file.name).toBe('arkade-savings.psbt')
    expect(file.size).toBeGreaterThan(20)
    expect(psbtHexToBase64(psbt).length).toBeGreaterThan(20)
    await expect(readPsbtFile(file)).resolves.toBe(psbt)
    await expect(readPsbtFile(new File([], 'empty.psbt'))).rejects.toThrow('smaller than 1 MB')
  })
  it('enforces script-specific recipient dust', () => {
    const { payment } = ledgerPaymentFixture()
    const destAddress = Address(TEST_NETWORK).encode({ type: 'pkh', hash: new Uint8Array(20).fill(1) })
    const build = (amountSats: number) => buildLedgerSavingsPsbt({ ...payment, destAddress, amountSats })
    expect(() => build(330)).toThrow('at least ₿546')
    expect(inspectSavingsPsbt(build(546)).outputs[0].amount).toBe(546)
  })
  it('requires the exact retained phone signature and transaction before accepting hardware', () => {
    const { payment, phone, signHardware } = ledgerPaymentFixture()
    const approved = signLedgerSavingsWithPhone(payment, phone)
    const signed = signHardware(approved)
    expect(() => acceptLedgerSavingsSignatures(payment, approved, approved)).toThrow()
    const final = acceptLedgerSavingsSignatures(payment, approved, signed)
    expect(finalizeSavingsPsbt(final).txid).toMatch(/^[0-9a-f]{64}$/)
    const retry = signLedgerSavingsWithPhone(payment, phone)
    expect(() => acceptLedgerSavingsSignatures(payment, retry, signed)).toThrow(/phone Savings signature/)
    expect(() => acceptLedgerSavingsSignatures({ ...payment, amountSats: 19000 }, approved, signed)).toThrow()
  })
  it('rejects invalid hardware signatures and non-default signing modes', () => {
    const { payment, phone, signHardware, hardware } = ledgerPaymentFixture()
    const approved = signLedgerSavingsWithPhone(payment, phone)
    const signed = signHardware(approved)
    const pub = hex.encode(hardware.deriveChild(0).deriveChild(0).publicKey!.slice(1))
    const altered = Transaction.fromPSBT(hex.decode(signed))
    const signatures = altered.getInput(0).tapScriptSig!
    const internal = altered as unknown as { inputs: ReturnType<Transaction['getInput']>[] }
    internal.inputs[0].tapScriptSig = signatures.map(([data, sig]) => [
      data,
      hex.encode(data.pubKey) === pub ? new Uint8Array(64) : sig,
    ])
    expect(() => acceptLedgerSavingsSignatures(payment, approved, hex.encode(altered.toPSBT()))).toThrow(
      /Invalid signature/,
    )
    internal.inputs[0].tapScriptSig = signatures
    internal.inputs[0].sighashType = 1
    expect(() => acceptLedgerSavingsSignatures(payment, approved, hex.encode(altered.toPSBT()))).toThrow()
  })
})
