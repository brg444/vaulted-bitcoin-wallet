import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
const file = new URL('./evidence/specter.json', import.meta.url)
const rows = JSON.parse(readFileSync(file))
const core = JSON.parse(readFileSync(new URL('./evidence/core.json', import.meta.url))).results
for (const [i, row] of rows.entries()) {
  const tx = Transaction.fromPSBT(base64.decode(row.psbt), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const hardware = tx.getInput(0).tapScriptSig.filter(([k]) => hex.encode(k.pubKey) === core[i].hardware)
  assert.equal(hardware.length, 1)
  assert.equal(hardware[0][1].at(-1), 1)
  assert.equal(hardware[0][1].length, 65)
  tx.combine(
    Transaction.fromPSBT(base64.decode(core[i].phonePsbt), { allowUnknownInputs: true, allowUnknownOutputs: true }),
  )
  tx.finalize()
  const raw = hex.encode(tx.extract())
  function accept(raw) {
    return JSON.parse(
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          'vaulted-native-core-qualification',
          'bitcoin-cli',
          '-regtest',
          '-rpcuser=native-fixture',
          '-rpcpassword=disposable-local-test',
          '-stdin',
          'testmempoolaccept',
        ],
        { input: JSON.stringify([raw]) + '\n', encoding: 'utf8' },
      ),
    )[0]
  }
  const good = accept(raw)
  assert.equal(good.allowed, true, JSON.stringify(good))
  const script = hex.encode(tx.getOutput(0).script)
  assert.equal(raw.split(script).length, 2)
  const bad = accept(raw.replace(script, script.slice(0, -2) + (script.endsWith('00') ? '01' : '00')))
  assert.equal(bad.allowed, false)
  row.bitcoinValidation = { accepted: good, changedDestination: bad, hardwareSighash: 'ALL' }
  console.log(
    row.tier,
    row.full ? 'full' : 'partial',
    good.vsize,
    'vB; Core accepted Specter signature and rejected changed destination',
  )
}
writeFileSync(file, JSON.stringify(rows, null, 2) + '\n')
