import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'

const java = process.env.CONNECTOR_SPARROW_JAVA
const classpathFile = process.env.CONNECTOR_SPARROW_CLASSPATH_FILE
const sparrowSource = process.env.CONNECTOR_SPARROW_SOURCE
assert.ok(
  java && classpathFile && sparrowSource,
  'Set CONNECTOR_SPARROW_SOURCE, CONNECTOR_SPARROW_JAVA and CONNECTOR_SPARROW_CLASSPATH_FILE',
)
for (const [directory, commit] of [
  [sparrowSource, '8871f4f1af528a4673fee6129373c884e3267860'],
  [`${sparrowSource}/drongo`, '080cf3f7cf74133ba68b369065d0f2e7ea4337da'],
  [`${sparrowSource}/lark`, '13001e8acf7048a15c81cc050c65e6e164c3aa33'],
]) {
  assert.equal(execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit)
  execFileSync('git', ['-C', directory, 'diff', '--exit-code', 'HEAD', '--'])
}
const classpath = (await readFile(classpathFile, 'utf8')).trim()
function sparrow(action, kind, psbt = '', caseName = '') {
  const source = fileURLToPath(
    new URL(action === 'review' ? './SparrowReview.java' : './SparrowQualification.java', import.meta.url),
  )
  const output = execFileSync(
    java,
    [
      '--enable-native-access=ALL-UNNAMED',
      '-Dglass.platform=Headless',
      '-Dprism.order=sw',
      '-cp',
      classpath,
      source,
      action,
      kind,
      caseName,
    ],
    {
      input: psbt,
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  return JSON.parse(
    output
      .split('\n')
      .find((line) => line.startsWith('RESULT '))
      .slice(7),
  )
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' })
after(() => server.close())
const { prepareConnectorPayment } = await server.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { buildConnectorFamily, connectorEnrollmentDigest } = await server.ssrLoadModule(
  '/src/lib/vault/program/connector.ts',
)
const { tweakPrivateKey } = await server.ssrLoadModule('/src/lib/vault/program/tweak.ts')
const { defaultSpendingPolicy } = await server.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const vectors = JSON.parse(
  await readFile(new URL('../../src/lib/vault/program/connector-vectors.json', import.meta.url), 'utf8'),
)
const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true }
const key = (n) => hex.decode(n.toString(16).padStart(64, '0'))

for (const kind of ['p2wpkh', 'p2tr']) {
  const ownKey = sparrow('key', kind)
  const origin = {
    publicKey: hex.decode(ownKey.publicKey),
    fingerprint: parseInt(ownKey.fingerprint, 16),
    path: [0x80000000 + (kind === 'p2tr' ? 86 : 84), 0x80000000, 0x80000000, 0, 0],
  }
  for (const v of vectors.filter((v) => v.network === 'mainnet' && v.originType === 'p2wpkh')) {
    for (const full of [false, true]) {
      test(`Sparrow 2.5.4 BIP39 ${kind} ${v.tier} ${full ? 'full' : 'partial'}`, () => {
        const policy = defaultSpendingPolicy(v.network)
        const contract = {
          vaultId: 'connector-family-fixture',
          network: v.network,
          connectorType: kind,
          phonePub: v.phone,
          hardwarePub: ownKey.publicKey,
          recoveryPub: v.tier === 'advanced' ? v.recovery : undefined,
          phoneDirectP256: v.phoneDirect,
          vaultCosignerBase: v.guardian,
          arkadeCosignerBase: v.emulator,
          absoluteFeeCapSats: policy.absoluteFeeCapSats,
          feerateCapSatPerV: policy.feerateCapSatPerV,
          protectionTier: v.tier,
          spendingPolicy: policy,
        }
        const family = buildConnectorFamily(contract)
        const parent = new Transaction(options)
        parent.addInput({ txid: '01'.repeat(32), index: 0 })
        parent.addOutput({ script: family.savings.script, amount: 10000n })
        parent.addOutput({ script: family.connector.script, amount: 1000n })
        const recipient = Address().encode(OutScript.decode(hex.decode(v.payments[0].recipientScript)))
        const amount = full ? 8760 : 2000
        const prepared = prepareConnectorPayment({
          contract,
          origin,
          enrollmentDigest: connectorEnrollmentDigest(contract, origin),
          savings: { txid: parent.id, vout: 0, parentHex: hex.encode(parent.unsignedTx) },
          reserve: { txid: parent.id, vout: 1, parentHex: hex.encode(parent.unsignedTx) },
          recipient,
          amountSats: amount,
          feeSats: 1000,
        })
        const tx = Transaction.fromPSBT(hex.decode(prepared.psbt()), options)
        const message = tx.preimageWitnessV1(
          0,
          [family.savings.script, family.connector.script],
          0,
          [10000n, 1000n],
          -1,
          family.savings.normal,
        )
        const witness = [
          schnorr.sign(message, tweakPrivateKey(key(15), family.program)),
          schnorr.sign(message, tweakPrivateKey(key(14), family.program)),
          schnorr.sign(message, key(3)),
          family.savings.normal,
          family.savings.control,
        ]
        const request = prepared.forHardware(witness)
        if (process.env.CONNECTOR_SPARROW_UI === '1') {
          const review = sparrow('review', kind, request.psbt(), `${kind}-${v.tier}-${full ? 'full' : 'partial'}`)
          assert.equal(review.recipient, recipient)
          assert.equal(review.amount, amount)
        }
        const response = sparrow('sign', kind, request.psbt())
        assert.equal(response.recipient, recipient)
        assert.equal(response.amount, amount)
        assert.equal(response.fee, 1000)
        assert.equal(request.accept(response.tx).txHex, response.tx)
        assert.equal(request.accept(response.psbt).txHex, response.tx)
        const mutated = hex.decode(response.tx)
        const script = hex.decode(v.payments[0].recipientScript)
        const offset = mutated.findIndex((_, i) => script.every((b, j) => mutated[i + j] === b))
        assert.ok(offset >= 0)
        assert.equal(script.length, family.savings.script.length)
        mutated.set(family.savings.script, offset)
        assert.throws(() => request.accept(hex.encode(mutated)), /changed transaction/)
      })
    }
  }
}
