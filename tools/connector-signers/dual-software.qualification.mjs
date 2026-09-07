import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js'
import { HDKey } from '@scure/bip32'
import { hex, base64 } from '@scure/base'
import { pbkdf2Sync } from 'node:crypto'

const signer = process.env.CONNECTOR_SOFTWARE_SIGNER
assert(['sparrow', 'core'].includes(signer), 'Set CONNECTOR_SOFTWARE_SIGNER to sparrow or core')
const emulator = new URL(process.env.CONNECTOR_EMULATOR_ORIGIN || 'http://invalid')
assert.equal(emulator.protocol, 'http:')
assert(['localhost', '127.0.0.1'].includes(emulator.hostname), 'Disposable local Emulator required')
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
after(() => vite.close())
const { prepareConnectorPayment } = await vite.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { buildConnectorFamily, connectorEnrollmentDigest, DUAL_CONNECTOR_TEMPLATE } = await vite.ssrLoadModule(
  '/src/lib/vault/program/connector.ts',
)
const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const [v] = JSON.parse(await readFile(new URL('../../src/lib/vault/program/connector-vectors.json', import.meta.url)))
const info = await (await fetch(new URL('/v1/info', emulator))).json()
assert.equal(info.version, 'v0.0.7')
assert.equal(info.signerPubkey, v.emulator)
// Sparrow's published fixture, never a user seed.
const hd = HDKey.fromMasterSeed(
  pbkdf2Sync(
    'absent essay fox snake vast pumpkin height crouch silent bulb excuse razor',
    'mnemonicpp',
    2048,
    64,
    'sha512',
  ),
  signer === 'core' ? { private: 0x04358394, public: 0x043587cf } : undefined,
)
const secret = (n) => hex.decode(n.toString(16).padStart(64, '0'))
const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }
let classpath
if (signer === 'sparrow') {
  const source = process.env.CONNECTOR_SPARROW_SOURCE
  assert(source && process.env.CONNECTOR_SPARROW_JAVA && process.env.CONNECTOR_SPARROW_CLASSPATH_FILE)
  for (const [dir, commit] of [
    [source, '8871f4f1af528a4673fee6129373c884e3267860'],
    [source + '/drongo', '080cf3f7cf74133ba68b369065d0f2e7ea4337da'],
  ]) {
    assert.equal(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit)
    execFileSync('git', ['-C', dir, 'diff', '--exit-code', 'HEAD', '--'])
  }
  classpath = (await readFile(process.env.CONNECTOR_SPARROW_CLASSPATH_FILE, 'utf8')).trim()
}
const container = 'vaulted-connector-core-qualification'
function core(method, args = [], wallet = '') {
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'bitcoin-cli',
      '-regtest',
      '-rpcuser=connector-fixture',
      '-rpcpassword=disposable-local-test',
      ...(wallet ? ['-rpcwallet=' + wallet] : []),
      '-stdin',
      method,
    ],
    {
      input: args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + (args.length ? '\n' : ''),
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  try {
    return JSON.parse(out)
  } catch {
    return out.trim()
  }
}
if (signer === 'core') {
  assert.equal(
    execFileSync('docker', ['inspect', container, '--format', '{{.HostConfig.NetworkMode}}'], {
      encoding: 'utf8',
    }).trim(),
    'none',
  )
  const info = core('getnetworkinfo')
  assert.equal(info.networkactive, false)
  assert.equal(info.connections, 0)
  console.log('Bitcoin Core:', info.subversion, 'isolated regtest signing; no peers')
}
for (const kind of ['p2wpkh', 'p2tr']) {
  const path = [0x80000000 + (kind === 'p2tr' ? 86 : 84), 0x80000000, 0x80000000, 0, 0]
  const account = hd.derive(`m/${kind === 'p2tr' ? 86 : 84}'/0'/0'`)
  const key = account.deriveChild(0).deriveChild(0)
  const origin = { publicKey: key.publicKey, fingerprint: hd.fingerprint, path }
  const wallet = 'dual-' + kind + '-' + Date.now()
  if (signer === 'core') {
    core('createwallet', [wallet, false, true])
    const desc = `${kind === 'p2tr' ? 'tr' : 'wpkh'}([${hd.fingerprint.toString(16).padStart(8, '0')}/${kind === 'p2tr' ? 86 : 84}h/0h/0h]${account.privateExtendedKey}/0/*)`
    const checksum = core('getdescriptorinfo', [desc]).checksum
    const result = core(
      'importdescriptors',
      [[{ desc: desc + '#' + checksum, timestamp: 'now', range: [0, 1] }]],
      wallet,
    )
    assert(
      result.every((x) => x.success),
      JSON.stringify(result),
    )
  }
  for (const tier of ['standard', 'advanced'])
    for (const full of [false, true]) {
      test(`${signer} v2 ${kind} ${tier} ${full ? 'full' : 'partial'} approval and Emulator`, async () => {
        const policy = defaultSpendingPolicy('mainnet')
        const contract = {
          vaultId: 'dual-software-fixture',
          network: 'mainnet',
          templateVersion: DUAL_CONNECTOR_TEMPLATE,
          connectorType: kind,
          phonePub: v.phone,
          hardwarePub: hex.encode(key.publicKey),
          recoveryPub: tier === 'advanced' ? v.recovery : undefined,
          phoneDirectP256: v.phoneDirect,
          vaultCosignerBase: v.guardian,
          arkadeCosignerBase: v.emulator,
          protectionTier: tier,
          spendingPolicy: policy,
          absoluteFeeCapSats: policy.absoluteFeeCapSats,
          feerateCapSatPerV: policy.feerateCapSatPerV,
        }
        const family = buildConnectorFamily(contract)
        const parent = new Transaction(options)
        parent.addInput({ txid: '00'.repeat(32), index: 99 })
        parent.addOutput({ script: family.savings.script, amount: 100000n })
        for (let i = 0; i < 2; i++) parent.addOutput({ script: family.connector.script, amount: 500n })
        const coin = (vout) => ({ parentHex: hex.encode(parent.toBytes(true, true)), txid: parent.id, vout })
        const request = {
          contract,
          origin,
          enrollmentDigest: connectorEnrollmentDigest(contract, origin),
          savings: coin(0),
          reserve: coin(1),
          secondReserve: coin(2),
          recipient: Address().encode(OutScript.decode(hex.decode(v.payments[0].recipientScript))),
          amountSats: full ? 98760 : 8000,
          feeSats: 1000,
        }
        const initial = prepareConnectorPayment(request)
        const approval = base64.encode(hex.decode(initial.hardwareApproval()))
        let response
        if (signer === 'sparrow') {
          const out = execFileSync(
            process.env.CONNECTOR_SPARROW_JAVA,
            [
              '--enable-native-access=ALL-UNNAMED',
              '-cp',
              classpath,
              fileURLToPath(new URL('./SparrowDualQualification.java', import.meta.url)),
              kind,
            ],
            { input: approval, encoding: 'utf8', timeout: 30000 },
          )
          response = out
            .split('\n')
            .find((l) => l.startsWith('RESULT '))
            .slice(7)
        } else {
          const result = core('walletprocesspsbt', [approval, true, 'SINGLE', true, true], wallet)
          assert.equal(result.complete, false, 'Savings must remain unsigned')
          response = result.psbt
          console.log(
            'Core returned sighash metadata:',
            RawPSBTV0.decode(base64.decode(response)).inputs.map((i) => i.sighashType),
          )
        }
        const signatures = initial.acceptHardwareApproval(response)
        assert.equal(signatures.length, 2)
        for (const signature of signatures) assert.equal(signature.slice(-2), '03')
        const approved = prepareConnectorPayment({ ...request, hardwareSignatures: signatures })
        const tx = Transaction.fromPSBT(hex.decode(approved.signPhone(secret(3))), options)
        tx.signIdx(tweakPrivateKey(secret(14), family.program), 2, [0])
        const res = await fetch(new URL('/v1/onchain-tx', emulator), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tx: base64.encode(tx.toPSBT()) }),
          signal: AbortSignal.timeout(15000),
        })
        assert.equal(res.status, 200, await res.clone().text())
        const signed = Transaction.fromPSBT(base64.decode((await res.json()).signedTx), options)
        const witness = [family.normalTweaks.arkade, family.normalTweaks.vault, contract.phonePub].map(
          (pub) => signed.getInput(2).tapScriptSig.find(([k]) => hex.encode(k.pubKey) === pub.slice(2))[1],
        )
        witness.push(family.savings.normal, family.savings.control)
        assert.equal(approved.forHardware(witness).accept(approved.psbt()).txid, signed.id)
        const changed = Transaction.fromPSBT(base64.decode(response), options)
        // Even a one-satoshi alteration to the reviewed recipient is rejected.
        const altered = RawPSBTV0.decode(base64.decode(response))
        altered.global.unsignedTx.outputs[0].amount--
        assert.throws(
          () => initial.acceptHardwareApproval(hex.encode(RawPSBTV0.encode(altered))),
          /changed transaction/,
        )
        assert.equal(
          hex.encode(changed.unsignedTx),
          hex.encode(Transaction.fromPSBT(hex.decode(initial.hardwareApproval()), options).unsignedTx),
        )
      })
    }
}
