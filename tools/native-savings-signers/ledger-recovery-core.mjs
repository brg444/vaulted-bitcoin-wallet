// Disposable public fixture keys. This never connects to mainnet or a user wallet.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { Transaction } from '@scure/btc-signer'
import { hex } from '@scure/base'
const container = 'vaulted-native-core-qualification'
const inspect = (format) =>
  execFileSync('docker', ['inspect', container, '--format', format], { encoding: 'utf8' }).trim()
assert.equal(inspect('{{.HostConfig.NetworkMode}}'), 'none')
assert.equal(inspect('{{json .HostConfig.PortBindings}}'), '{}')
const rpc = (method, args = [], wallet) => {
  const output = execFileSync(
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
    return JSON.parse(output)
  } catch {
    return output
  }
}
const node = rpc('getnetworkinfo')
assert.equal(node.networkactive, false)
assert.equal(node.connections, 0)
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
  const { buildLedgerNativeFamily } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeFamily.ts')
  const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
  const { ledgerBip32Versions, ledgerRecoveryChild, ledgerRecoveryProgramParent, ledgerSavingsChild } =
    await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeKeys.ts')
  const { tapLeafForScript } = await vite.ssrLoadModule('/src/lib/vault/program/spend.ts')
  const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
  const { scalarSecret } = await vite.ssrLoadModule('/src/lib/vault/program/fixtures.ts')
  const vectors = JSON.parse(
    readFileSync(new URL('../../src/lib/vault/program/ledger-key-vectors.json', import.meta.url)),
  )
  const miner = 'ledger-recovery-' + Date.now()
  rpc('createwallet', [miner])
  const mining = rpc('getnewaddress', [], miner)
  rpc('generatetoaddress', [101, mining])
  const destination = hex.decode(rpc('validateaddress', [mining]).scriptPubKey)
  const opts = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true }
  const fund = (address, script) => {
    const id = rpc('sendtoaddress', [address, 0.001], miner)
    const raw = rpc('getrawtransaction', [id])
    const tx = Transaction.fromRaw(hex.decode(raw), opts)
    const index = Array.from({ length: tx.outputsLength }, (_, i) => i).find(
      (i) => hex.encode(tx.getOutput(i).script) === hex.encode(script),
    )
    assert.notEqual(index, undefined)
    rpc('generatetoaddress', [1, mining])
    return { id, raw, index }
  }
  const policyAddress = (policy, script, change = 0) => {
    const expression = policy.descriptorTemplate.replace(
      /@(\d+)(\/\*\*|\/<(\d+);(\d+)>\/\*)/g,
      (_, i, suffix, left, right) =>
        `${policy.keysInfo[Number(i)]}/${suffix === '/**' ? change : change ? right : left}/0`,
    )
    const descriptor = rpc('getdescriptorinfo', [expression]).descriptor
    const address = rpc('deriveaddresses', [descriptor])[0]
    assert.equal(
      rpc('validateaddress', [address]).scriptPubKey,
      hex.encode(script),
      'Core descriptor and wallet script must match',
    )
    return address
  }
  for (const vector of vectors.filter((v) => v.input.network === 'mutinynet')) {
    const context = vector.input
    const tier = context.recovery ? 'advanced' : 'standard'
    const family = buildLedgerNativeFamily(context, defaultSpendingPolicy(context.network))
    const account = (role) =>
      HDKey.fromMasterSeed(
        new Uint8Array(32).fill({ phone: 0x43, hardware: 0x42, recovery: 0x44 }[role]),
        ledgerBip32Versions(context.network),
      ).derive("m/86'/1'/0'")
    const programSecret = (claimant, cosigner, program, branch) => {
      const publicParent = ledgerRecoveryProgramParent(context, claimant, cosigner, program)
      const parent = new HDKey({
        privateKey: tweakPrivateKey(scalarSecret(cosigner === 'vault' ? 14 : 15), program),
        chainCode: publicParent.chainCode,
        versions: ledgerBip32Versions(context.network),
      })
      assert.equal(parent.publicExtendedKey, publicParent.publicExtendedKey)
      return ledgerSavingsChild(parent, branch).privateKey
    }
    const checkSpend = (name, tree, script, secrets, sequence = 0xfffffffd, change = 0) => {
      const address = policyAddress(tree.walletPolicy || family.walletPolicy, tree.script, change)
      const coin = fund(address, tree.script)
      const tx = new Transaction(opts)
      tx.addInput({
        txid: coin.id,
        index: coin.index,
        sequence,
        witnessUtxo: { script: tree.script, amount: 100000n },
        nonWitnessUtxo: hex.decode(coin.raw),
        tapInternalKey: tree.tapInternalKey,
        tapLeafScript: [tapLeafForScript(tree.tapLeafScript, script)],
      })
      tx.addOutput({ script: destination, amount: 99000n })
      for (const secret of secrets) tx.signIdx(secret, 0)
      tx.finalize()
      const raw = hex.encode(tx.extract())
      if (sequence < 0xffff) {
        const early = rpc('testmempoolaccept', [[raw]])[0]
        assert.equal(early.allowed, false)
        assert.match(early['reject-reason'], /non-BIP68-final/)
        rpc('generatetoaddress', [sequence - 1, mining])
      }
      const accepted = rpc('testmempoolaccept', [[raw]])[0]
      assert.equal(accepted.allowed, true, JSON.stringify({ name, accepted }))
      // Output substitution after signing must fail Bitcoin validation.
      const altered = new Transaction(opts)
      altered.addInput({ txid: coin.id, index: coin.index, sequence })
      altered.addOutput({ script: tree.script, amount: 99000n })
      altered.updateInput(0, { finalScriptWitness: tx.getInput(0).finalScriptWitness })
      const rejected = rpc('testmempoolaccept', [[hex.encode(altered.toBytes(true, true))]])[0]
      assert.equal(rejected.allowed, false)
      assert.match(rejected['reject-reason'], /signature|script/i)
      rpc('sendrawtransaction', [raw])
      rpc('generatetoaddress', [1, mining])
      results.push({
        tier,
        path: name,
        vsize: tx.vsize,
        valid: true,
        outputSubstitutionRejected: true,
        ...(sequence < 0xffff ? { csvBlocks: sequence, prematureClaimRejected: true } : {}),
      })
    }
    for (const change of [0, 1]) {
      const tree = change ? family.change : family.receive
      checkSpend(
        `normal-${change}`,
        tree,
        tree.admin,
        ['phone', 'hardware'].map((r) => ledgerSavingsChild(account(r), change).privateKey),
        undefined,
        change,
      )
      for (const [index, recovery] of Object.values(family.recovery).entries()) {
        const branch = recovery.claimant === 'recovery' ? change : change + 2
        // This checks Bitcoin signing authority; named-program execution is a
        // separate runtime test. The disposable cosigner secrets bypass it here.
        checkSpend(
          `initiate-${recovery.claimant}-${change}`,
          tree,
          tree.initiate[index],
          [
            ledgerSavingsChild(account(recovery.claimant), branch).privateKey,
            ...['vault', 'arkade'].map((r) => programSecret(recovery.claimant, r, recovery.initiateProgram, change)),
          ],
          undefined,
          change,
        )
      }
    }
    for (const recovery of Object.values(family.recovery)) {
      checkSpend(
        `claim-${recovery.claimant}`,
        recovery.pending,
        recovery.pending.claim,
        [ledgerRecoveryChild(account(recovery.claimant), 'claim').privateKey],
        recovery.delay,
      )
      checkSpend(
        `cancel-${recovery.claimant}`,
        recovery.pending,
        recovery.pending.cancel,
        recovery.guardians.map((r) => ledgerRecoveryChild(account(r), 'cancel').privateKey),
      )
      checkSpend(
        `quarantine-${recovery.claimant}`,
        recovery.quarantine,
        recovery.quarantine.admin,
        recovery.guardians.map((r) => ledgerRecoveryChild(account(r), 'quarantine').privateKey),
      )
      recovery.guardians.forEach((guardian, i) =>
        checkSpend(`clawback-${recovery.claimant}-${guardian}`, recovery.pending, recovery.pending.clawbacks[i], [
          ledgerRecoveryChild(account(guardian), 'clawback').privateKey,
          ...['vault', 'arkade'].map((r) => programSecret(recovery.claimant, r, recovery.clawbackProgram, i * 2)),
        ]),
      )
    }
  }
  writeFileSync(
    new URL('./evidence/ledger-recovery-core.json', import.meta.url),
    JSON.stringify(
      {
        node: node.subversion,
        network: 'isolated regtest',
        scope:
          'Bitcoin script authority and policy compilation; services deliberately bypassed with public fixture keys',
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
