// Disposable public fixtures; this candidate is not an enrolled production contract.
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { Transaction, p2tr, TEST_NETWORK } from '@scure/btc-signer'
import { hex, base64 } from '@scure/base'
import { pbkdf2Sync } from 'node:crypto'
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
const publicSeed =
  'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin'
const h = HDKey.fromMasterSeed(pbkdf2Sync(publicSeed, 'mnemonic', 2048, 64, 'sha512'), versions)
const p = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x43), versions)
const r = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x44), versions)
const accountPath = "m/86'/1'/0'",
  path = [0x80000056, 0x80000001, 0x80000000]
const account = (hd) => hd.derive(accountPath)
const origin = (hd) => ({
  xpub: account(hd).publicExtendedKey,
  fingerprint: hd.fingerprint.toString(16).padStart(8, '0'),
  path,
})
const child = (hd, branch) => hd.deriveChild(branch).deriveChild(0)
const xonly = (hd) => hd.publicKey.slice(1)
const rows = []
try {
  const { PROGRAM_FIXTURE_FAMILY } = await vite.ssrLoadModule('/src/lib/vault/program/fixtures.ts')
  const { buildVaultProgramFamily } = await vite.ssrLoadModule('/src/lib/vault/program/trees.ts')
  const { buildLedgerNativeSavings } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativePolicy.ts')
  const { signLedgerSavingsWithPhone } = await vite.ssrLoadModule('/src/lib/vault/ledgerSavings.ts')
  const { LEDGER_NATIVE_TEMPLATE } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeKeys.ts')
  const { defaultSpendingPolicy, spendingPolicyDigest } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
  for (const tier of ['standard', 'advanced']) {
    const family = buildVaultProgramFamily({
      ...PROGRAM_FIXTURE_FAMILY,
      phonePub: hex.encode(child(account(p), 0).publicKey),
      hardwarePub: hex.encode(child(account(h), 0).publicKey),
      recoveryPub: tier === 'advanced' ? hex.encode(child(account(r), 0).publicKey) : undefined,
    })
    // Recovery transition programs remain fixtures until the full lifecycle is qualified.
    const input = {
      templateVersion: LEDGER_NATIVE_TEMPLATE,
      network: 'mutinynet',
      vaultId: PROGRAM_FIXTURE_FAMILY.vaultId,
      policyDigest: spendingPolicyDigest(defaultSpendingPolicy('mutinynet'), 'mutinynet'),
      phone: origin(p),
      hardware: origin(h),
      ...(tier === 'advanced' ? { recovery: origin(r) } : {}),
      phoneDirectP256: PROGRAM_FIXTURE_FAMILY.phoneDirectP256,
      vaultCosignerBase: PROGRAM_FIXTURE_FAMILY.vaultCosignerBase,
      arkadeCosignerBase: PROGRAM_FIXTURE_FAMILY.arkadeCosignerBase,
    }
    const claims = tier === 'advanced' ? ['phone', 'hardware', 'recovery'] : ['phone', 'hardware']
    const programs = Object.fromEntries(
      claims.map((claim) => [claim, hex.encode(family.initiateAuth['savings-' + claim])]),
    )
    const { walletPolicy, receive, change } = buildLedgerNativeSavings(input, programs)
    const { descriptorTemplate: template, keysInfo: keys } = walletPolicy
    const parent = new Transaction({ allowUnknownInputs: true })
    parent.addInput({ txid: '00'.repeat(32), index: 99 })
    parent.addOutput({ script: receive.script, amount: 100000n })
    const recipient = p2tr(xonly(account(r)), undefined, TEST_NETWORK)
    const payments = []
    for (const full of [false, true]) {
      const payment = {
        contract: { context: input, programs },
        coins: [
          {
            txid: parent.id,
            vout: 0,
            value: 100000,
            branch: 0,
            index: 0,
            parentTxHex: hex.encode(parent.toBytes(true, true)),
          },
        ],
        destAddress: recipient.address,
        amountSats: full ? 99000 : 20000,
        feeSats: 1000,
      }
      const psbt = signLedgerSavingsWithPhone(payment, account(p))
      payments.push({
        full,
        recipient: recipient.address,
        amount: full ? 99000 : 20000,
        fee: 1000,
        psbt: base64.encode(hex.decode(psbt)),
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
