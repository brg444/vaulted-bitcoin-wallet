import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { Transaction } from '@scure/btc-signer'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
const fixtures = JSON.parse(readFileSync(new URL('./evidence/ledger-recovery-inputs.json', import.meta.url)))
const devices = JSON.parse(readFileSync(new URL('./evidence/ledger-recovery.json', import.meta.url)))
assert.equal(devices.length, fixtures.length)
const results = []
for (const fixture of fixtures) {
  const device = devices.find((d) => d.tier === fixture.id)
  assert(device?.registered && !device.error)
  assert.equal(device.addresses['0'], fixture.address)
  assert.equal(device.payments.length, fixture.payments.length)
  for (const payment of fixture.payments) {
    const signed = device.payments.find((p) => p.label === payment.label)
    assert.equal(signed.signatures.length, 1)
    const sig = signed.signatures[0]
    assert.equal(sig.index, 0)
    assert.equal(sig.pubkey, payment.hardware)
    const signature = hex.decode(sig.signature)
    assert.equal(signature.length, 64, 'DEFAULT signatures only')
    const opts = { allowUnknownInputs: true, allowUnknownOutputs: true }
    const tx = Transaction.fromPSBT(base64.decode(payment.psbt), opts)
    const input = tx.getInput(0),
      leaf = input.tapLeafScript[0][1].slice(0, -1)
    const digest = (t) =>
      t.preimageWitnessV1(0, [input.witnessUtxo.script], 0, [input.witnessUtxo.amount], undefined, leaf)
    assert(schnorr.verify(signature, digest(tx), hex.decode(payment.hardware)))
    const altered = new Transaction({ version: 2, ...opts })
    altered.addInput({ txid: input.txid, index: input.index, sequence: input.sequence, witnessUtxo: input.witnessUtxo })
    altered.addOutput({ script: input.witnessUtxo.script, amount: tx.getOutput(0).amount })
    assert(!schnorr.verify(signature, digest(altered), hex.decode(payment.hardware)))
    tx.updateInput(0, {
      tapScriptSig: [
        ...(input.tapScriptSig || []),
        [{ pubKey: hex.decode(payment.hardware), leafHash: tapLeafHash(leaf) }, signature],
      ],
    })
    tx.finalize()
    assert(tx.extract().length)
    const recipient = signed.screens
      .filter((s) => /^To(?: \(\d+\/\d+\))? \| /.test(s))
      .map((s) => s.split(' | ').slice(1).join(''))
      .join('')
    assert.equal(recipient, payment.recipient)
    const sats = (label) => {
      const screen = signed.screens.filter((s) => s.startsWith(label + ' | '))
      assert.equal(screen.length, 1)
      const value = screen[0].match(/ \| (\d+)\.(\d{1,8}) TEST$/)
      assert(value)
      return BigInt(value[1]) * 100000000n + BigInt(value[2].padEnd(8, '0'))
    }
    assert.equal(sats('Amount'), BigInt(payment.amount))
    assert.equal(sats('Fees'), BigInt(payment.fee))
    assert.equal(signed.screens.filter((s) => s === 'Sign transaction').length, 1)
    assert(
      !signed.screens.some((s) => /unverified|unusual|blind|unknown|sighash|warning/i.test(s)),
      JSON.stringify(signed.screens),
    )
    results.push({
      policy: fixture.id,
      path: payment.label,
      vsize: tx.vsize,
      defaultSignature: true,
      signatureVerified: true,
      destinationDisplayed: true,
      amountDisplayed: true,
      feeDisplayed: true,
      outputSubstitutionRejected: true,
    })
  }
}
writeFileSync(
  new URL('./evidence/ledger-recovery-verification.json', import.meta.url),
  JSON.stringify(
    { scope: 'Speculos Bitcoin Test 2.4.2; synthetic inputs; live services and physical hardware excluded', results },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify(results, null, 2))
