// Ledger simulator fixtures for all recovery leaves that require the hardware key.
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { Transaction, p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { hex, base64 } from '@scure/base'
import { pbkdf2Sync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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
const mnemonic =
  'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin'
const hardware = HDKey.fromMasterSeed(pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512'), versions)
const path = [0x80000056, 0x80000001, 0x80000000]
const account = (key) => key.derive("m/86'/1'/0'")
const keys = {
  hardware: account(hardware),
  phone: account(HDKey.fromMasterSeed(new Uint8Array(32).fill(0x43), versions)),
  recovery: account(HDKey.fromMasterSeed(new Uint8Array(32).fill(0x44), versions)),
}
const rows = []
try {
  const { buildLedgerNativeFamily } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeFamily.ts')
  const { ledgerRecoveryChild, ledgerRecoveryProgramParent, ledgerSavingsChild, LEDGER_RECOVERY_BRANCH } =
    await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeKeys.ts')
  const { tapLeafForScript } = await vite.ssrLoadModule('/src/lib/vault/program/spend.ts')
  const { tweakPrivateKey } = await vite.ssrLoadModule('/src/lib/vault/program/tweak.ts')
  const { scalarSecret } = await vite.ssrLoadModule('/src/lib/vault/program/fixtures.ts')
  const contexts = JSON.parse(
    readFileSync(new URL('../../src/lib/vault/program/ledger-family-vectors.json', import.meta.url)),
  )
  const opts = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true }
  const recipient = p2tr(keys.recovery.publicKey.slice(1), undefined, TEST_NETWORK)
  for (const vector of contexts.filter((v) => v.input.network === 'mutinynet')) {
    const context = {
      ...vector.input,
      hardware: {
        xpub: keys.hardware.publicExtendedKey,
        fingerprint: hardware.fingerprint.toString(16).padStart(8, '0'),
        path,
      },
    }
    const family = buildLedgerNativeFamily(context, vector.spendingPolicy)
    const tier = context.recovery ? 'advanced' : 'standard'
    for (const r of Object.values(family.recovery)) {
      const cases = [
        { stage: 'pending', tree: r.pending, payments: [] },
        { stage: 'quarantine', tree: r.quarantine, payments: [] },
      ]
      const make = (stage, label, script, role, cosigners, sequence = 0xfffffffd) => {
        const record = cases.find((c) => c.stage === stage),
          tree = record.tree
        const parent = new Transaction(opts)
        parent.addInput({ txid: '00'.repeat(32), index: 99 })
        parent.addOutput({ script: tree.script, amount: 100000n })
        const tx = new Transaction(opts)
        const h = ledgerRecoveryChild(keys.hardware, role)
        tx.addInput({
          txid: parent.id,
          index: 0,
          sequence,
          witnessUtxo: { script: tree.script, amount: 100000n },
          nonWitnessUtxo: parent.toBytes(true, true),
          tapInternalKey: tree.tapInternalKey,
          tapLeafScript: [tapLeafForScript(tree.tapLeafScript, script)],
          tapBip32Derivation: [
            [
              h.publicKey.slice(1),
              {
                hashes: [tapLeafHash(script)],
                der: { fingerprint: hardware.fingerprint, path: [...path, LEDGER_RECOVERY_BRANCH[role], 0] },
              },
            ],
          ],
        })
        tx.addOutput({ script: recipient.script, amount: 99000n })
        for (const secret of cosigners) tx.signIdx(secret, 0)
        record.payments.push({
          label,
          hardware: hex.encode(h.publicKey.slice(1)),
          psbt: base64.encode(tx.toPSBT()),
          recipient: recipient.address,
          amount: 99000,
          fee: 1000,
        })
      }
      if (r.claimant === 'hardware') make('pending', 'claim', r.pending.claim, 'claim', [], r.delay)
      else {
        const hIndex = r.guardians.indexOf('hardware')
        const cosigners = ['vault', 'arkade'].map((role) => {
          const pub = ledgerRecoveryProgramParent(context, r.claimant, role, r.clawbackProgram)
          const parent = new HDKey({
            privateKey: tweakPrivateKey(scalarSecret(role === 'vault' ? 14 : 15), r.clawbackProgram),
            chainCode: pub.chainCode,
            versions,
          })
          return ledgerSavingsChild(parent, hIndex * 2).privateKey
        })
        make('pending', 'clawback', r.pending.clawbacks[hIndex], 'clawback', cosigners)
        const others = r.guardians.filter((g) => g !== 'hardware')
        make(
          'pending',
          'cancel',
          r.pending.cancel,
          'cancel',
          others.map((g) => ledgerRecoveryChild(keys[g], 'cancel').privateKey),
        )
        make(
          'quarantine',
          'release',
          r.quarantine.admin,
          'quarantine',
          others.map((g) => ledgerRecoveryChild(keys[g], 'quarantine').privateKey),
        )
      }
      for (const c of cases.filter((c) => c.payments.length))
        rows.push({
          id: `${tier}-${r.claimant}-${c.stage}`,
          name: c.tree.walletPolicy.name,
          template: c.tree.walletPolicy.descriptorTemplate,
          keys: c.tree.walletPolicy.keysInfo,
          address: c.tree.address,
          payments: c.payments,
        })
    }
  }
  writeFileSync(
    new URL('./evidence/ledger-recovery-inputs.json', import.meta.url),
    JSON.stringify(rows, null, 2) + '\n',
  )
  console.log(rows.map((r) => ({ id: r.id, payments: r.payments.length })))
} finally {
  await vite.close()
}
