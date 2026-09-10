// Public disposable fixtures for wallet/runtime recovery authorization agreement.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { p256 } from '@noble/curves/nist.js'
import { Transaction } from '@scure/btc-signer'
import { format, resolveConfig } from 'prettier'
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
try {
  const recovery = await vite.ssrLoadModule('/src/lib/vault/ledgerRecovery.ts')
  const keys = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeKeys.ts')
  const { buildLedgerNativeFamily } = await vite.ssrLoadModule('/src/lib/vault/program/ledgerNativeFamily.ts')
  const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
  const { signDirectP256 } = await vite.ssrLoadModule('/src/lib/vault/ceremony/directauth.ts')
  const contexts = JSON.parse(
    readFileSync(new URL('../../src/lib/vault/program/ledger-key-vectors.json', import.meta.url)),
  )
  const directSecret = new Uint8Array(32)
  directSecret[31] = 19
  const opts = { version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true }
  const records = []
  for (const { input } of contexts) {
    const context = { ...input, phoneDirectP256: hex.encode(p256.getPublicKey(directSecret, true)) }
    const contract = { context, spendingPolicy: defaultSpendingPolicy(context.network) }
    const family = buildLedgerNativeFamily(context, contract.spendingPolicy)
    const phone = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x43), keys.ledgerBip32Versions(context.network)).derive(
      `m/86'/${context.network === 'mainnet' ? 0 : 1}'/0'`,
    )
    const actions = [
      { kind: 'initiate', claimant: 'phone', change: 0 },
      { kind: 'initiate', claimant: 'phone', change: 1 },
      { kind: 'clawback', claimant: 'hardware', remainingUser: 'phone', change: 0 },
      ...(context.recovery ? [{ kind: 'clawback', claimant: 'recovery', remainingUser: 'phone', change: 0 }] : []),
    ]
    for (const action of actions) {
      const source =
        action.kind === 'initiate'
          ? action.change === 0
            ? family.receive
            : family.change
          : family.recovery[action.claimant].pending
      const parent = new Transaction(opts)
      parent.addInput({ txid: '00'.repeat(32), index: 99 })
      parent.addOutput({ script: source.script, amount: 100000n })
      const transition = {
        contract,
        action,
        coin: { txid: parent.id, vout: 0, value: 100000, parentTxHex: hex.encode(parent.toBytes(true, true)) },
        feeSats: 1000,
      }
      const unsignedPsbt = recovery.buildLedgerRecoveryPsbt(transition)
      const userTx = Transaction.fromPSBT(hex.decode(unsignedPsbt), opts)
      const userKey =
        action.kind === 'initiate'
          ? keys.ledgerSavingsChild(phone, 2 + action.change)
          : keys.ledgerRecoveryChild(phone, 'clawback')
      try {
        // Fixed auxiliary randomness is only for these public disposable vectors.
        userTx.signIdx(userKey.privateKey, 0, undefined, new Uint8Array(32))
      } finally {
        userKey.wipePrivateData()
      }
      const userPsbt = hex.encode(userTx.toPSBT())
      const phoneDigest = hex.encode(recovery.ledgerRecoveryPhoneAuthorizationDigest(transition))
      const phoneSignature = hex.encode(signDirectP256(directSecret, hex.decode(phoneDigest)))
      recovery.attachLedgerRecoveryPhoneProof(transition, userPsbt, phoneSignature)
      records.push({
        ...transition,
        unsignedPsbt,
        userPsbt,
        phoneDigest,
        phoneSignature,
        vsize: recovery.inspectLedgerRecoveryTransition(transition).vsize,
      })
    }
    phone.wipePrivateData()
  }
  directSecret.fill(0)
  const path = new URL('../../src/lib/vault/program/ledger-recovery-vectors.json', import.meta.url)
  writeFileSync(
    path,
    await format(JSON.stringify(records), { ...(await resolveConfig(fileURLToPath(path))), parser: 'json' }),
  )
  console.log('Generated', records.length, 'Ledger recovery authorization vectors')
} finally {
  await vite.close()
}
