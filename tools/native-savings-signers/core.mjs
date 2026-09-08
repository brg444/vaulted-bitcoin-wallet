// Public deterministic fixture keys only. An isolated, disposable regtest node is mandatory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { Transaction, p2tr, WIF } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { hex, base64 } from '@scure/base'
const root = fileURLToPath(new URL('../../', import.meta.url))
const container = 'vaulted-native-core-qualification'
function rpc(method, args = [], wallet = '') {
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'bitcoin-cli',
      '-regtest',
      '-rpcuser=native-fixture',
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
  ).trim()
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}
assert.equal(
  execFileSync('docker', ['inspect', container, '--format', '{{.HostConfig.NetworkMode}}'], {
    encoding: 'utf8',
  }).trim(),
  'none',
)
const node = rpc('getnetworkinfo')
assert.equal(node.networkactive, false)
assert.equal(node.connections, 0)
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
const results = []
try {
  const { buildVaultProgramFamily } = await vite.ssrLoadModule('/src/lib/vault/program/trees.ts')
  const { PROGRAM_FIXTURE_FAMILY, scalarSecret, compressedFromScalar } = await vite.ssrLoadModule(
    '/src/lib/vault/program/fixtures.ts',
  )
  const miner = 'native-miner-' + Date.now()
  rpc('createwallet', [miner])
  const mining = rpc('getnewaddress', [], miner)
  rpc('generatetoaddress', [101, mining])
  // Preserve every leaf and the exact pairing used by tapTreeFromScripts().
  const leaf = (s) => {
    const bytes = hex.encode(s)
    assert.match(bytes, /^(20[0-9a-f]{64}ad)+20[0-9a-f]{64}ac$/)
    const keys = [...bytes.matchAll(/20([0-9a-f]{64})(?:ad|ac)/g)].map((x) => x[1])
    return keys.reduceRight((rest, k) => (rest ? `and_v(v:pk(${k}),${rest})` : `pk(${k})`), '')
  }
  const hd = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x42), { private: 0x04358394, public: 0x043587cf })
  const hdPath = "m/86'/1'/0'/0/0",
    hdKey = hd.derive(hdPath),
    hardware = hex.encode(hdKey.publicKey).slice(2)
  for (const tier of ['standard', 'advanced']) {
    const family = buildVaultProgramFamily({
      ...PROGRAM_FIXTURE_FAMILY,
      hardwarePub: hex.encode(hdKey.publicKey),
      recoveryPub: tier === 'advanced' ? PROGRAM_FIXTURE_FAMILY.recoveryPub : undefined,
    })
    const s = family.savings,
      leaves = [s.admin, ...s.initiate].map(leaf)
    const tree =
      tier === 'standard'
        ? `{{${leaves[0]},${leaves[1]}},${leaves[2]}}`
        : `{{${leaves[0]},${leaves[1]}},{${leaves[2]},${leaves[3]}}}`
    const descriptor = `tr(${hex.encode(s.tapInternalKey)},${tree})`
    const checked = rpc('getdescriptorinfo', [descriptor]).descriptor
    const address = rpc('deriveaddresses', [checked])[0]
    const decoded = rpc('validateaddress', [address])
    assert.equal(decoded.scriptPubKey, hex.encode(s.script))
    const privateDescriptor = descriptor.replaceAll(hardware, WIF({ wif: 0xef }).encode(hdKey.privateKey))
    const checksum = rpc('getdescriptorinfo', [privateDescriptor]).checksum
    const wallet = 'native-' + tier + '-' + Date.now()
    rpc('createwallet', [wallet, false, true])
    const imported = rpc(
      'importdescriptors',
      [[{ desc: privateDescriptor + '#' + checksum, timestamp: 'now' }]],
      wallet,
    )
    assert(
      imported.every((x) => x.success),
      JSON.stringify(imported),
    )
    for (const full of [false, true]) {
      const funding = rpc('sendtoaddress', [address, 0.001], miner)
      rpc('generatetoaddress', [1, mining])
      const parent = rpc('getrawtransaction', [funding, true])
      const index = parent.vout.find((x) => x.scriptPubKey.hex === hex.encode(s.script)).n
      const tx = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
      const chosen = s.tapLeafScript.find(([, v]) => hex.encode(v.slice(0, -1)) === hex.encode(s.admin))
      assert(chosen)
      tx.addInput({
        txid: funding,
        index,
        witnessUtxo: { script: s.script, amount: 100000n },
        tapInternalKey: s.tapInternalKey,
        tapLeafScript: [chosen],
        sequence: 0xffffffff,
      })
      tx.addOutput({
        script: p2tr(hex.decode(compressedFromScalar(6).slice(2))).script,
        amount: full ? 99000n : 20000n,
      })
      if (!full) tx.addOutput({ script: s.script, amount: 79000n })
      tx.sign(scalarSecret(3))
      const signed = rpc('walletprocesspsbt', [base64.encode(tx.toPSBT()), true, 'DEFAULT', true, false], wallet)
      const partial = Transaction.fromPSBT(base64.decode(signed.psbt), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      })
      assert(partial.getInput(0).tapScriptSig.length >= 2)
      partial.finalize()
      const raw = hex.encode(partial.extract())
      const accepted = rpc('testmempoolaccept', [[raw]])[0]
      assert.equal(accepted.allowed, true, JSON.stringify(accepted))
      // Keep the signed witness but replace the destination: Bitcoin must reject it.
      const oldScript = hex.encode(p2tr(hex.decode(compressedFromScalar(6).slice(2))).script)
      assert.equal(raw.split(oldScript).length, 2)
      const badRaw = raw.replace(oldScript, hex.encode(p2tr(hex.decode(compressedFromScalar(7).slice(2))).script))
      const rejected = rpc('testmempoolaccept', [[badRaw]])[0]
      assert.equal(rejected.allowed, false)

      const row = {
        tier,
        full,
        hardware,
        hardwareXpub: hdKey.publicExtendedKey,
        hardwareOrigin: hd.fingerprint.toString(16).padStart(8, '0') + hdPath.slice(1),
        phonePsbt: base64.encode(tx.toPSBT()),
        descriptor,
        address,
        script: hex.encode(s.script),
        imported,
        complete: signed.complete,
        vsize: accepted.vsize,
        feeSats: 1000,
        accepted,
        rejected,
        psbt: signed.psbt,
        raw,
      }
      results.push(row)
      console.log(
        tier,
        full ? 'full' : 'partial',
        accepted.vsize,
        'vB; destination mutation rejected:',
        rejected['reject-reason'],
      )
    }
  }
  writeFileSync(
    new URL('./evidence/core.json', import.meta.url),
    JSON.stringify({ node: node.subversion, network: 'isolated regtest', results }, null, 2) + '\n',
  )
} finally {
  await vite.close()
}
