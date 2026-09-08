// Disposable public fixtures; this candidate is not an enrolled production contract.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { Transaction, p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { hex, base64 } from '@scure/base'
import { pbkdf2Sync, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
const versions = { private: 0x04358394, public: 0x043587cf }
const hash = (text) => new Uint8Array(createHash('sha256').update(text).digest())
const publicSeed =
  'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin'
const h = HDKey.fromMasterSeed(pbkdf2Sync(publicSeed, 'mnemonic', 2048, 64, 'sha512'), versions)
const p = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x43), versions)
const r = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x44), versions)
const accountPath = "m/86'/1'/0'",
  path = [0x80000056, 0x80000001, 0x80000000]
const account = (hd) => hd.derive(accountPath)
const origin = (hd) => `[${hd.fingerprint.toString(16).padStart(8, '0')}/86'/1'/0']${account(hd).publicExtendedKey}`
const child = (hd, branch) => hd.deriveChild(branch).deriveChild(0)
const xonly = (hd) => hd.publicKey.slice(1)
const rows = []
try {
  const { PROGRAM_FIXTURE_FAMILY, scalarSecret } = await vite.ssrLoadModule('/src/lib/vault/program/fixtures.ts')
  const { buildVaultProgramFamily, tapTreeFromScripts } = await vite.ssrLoadModule('/src/lib/vault/program/trees.ts')
  const { checksigScript, TAPROOT_NUMS_XONLY } = await vite.ssrLoadModule('/src/lib/vault/savingsTree.ts')
  const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
  for (const tier of ['standard', 'advanced']) {
    const family = buildVaultProgramFamily({
      ...PROGRAM_FIXTURE_FAMILY,
      phonePub: hex.encode(child(account(p), 0).publicKey),
      hardwarePub: hex.encode(child(account(h), 0).publicKey),
      recoveryPub: tier === 'advanced' ? hex.encode(child(account(r), 0).publicKey) : undefined,
    })
    // Keep named v1 transition programs as mathematical fixtures only. The complete v2
    // recovery lifecycle and deployment contract still need independent qualification.
    const nums = new HDKey({
      publicKey: hex.decode('02' + TAPROOT_NUMS_XONLY),
      chainCode: hash('vaulted-ledger-candidate/nums/' + tier),
      versions,
    })
    const parents = [nums, account(p), account(h)],
      keys = [nums.publicExtendedKey, origin(p), origin(h)]
    const claims = tier === 'advanced' ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']
    const pairs = []
    for (const claim of claims) {
      const program = family.initiateAuth['savings-' + claim]
      const pair = []
      for (const scalar of [14, 15]) {
        const chainCode = hash('vaulted-ledger-candidate/program-parent/' + hex.encode(program))
        const parent = new HDKey({ privateKey: tweakPrivateKey(scalarSecret(scalar), program), chainCode, versions })
        // Public derivation agrees with private derivation, including after the program tweak.
        const pub = HDKey.fromExtendedKey(parent.publicExtendedKey, versions)
        for (const branch of [0, 1]) assert.deepEqual(child(pub, branch).publicKey, child(parent, branch).publicKey)
        pair.push(parents.length)
        parents.push(parent)
        keys.push(parent.publicExtendedKey)
      }
      pairs.push(pair)
    }
    let recoveryIndex
    if (tier === 'advanced') {
      recoveryIndex = parents.length
      parents.push(account(r))
      keys.push(origin(r))
    }
    const keyExpr = (i, b = 0) => (b === 0 ? `@${i}/**` : `@${i}/<${b};${b + 1}>/*`)
    const and = (ks) => ks.reduceRight((rest, k) => (rest ? `and_v(v:pk(${k}),${rest})` : `pk(${k})`), '')
    const expressions = [
      and([keyExpr(1), keyExpr(2)]),
      ...claims.map((claim, i) =>
        and([
          keyExpr(claim === 'phone' ? 1 : claim === 'hardware' ? 2 : recoveryIndex, claim === 'recovery' ? 0 : 2),
          ...pairs[i].map((k) => keyExpr(k)),
        ]),
      ),
    ]
    const tree = (leaves) =>
      tier === 'standard'
        ? `{{${leaves[0]},${leaves[1]}},${leaves[2]}}`
        : `{{${leaves[0]},${leaves[1]}},{${leaves[2]},${leaves[3]}}}`
    const template = `tr(@0/**,${tree(expressions)})`
    assert(template.length <= 512)
    assert(keys.length <= 15)
    function payment(change) {
      const admin = checksigScript([xonly(child(parents[1], change)), xonly(child(parents[2], change))])
      const initiate = claims.map((claim, i) =>
        checksigScript([
          xonly(
            child(
              parents[claim === 'phone' ? 1 : claim === 'hardware' ? 2 : recoveryIndex],
              claim === 'recovery' ? change : 2 + change,
            ),
          ),
          ...pairs[i].map((k) => xonly(child(parents[k], change))),
        ]),
      )
      const scripts = [admin, ...initiate]
      return { ...p2tr(xonly(child(nums, change)), tapTreeFromScripts(scripts), TEST_NETWORK, true), scripts, admin }
    }
    const receive = payment(0),
      change = payment(1)
    const parent = new Transaction({ allowUnknownInputs: true })
    parent.addInput({ txid: '00'.repeat(32), index: 99 })
    parent.addOutput({ script: receive.script, amount: 100000n })
    const recipient = p2tr(xonly(account(r)), undefined, TEST_NETWORK)
    const payments = []
    for (const full of [false, true]) {
      const tx = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true })
      const leaf = receive.tapLeafScript.find(([, v]) => hex.encode(v.slice(0, -1)) === hex.encode(receive.admin))
      tx.addInput({
        txid: parent.id,
        index: 0,
        nonWitnessUtxo: parent.toBytes(true, true),
        witnessUtxo: { script: receive.script, amount: 100000n },
        tapLeafScript: [leaf],
        tapInternalKey: receive.tapInternalKey,
        tapBip32Derivation: [
          [
            xonly(child(account(h), 0)),
            { hashes: [tapLeafHash(receive.admin)], der: { fingerprint: h.fingerprint, path: [...path, 0, 0] } },
          ],
        ],
        sequence: 0xffffffff,
      })
      tx.addOutput({ script: recipient.script, amount: full ? 99000n : 20000n })
      if (!full)
        tx.addOutput({
          script: change.script,
          amount: 79000n,
          tapInternalKey: change.tapInternalKey,
          tapTree: change.scripts.map((script, i) => ({
            depth: tier === 'standard' && i === 2 ? 1 : 2,
            version: 0xc0,
            script,
          })),
          tapBip32Derivation: [
            [
              xonly(child(account(h), 1)),
              { hashes: [tapLeafHash(change.admin)], der: { fingerprint: h.fingerprint, path: [...path, 1, 0] } },
            ],
          ],
        })
      tx.sign(child(account(p), 0).privateKey)
      payments.push({
        full,
        recipient: recipient.address,
        amount: full ? 99000 : 20000,
        fee: 1000,
        psbt: base64.encode(tx.toPSBT()),
        parent: hex.encode(parent.toBytes(true, true)),
      })
    }
    rows.push({
      tier,
      template,
      keys,
      receive: receive.address,
      change: change.address,
      hardware: hex.encode(xonly(child(account(h), 0))),
      payments,
      recoveryScope: 'v1 transition program fixtures; post-tweak BIP32 math only; runtime integration unimplemented',
    })
  }
  writeFileSync(
    new URL('./evidence/ledger-candidate-inputs.json', import.meta.url),
    JSON.stringify(rows, null, 2) + '\n',
  )
  console.log(rows.map((r) => ({ tier: r.tier, template: r.template, keys: r.keys.length, receive: r.receive })))
} finally {
  await vite.close()
}
