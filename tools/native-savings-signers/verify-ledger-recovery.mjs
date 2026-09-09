import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { Transaction } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
const evidence = (file) => new URL('./evidence/' + file, import.meta.url)
const fixtures = JSON.parse(readFileSync(evidence('ledger-recovery-inputs.json')))
let devices = JSON.parse(readFileSync(evidence('ledger-recovery.json')))
const expected = {
  'standard-phone-pending': ['clawback', 'cancel'],
  'standard-phone-quarantine': ['release'],
  'standard-hardware-pending': ['claim'],
  'advanced-phone-pending': ['clawback', 'cancel'],
  'advanced-phone-quarantine': ['release'],
  'advanced-hardware-pending': ['claim'],
  'advanced-recovery-pending': ['clawback', 'cancel'],
  'advanced-recovery-quarantine': ['release'],
  'standard-hardware-normal': ['initiate-receive', 'initiate-change'],
  'advanced-hardware-normal': ['initiate-receive', 'initiate-change'],
}
const isInitiation = (id) => id.endsWith('-hardware-normal')
let mergedRun
if (process.argv.includes('--merge-hardware-initiation')) {
  const baseline = (file) =>
    execFileSync('git', ['show', `f1feaa82:tools/native-savings-signers/evidence/${file}`], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    })
  const baselineDevices = baseline('ledger-recovery.json')
  const retained = devices.filter((row) => !isInitiation(row.tier))
  assert.deepEqual(retained, JSON.parse(baselineDevices), 'preserve the existing eleven device cases')
  assert.deepEqual(
    fixtures.filter((row) => !isInitiation(row.id)),
    JSON.parse(baseline('ledger-recovery-inputs.json')),
    'preserve the existing policy inputs',
  )
  const supplementalBytes = readFileSync(evidence('ledger-recovery-hardware-initiation.json'))
  const supplemental = JSON.parse(supplementalBytes)
  assert.equal(supplemental.length, 2)
  assert(supplemental.every((row) => isInitiation(row.tier) && row.caseSet === 'hardware-initiation'))
  devices = [...retained, ...supplemental]
  mergedRun = {
    retained: {
      commit: 'f1feaa82',
      policies: 8,
      payments: 11,
      rawDeviceSha256: createHash('sha256').update(baselineDevices).digest('hex'),
    },
    supplemental: {
      file: 'ledger-recovery-hardware-initiation.json',
      policies: 2,
      payments: 4,
      rawDeviceSha256: createHash('sha256').update(supplementalBytes).digest('hex'),
    },
  }
}
assert.deepEqual(fixtures.map((row) => row.id).sort(), Object.keys(expected).sort(), 'complete ten-policy case set')
assert.deepEqual(devices.map((row) => row.tier).sort(), Object.keys(expected).sort(), 'complete ten-policy device set')
assert.equal(
  fixtures.reduce((count, row) => count + row.payments.length, 0),
  15,
)
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
const results = []
try {
  const { buildLedgerRecoveryPsbt, requireLedgerRecoveryUserApproval, acceptLedgerRecoveryGuardianSignatures } =
    await vite.ssrLoadModule('/src/lib/vault/ledgerRecovery.ts')
  const { ledgerSavingsGuardianParent, ledgerGuardianInitiateChild, ledgerBip32Versions } = await vite.ssrLoadModule(
    '/src/lib/vault/program/ledgerNativeKeys.ts',
  )
  const normalDevices = JSON.parse(readFileSync(evidence('ledger-candidate.json')))
  for (const fixture of fixtures) {
    const device = devices.find((d) => d.tier === fixture.id)
    assert(device?.registered && !device.error)
    assert.deepEqual(fixture.payments.map((payment) => payment.label).sort(), [...expected[fixture.id]].sort())
    assert.deepEqual(device.payments.map((payment) => payment.label).sort(), [...expected[fixture.id]].sort())
    assert.deepEqual(device.addresses, fixture.addresses || { 0: fixture.address })
    if (isInitiation(fixture.id)) {
      assert(device.registrationReused, 'reuse the exact previously registered normal wallet policy')
      assert.equal(device.walletId, normalDevices.find((row) => row.tier === fixture.id.split('-')[0]).walletId)
    }
    for (const payment of fixture.payments) {
      const signed = device.payments.find((p) => p.label === payment.label)
      assert.equal(signed.signatures.length, 1)
      const sig = signed.signatures[0]
      assert.equal(sig.index, 0)
      assert.equal(sig.pubkey, payment.hardware)
      const signature = hex.decode(sig.signature)
      assert.equal(signature.length, 64, 'DEFAULT signatures only')
      const opts = { allowUnknownInputs: true, allowUnknownOutputs: true }
      let tx = Transaction.fromPSBT(base64.decode(payment.psbt), opts)
      assert.equal(tx.inputsLength, 1)
      assert.equal(tx.outputsLength, 1)
      const input = tx.getInput(0),
        leaf = input.tapLeafScript[0][1].slice(0, -1)
      assert.equal(tx.getOutput(0).amount, BigInt(payment.amount))
      assert.equal(input.witnessUtxo.amount - tx.getOutput(0).amount, BigInt(payment.fee))
      const digest = (t) => {
        const prevout = t.getInput(0).witnessUtxo
        return t.preimageWitnessV1(0, [prevout.script], 0, [prevout.amount], undefined, leaf)
      }
      assert(schnorr.verify(signature, digest(tx), hex.decode(payment.hardware)))
      for (const mutation of ['destination', 'amount', 'outpoint', 'sequence', 'prevout-value']) {
        const altered = new Transaction({ version: tx.version, lockTime: tx.lockTime, ...opts })
        const changedTxid = input.txid.slice()
        changedTxid[0] ^= 1
        altered.addInput({
          txid: mutation === 'outpoint' ? changedTxid : input.txid,
          index: input.index,
          sequence: mutation === 'sequence' ? input.sequence - 1 : input.sequence,
          witnessUtxo: {
            script: input.witnessUtxo.script,
            amount: input.witnessUtxo.amount + (mutation === 'prevout-value' ? 1n : 0n),
          },
        })
        altered.addOutput({
          script: mutation === 'destination' ? input.witnessUtxo.script : tx.getOutput(0).script,
          amount: tx.getOutput(0).amount - (mutation === 'amount' ? 1n : 0n),
        })
        assert(
          !schnorr.verify(signature, digest(altered), hex.decode(payment.hardware)),
          `${fixture.id}/${payment.label} must commit ${mutation}`,
        )
      }
      tx.updateInput(0, {
        tapScriptSig: [
          ...(input.tapScriptSig || []),
          [{ pubKey: hex.decode(payment.hardware), leafHash: tapLeafHash(leaf) }, signature],
        ],
      })
      let guardianFixtureSignature
      if (isInitiation(fixture.id)) {
        assert.equal(payment.signingOrder, 'hardware-then-fixture-guardian')
        assert.equal(input.tapScriptSig?.length || 0, 0)
        assert.equal(
          hex.encode(base64.decode(payment.psbt)),
          buildLedgerRecoveryPsbt(payment.transition),
          'use the actual canonical recovery builder',
        )
        assert.equal(payment.transition.action.kind, 'initiate')
        assert.equal(payment.transition.action.claimant, 'hardware')
        assert.equal(payment.transition.action.change, payment.label === 'initiate-receive' ? 0 : 1)
        const userPsbt = hex.encode(tx.toPSBT())
        requireLedgerRecoveryUserApproval(payment.transition, userPsbt)
        const context = payment.transition.contract.context
        const publicParent = ledgerSavingsGuardianParent(context)
        const fixtureSecret = new Uint8Array(32)
        fixtureSecret[31] = 14
        const parent = new HDKey({
          privateKey: fixtureSecret,
          chainCode: publicParent.chainCode,
          versions: ledgerBip32Versions(context.network),
        })
        const child = ledgerGuardianInitiateChild(context, parent, 'hardware', payment.transition.action.change)
        try {
          // Capture this disposable Guardian signature only after the real device
          // signature has passed verification and canonical user approval checks.
          tx.signIdx(child.privateKey, 0, undefined, new Uint8Array(32))
          const record = tx
            .getInput(0)
            .tapScriptSig.find(([key]) => hex.encode(key.pubKey) === hex.encode(child.publicKey.slice(1)))
          assert.equal(record[1].length, 64)
          assert(schnorr.verify(record[1], digest(tx), child.publicKey.slice(1)))
          guardianFixtureSignature = {
            pubkey: hex.encode(record[0].pubKey),
            leafHash: hex.encode(record[0].leafHash),
            signature: hex.encode(record[1]),
          }
          tx = Transaction.fromPSBT(
            hex.decode(acceptLedgerRecoveryGuardianSignatures(payment.transition, userPsbt, hex.encode(tx.toPSBT()))),
            opts,
          )
        } finally {
          child.wipePrivateData()
          parent.wipePrivateData()
          fixtureSecret.fill(0)
        }
      }
      tx.finalize()
      assert(tx.extract().length)
      if (payment.expectedVsize !== undefined) assert.equal(tx.vsize, payment.expectedVsize)
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
        amountSubstitutionRejected: true,
        inputSubstitutionRejected: true,
        sequenceSubstitutionRejected: true,
        prevoutValueSubstitutionRejected: true,
        ...(guardianFixtureSignature
          ? { canonicalRecoveryBuilder: true, hardwareSignedBeforeGuardian: true, guardianFixtureSignature }
          : {}),
      })
    }
  }
  assert.equal(results.length, 15)
  if (mergedRun) {
    writeFileSync(evidence('ledger-recovery.json'), JSON.stringify(devices, null, 2) + '\n')
    writeFileSync(evidence('ledger-recovery-run-provenance.json'), JSON.stringify(mergedRun, null, 2) + '\n')
  }
  writeFileSync(
    evidence('ledger-recovery-verification.json'),
    JSON.stringify(
      {
        scope: 'Speculos Bitcoin Test 2.4.2; synthetic inputs; live services and physical hardware excluded',
        policies: 10,
        cases: 15,
        results,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify(results, null, 2))
} finally {
  await vite.close()
}
