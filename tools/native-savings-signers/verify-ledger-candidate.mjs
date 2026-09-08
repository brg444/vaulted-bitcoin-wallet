import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { Transaction } from '@scure/btc-signer'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
const input = JSON.parse(readFileSync(new URL('./evidence/ledger-candidate-inputs.json', import.meta.url)))
const result = JSON.parse(
  readFileSync(new URL(process.env.CANDIDATE_RESULTS || './evidence/ledger-candidate.json', import.meta.url)),
)
const report = []
for (const fixture of input) {
  if (process.env.CANDIDATE_TIER && fixture.tier !== process.env.CANDIDATE_TIER) continue
  const device = result.find((r) => r.tier === fixture.tier)
  assert(device?.registered)
  for (const payment of fixture.payments) {
    const signed = device.payments.find((p) => p.full === payment.full)
    assert.equal(signed.signatures.length, 1)
    assert.equal(signed.signatures[0].index, 0)
    assert.equal(signed.signatures[0].pubkey, fixture.hardware)
    const rawSig = hex.decode(signed.signatures[0].signature)
    assert(
      rawSig.length === 64 || (rawSig.length === 65 && rawSig[64] === 1),
      'Canonical DEFAULT or ALL signature required',
    )
    const sighash = rawSig.length === 64 ? 0 : rawSig[64]
    const signature = rawSig.slice(0, 64),
      pubkey = hex.decode(fixture.hardware)
    const tx = Transaction.fromPSBT(base64.decode(payment.psbt), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    assert.equal(tx.inputsLength, 1)
    assert.equal(tx.outputsLength, payment.full ? 1 : 2)
    assert.equal(tx.fee, BigInt(payment.fee))
    const inp = tx.getInput(0),
      leaf = inp.tapLeafScript[0][1].slice(0, -1)
    const digest = (t) =>
      t.preimageWitnessV1(0, [inp.witnessUtxo.script], sighash, [inp.witnessUtxo.amount], undefined, leaf)
    assert(schnorr.verify(signature, digest(tx), pubkey))
    const checks = []
    for (const mutation of ['recipient', 'amount', 'extra-output', 'change']) {
      if (mutation === 'change' && payment.full) continue
      const altered = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
      altered.addInput({ txid: inp.txid, index: inp.index, sequence: inp.sequence, witnessUtxo: inp.witnessUtxo })
      for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i)
        if ((mutation === 'recipient' && i === 0) || (mutation === 'change' && i === 1)) {
          out.script = out.script.slice()
          out.script[out.script.length - 1] ^= 1
        }
        if (mutation === 'amount' && i === 0) out.amount -= 1n
        altered.addOutput(out)
      }
      if (mutation === 'extra-output') altered.addOutput({ script: new Uint8Array([0x6a]), amount: 0n })
      assert(!schnorr.verify(signature, digest(altered), pubkey), mutation)
      checks.push(mutation)
    }
    const sigs = [...inp.tapScriptSig, [{ pubKey: pubkey, leafHash: inp.tapScriptSig[0][0].leafHash }, rawSig]]
    tx.updateInput(0, { tapScriptSig: sigs })
    tx.finalize()
    const recipient = signed.screens
      .filter((s) => /^To(?: \(\d+\/\d+\))? \| /.test(s))
      .map((s) => s.split(' | ').slice(1).join(''))
      .join('')
    assert.equal(recipient, payment.recipient, 'Complete recipient must appear on device screens')
    const displayedSats = (label) => {
      const values = signed.screens.filter((s) => s.startsWith(label + ' | '))
      assert.equal(values.length, 1, 'Exactly one ' + label + ' display expected')
      const parts = values[0].match(/ \| (\d+)\.(\d{1,8}) TEST$/)
      assert(parts, 'Expected Bitcoin Test amount display')
      return BigInt(parts[1]) * 100000000n + BigInt(parts[2].padEnd(8, '0'))
    }
    assert.equal(displayedSats('Amount'), BigInt(payment.amount))
    assert.equal(displayedSats('Fees'), BigInt(payment.fee))
    report.push({
      tier: fixture.tier,
      full: payment.full,
      vsize: tx.vsize,
      sighash,
      signatureVerified: true,
      recipientDisplayed: payment.recipient,
      amountDisplayed: payment.amount,
      feeDisplayed: 1000,
      rejectedMutations: checks,
      raw: hex.encode(tx.extract()),
      validationScope: 'Cryptographic signature and simulator display; synthetic prevout, no funded chain acceptance',
    })
    console.log(
      fixture.tier,
      payment.full ? 'full' : 'partial',
      tx.vsize,
      'vB; signature, recipient, amount, fee and mutations verified',
    )
  }
}
writeFileSync(
  new URL('./evidence/ledger-candidate-verification.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
)
