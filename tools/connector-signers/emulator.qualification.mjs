import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'

// This qualification accepts only an isolated local emulator with public
// fixture key 15. It cannot contact a production signing service.
const origin = new URL(process.env.CONNECTOR_EMULATOR_ORIGIN || 'http://invalid')
assert.equal(origin.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'isolated loopback emulator required')
assert.equal(origin.username + origin.password + origin.search + origin.hash, '')
assert.equal(origin.pathname, '/')
const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())
const { prepareConnectorPayment } = await vite.ssrLoadModule('/src/lib/vault/program/connectorPayment.ts')
const { buildConnectorFamily } = await vite.ssrLoadModule('/src/lib/vault/program/connector.ts')
const { defaultSpendingPolicy } = await vite.ssrLoadModule('/src/lib/vault/spendingPolicy.ts')
const vectors = JSON.parse(
  await readFile(new URL('../../src/lib/vault/program/connector-vectors.json', import.meta.url), 'utf8'),
)
const info = await fetch(new URL('/v1/info', origin), { redirect: 'error', signal: AbortSignal.timeout(15000) })
assert.equal(info.status, 200)
const identity = await info.json()
assert.equal(identity.version, 'v0.0.7')
assert.equal(identity.signerPubkey, vectors[0].emulator)
const options = { version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true }
async function submit(tx) {
  return fetch(new URL('/v1/onchain-tx', origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: base64.encode(tx.toPSBT()) }),
  })
}

for (const v of vectors.filter((v) => v.network === 'mainnet')) {
  for (const p of v.payments) {
    test(`upstream emulator HTTP ${v.originType} ${v.tier} ${p.full ? 'full' : 'partial'}`, async () => {
      const policy = defaultSpendingPolicy(v.network)
      const contract = {
        vaultId: 'connector-family-fixture',
        network: v.network,
        connectorType: v.connectorType,
        phonePub: v.phone,
        hardwarePub: v.hardware,
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
      const prepared = prepareConnectorPayment({
        contract,
        origin: { publicKey: hex.decode(v.hardware), fingerprint: v.originFingerprint, path: v.originPath },
        enrollmentDigest: v.enrollmentDigest,
        savings: { txid: p.parentTxid, vout: 0, parentHex: p.parent },
        reserve: { txid: p.parentTxid, vout: 1, parentHex: p.parent },
        recipient: Address().encode(OutScript.decode(hex.decode(p.recipientScript))),
        amountSats: p.amount,
        feeSats: p.fee,
      })
      const phoneKey = new Uint8Array(32)
      phoneKey[31] = 3
      const tx = Transaction.fromPSBT(hex.decode(prepared.signPhone(phoneKey)), options)
      assert.ok(family.savings.normal.length < 253)
      const leafHash = schnorr.utils.taggedHash(
        'TapLeaf',
        Uint8Array.of(0xc0, family.savings.normal.length),
        family.savings.normal,
      )
      const phone = hex.decode(v.phone).slice(1)
      const guardian = hex.decode(family.normalTweaks.vault).slice(1)
      const emulator = hex.decode(family.normalTweaks.arkade).slice(1)
      const earlier = [
        [{ pubKey: phone, leafHash }, tx.getInput(0).tapScriptSig[0][1]],
        [{ pubKey: guardian, leafHash }, hex.decode(p.savingsWitness[1])],
      ]
      tx.updateInput(0, { tapScriptSig: earlier })
      const response = await submit(tx)
      assert.equal(response.status, 200, await response.clone().text())
      const signed = Transaction.fromPSBT(base64.decode((await response.json()).signedTx), options)
      assert.equal(hex.encode(signed.unsignedTx), hex.encode(tx.unsignedTx))
      const signatures = signed.getInput(0).tapScriptSig
      assert.equal(signatures.length, 3)
      for (const [key, sig] of earlier) {
        const returned = signatures.find(([k]) => hex.encode(k.pubKey) === hex.encode(key.pubKey))
        assert.equal(hex.encode(returned[1]), hex.encode(sig))
      }
      const added = signatures.filter(([k]) => hex.encode(k.pubKey) === hex.encode(emulator))
      assert.equal(added.length, 1)
      assert.equal(hex.encode(added[0][0].leafHash), hex.encode(leafHash))
      assert.equal(added[0][1].length, 64)
      assert.equal(signed.getInput(1).tapKeySig, undefined)
      assert.equal(signed.getInput(1).partialSig, undefined)
      const handoff = prepared.forHardware([
        added[0][1],
        hex.decode(p.savingsWitness[1]),
        earlier[0][1],
        family.savings.normal,
        family.savings.control,
      ])
      // The fixture signer response supplies only the independently verified H
      // signature; Vaulted retains the Savings witness just obtained upstream.
      assert.equal(handoff.accept(p.responsePSBT).txid, p.txid)

      const bad = Transaction.fromPSBT(hex.decode(prepared.psbt()), options)
      bad.updateOutput(1, { amount: 999n })
      const rejected = await submit(bad)
      assert.notEqual(rejected.status, 200, 'emulator accepted loss of the enrolled reserve')
    })
  }
}
